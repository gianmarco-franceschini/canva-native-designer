import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { signRequest } from "./sign";

// Controlli sui workflow n8n esportati in agenda-app/n8n/ (nessuna istanza n8n coinvolta):
// struttura, contratto con client.ts, credenziali e logica dei Code node eseguita in locale.

const require = createRequire(import.meta.url);
const N8N_DIR = join(__dirname, "../../../n8n");

type N8nNode = {
  name: string;
  type: string;
  parameters: Record<string, unknown> & { jsCode?: string };
  credentials?: Record<string, unknown>;
};
type Workflow = {
  name: string;
  active: boolean;
  nodes: N8nNode[];
  connections: Record<string, { main: { node: string }[][] }>;
};

const load = (file: string): Workflow => JSON.parse(readFileSync(join(N8N_DIR, file), "utf8"));

// Percorsi usati da client.ts (`/webhook/<path>`).
const clientSrc = readFileSync(join(__dirname, "client.ts"), "utf8");
const clientPaths = [...clientSrc.matchAll(/"\/webhook\/([a-z-]+)"/g)].map((m) => m[1]);

const files = {
  "agenda-freebusy": "agenda-freebusy.json",
  "agenda-create-event": "agenda-create-event.json",
  "agenda-cancel-event": "agenda-cancel-event.json",
} as const;

const verifySrc = readFileSync(join(N8N_DIR, "verify-signature.js"), "utf8");
const verifyFn = verifySrc
  .split("// BEGIN verifyAgendaSignature\n")[1]
  .split("// END verifyAgendaSignature")[0]
  .trimEnd();

const nodeByName = (wf: Workflow, name: string) => {
  const n = wf.nodes.find((x) => x.name === name);
  if (!n) throw new Error(`nodo ${name} mancante in ${wf.name}`);
  return n;
};

// ------------------------------------------------------------- esecuzione Code node

type RunCtx = {
  input: { json: unknown; binary?: Record<string, { data: string; mimeType?: string }> };
  nodes?: Record<string, unknown>;
  vars?: Record<string, string>;
};

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<{ json: Record<string, unknown> }[]>;

async function runCode(code: string, ctx: RunCtx): Promise<Record<string, unknown>> {
  const fn = new AsyncFunction("$input", "$", "$vars", "require", "Buffer", code);
  const helpers = {
    getBinaryDataBuffer: async (_i: number, prop: string) =>
      Buffer.from(ctx.input.binary?.[prop]?.data ?? "", "base64"),
  };
  const $input = { first: () => ctx.input, all: () => [ctx.input] };
  const $ = (name: string) => {
    if (!ctx.nodes || !(name in ctx.nodes)) throw new Error(`nodo ${name} non simulato`);
    return { first: () => ({ json: ctx.nodes![name] }) };
  };
  const out = await fn.call({ helpers }, $input, $, ctx.vars ?? {}, require, Buffer);
  expect(out).toHaveLength(1);
  return out[0].json;
}

const codeOf = (wf: Workflow, name: string) => {
  const code = nodeByName(wf, name).parameters.jsCode;
  if (typeof code !== "string") throw new Error(`${name} non è un Code node`);
  return code;
};

const secret = "test-secret";

function webhookItem(payload: unknown, opts: { ts?: number; sig?: string; raw?: string } = {}) {
  const raw = opts.raw ?? JSON.stringify(payload);
  const ts = opts.ts ?? Date.now();
  const sig = opts.sig ?? signRequest(raw, secret, ts);
  return {
    json: { headers: { "x-timestamp": String(ts), "x-signature": sig }, body: payload },
    binary: { data: { data: Buffer.from(raw, "utf8").toString("base64"), mimeType: "application/json" } },
  };
}

// ------------------------------------------------------------------ struttura

describe.each(Object.entries(files))("workflow %s", (path, file) => {
  const wf = load(file);

  it("il webhook ascolta POST sul percorso usato da client.ts, raw body e risposta da nodo", () => {
    expect(clientPaths).toContain(path);
    const hooks = wf.nodes.filter((n) => n.type === "n8n-nodes-base.webhook");
    expect(hooks).toHaveLength(1);
    expect(hooks[0].parameters).toMatchObject({
      httpMethod: "POST",
      path,
      responseMode: "responseNode",
      options: { rawBody: true },
    });
  });

  it("è importato disattivato", () => {
    expect(wf.active).toBe(false);
  });

  it("il primo nodo dopo il webhook è il Code node di verifica firma, con la funzione di verify-signature.js", () => {
    const hook = wf.nodes.find((n) => n.type === "n8n-nodes-base.webhook")!;
    const next = wf.connections[hook.name].main[0];
    expect(next).toHaveLength(1);
    const first = nodeByName(wf, next[0].node);
    expect(first.name).toBe("Verifica firma");
    expect(first.type).toBe("n8n-nodes-base.code");
    expect(first.parameters.jsCode).toContain(verifyFn);
    expect(first.parameters.jsCode).toContain("$vars.AGENDA_WEBHOOK_SECRET");
  });

  it("firma non valida → Rispondi 401 con {error:\"unauthorized\"}", () => {
    const gate = wf.connections["Verifica firma"].main[0][0].node;
    expect(nodeByName(wf, gate).type).toBe("n8n-nodes-base.if");
    expect(wf.connections[gate].main[1]).toEqual([expect.objectContaining({ node: "Rispondi 401" })]);
    const r = nodeByName(wf, "Rispondi 401");
    expect(r.type).toBe("n8n-nodes-base.respondToWebhook");
    expect(JSON.parse(r.parameters.responseBody as string)).toEqual({ error: "unauthorized" });
    expect((r.parameters.options as { responseCode: number }).responseCode).toBe(401);
  });

  it("credenziali: solo il riferimento per nome 'Google Calendar agenda@', nessun id o segreto", () => {
    for (const n of wf.nodes) {
      if (!n.credentials) continue;
      expect(n.credentials).toEqual({ googleCalendarOAuth2Api: { name: "Google Calendar agenda@" } });
    }
    expect(wf.nodes.some((n) => n.credentials)).toBe(true);
    const text = JSON.stringify(wf);
    expect(text).not.toMatch(/access_token|refresh_token|client_secret|"password"|Bearer /i);
  });

  it("ogni ramo termina in un nodo Respond to Webhook e ogni nodo è raggiungibile", () => {
    const reached = new Set<string>();
    const visit = (name: string) => {
      if (reached.has(name)) return;
      reached.add(name);
      const node = nodeByName(wf, name);
      const outs = wf.connections[name]?.main ?? [];
      if (node.type === "n8n-nodes-base.respondToWebhook") {
        expect(outs).toHaveLength(0);
        return;
      }
      const expectedOutputs = node.type === "n8n-nodes-base.if" ? 2 : 1;
      expect(outs, `uscite di ${name}`).toHaveLength(expectedOutputs);
      for (const out of outs) {
        expect(out.length, `uscita vuota in ${name}`).toBeGreaterThan(0);
        out.forEach((c) => visit(c.node));
      }
    };
    visit("Webhook");
    expect([...reached].sort()).toEqual(wf.nodes.map((n) => n.name).sort());
  });

  it("verifica firma: accetta richieste firmate, rifiuta alterate, scadute e future", async () => {
    const code = codeOf(wf, "Verifica firma");
    const vars = { AGENDA_WEBHOOK_SECRET: secret };
    const payload = { a: 1 };
    const ok = await runCode(code, { input: webhookItem(payload), vars });
    expect(ok).toEqual({ authorized: true, body: payload });

    const raw = JSON.stringify(payload);
    const ts = Date.now();
    const sig = signRequest(raw, secret, ts);
    const cases = [
      webhookItem(payload, { raw: '{"a":2}', sig, ts }),
      webhookItem(payload, { ts: Date.now() - 300_500 }),
      webhookItem(payload, { ts: Date.now() + 300_500 }),
      webhookItem(payload, { sig: "00".repeat(32) }),
    ];
    for (const input of cases) {
      expect(await runCode(code, { input, vars })).toEqual({ authorized: false, body: null });
    }
    // Senza secret configurato nessuna richiesta passa.
    expect(await runCode(code, { input: webhookItem(payload), vars: {} })).toMatchObject({ authorized: false });
  });
});

// ------------------------------------------------------------------ freebusy

describe("agenda-freebusy: logica", () => {
  const wf = load(files["agenda-freebusy"]);

  it("valida input: max 15 email e 14 giorni, normalizza le email", async () => {
    const code = codeOf(wf, "Valida input");
    const run = (body: unknown) => runCode(code, { input: { json: { body } } });
    const ok = await run({
      emails: [" A@x.it ", "a@x.it", "b@x.it"],
      timeMin: "2026-12-01T08:00:00.000Z",
      timeMax: "2026-12-02T08:00:00.000Z",
    });
    expect(ok).toMatchObject({ ok: true, emails: ["a@x.it", "b@x.it"] });

    const many = Array.from({ length: 16 }, (_, i) => `u${i}@x.it`);
    for (const bad of [
      null,
      { emails: many, timeMin: "2026-12-01T08:00:00Z", timeMax: "2026-12-02T08:00:00Z" },
      { emails: [], timeMin: "2026-12-01T08:00:00Z", timeMax: "2026-12-02T08:00:00Z" },
      { emails: ["non-email"], timeMin: "2026-12-01T08:00:00Z", timeMax: "2026-12-02T08:00:00Z" },
      { emails: ["a@x.it"], timeMin: "2026-12-01T08:00:00Z", timeMax: "2026-12-16T08:00:01Z" },
      { emails: ["a@x.it"], timeMin: "2026-12-02T08:00:00Z", timeMax: "2026-12-01T08:00:00Z" },
      { emails: ["a@x.it"], timeMin: "x", timeMax: "2026-12-01T08:00:00Z" },
    ]) {
      expect(await run(bad)).toMatchObject({ ok: false, statusCode: 400, body: { error: "invalid_input" } });
    }
  });

  it("risposta: solo intervalli busy, calendari illeggibili con error, nessun dettaglio evento", async () => {
    const code = codeOf(wf, "Prepara risposta");
    const out = await runCode(code, {
      input: {
        json: {
          statusCode: 200,
          body: {
            kind: "calendar#freeBusy",
            calendars: {
              "A@x.it": {
                busy: [{ start: "2026-12-01T09:00:00Z", end: "2026-12-01T10:00:00Z", summary: "Segreto" }],
              },
              "b@x.it": { busy: [] },
              "c@x.it": { errors: [{ domain: "global", reason: "notFound" }], busy: [] },
            },
          },
        },
      },
      nodes: { "Valida input": { emails: ["a@x.it", "b@x.it", "c@x.it", "d@x.it"] } },
    });
    expect(out).toEqual({
      respond: true,
      statusCode: 200,
      body: {
        calendars: {
          "a@x.it": { busy: [{ start: "2026-12-01T09:00:00Z", end: "2026-12-01T10:00:00Z" }] },
          "b@x.it": { busy: [] },
          "c@x.it": { error: "notFound" },
          "d@x.it": { error: "notFound" },
        },
      },
    });
    expect(JSON.stringify(out)).not.toContain("Segreto");
  });

  it("errore di Google → 502", async () => {
    const code = codeOf(wf, "Prepara risposta");
    for (const json of [{ statusCode: 500, body: {} }, { error: { message: "ECONNRESET" } }]) {
      expect(await runCode(code, { input: { json }, nodes: { "Valida input": { emails: ["a@x.it"] } } })).toEqual({
        respond: true,
        statusCode: 502,
        body: { error: "calendar_error" },
      });
    }
  });
});

// --------------------------------------------------------------- create-event

describe("agenda-create-event: logica", () => {
  const wf = load(files["agenda-create-event"]);
  const vars = { AGENDA_SHARED_CALENDAR_ID: "shared@group.calendar.google.com" };
  const input = {
    requestId: "8d0f3c1e-1111-4222-8333-944455556666",
    title: " Riunione ",
    description: "Ordine del giorno",
    start: "2026-12-01T09:00:00.000Z",
    end: "2026-12-01T10:00:00.000Z",
    organizerEmail: "Org@x.it",
    attendeeEmails: ["a@x.it", "org@x.it", "b@x.it"],
    allowConflict: false,
  };

  async function validated(overrides: Record<string, unknown> = {}) {
    return runCode(codeOf(wf, "Valida input"), { input: { json: { body: { ...input, ...overrides } } }, vars });
  }

  it("valida input: invitati = organizzatore + partecipanti senza duplicati", async () => {
    expect(await validated()).toEqual({
      ok: true,
      calendarId: vars.AGENDA_SHARED_CALENDAR_ID,
      requestId: input.requestId,
      title: "Riunione",
      description: "Ordine del giorno",
      start: input.start,
      end: input.end,
      organizerEmail: "org@x.it",
      attendees: ["org@x.it", "a@x.it", "b@x.it"],
      allowConflict: false,
    });
    for (const bad of [
      { requestId: "" },
      { requestId: "a b" },
      { title: "  " },
      { title: "x".repeat(201) },
      { description: null },
      { end: input.start },
      { end: "2026-12-01T17:00:01.000Z" },
      { organizerEmail: "nope" },
      { attendeeEmails: [] },
      { attendeeEmails: Array.from({ length: 15 }, (_, i) => `u${i}@x.it`) },
      { allowConflict: "false" },
    ]) {
      expect(await validated(bad)).toMatchObject({ ok: false, statusCode: 400 });
    }
    const noCal = await runCode(codeOf(wf, "Valida input"), { input: { json: { body: input } }, vars: {} });
    expect(noCal).toMatchObject({ ok: false, statusCode: 500, body: { error: "misconfigured" } });
  });

  it("idempotenza: un evento esistente con lo stesso agendaRequestId viene restituito", async () => {
    const v = await validated();
    const code = codeOf(wf, "Evento già creato?");
    const found = await runCode(code, {
      input: {
        json: {
          statusCode: 200,
          body: {
            items: [
              {
                id: "evt1",
                htmlLink: "https://calendar.google.com/event?eid=1",
                summary: "Riunione",
                extendedProperties: { private: { agendaRequestId: input.requestId } },
              },
            ],
          },
        },
      },
      nodes: { "Valida input": v },
    });
    expect(found).toEqual({
      respond: true,
      statusCode: 200,
      body: { status: "created", eventId: "evt1", htmlLink: "https://calendar.google.com/event?eid=1" },
    });

    const none = await runCode(code, {
      input: { json: { statusCode: 200, body: { items: [] } } },
      nodes: { "Valida input": v },
    });
    expect(none).toEqual({ respond: false, emails: v.attendees, timeMin: input.start, timeMax: input.end });
  });

  it("la ricerca usa privateExtendedProperty=agendaRequestId=<requestId> sul calendario condiviso", () => {
    const n = nodeByName(wf, "Cerca evento esistente");
    expect(n.parameters.url).toContain("/calendars/{{ encodeURIComponent($('Valida input').first().json.calendarId) }}/events");
    expect(JSON.stringify(n.parameters.queryParameters)).toContain(
      '"name":"privateExtendedProperty","value":"=agendaRequestId={{ $json.requestId }}"',
    );
    const create = nodeByName(wf, "Crea evento");
    expect(create.parameters.method).toBe("POST");
    expect(JSON.stringify(create.parameters.queryParameters)).toContain('"name":"sendUpdates","value":"all"');
  });

  async function conflicts(calendars: Record<string, unknown>, allowConflict = false) {
    const v = { ...(await validated()), allowConflict };
    return runCode(codeOf(wf, "Valuta conflitti"), {
      input: { json: { statusCode: 200, body: { calendars } } },
      nodes: { "Valida input": v },
    });
  }

  it("conflitto con allowConflict=false → {status:'conflict', busy} senza dettagli", async () => {
    const out = await conflicts({
      "org@x.it": { busy: [] },
      "a@x.it": {
        busy: [
          { start: "2026-12-01T09:30:00Z", end: "2026-12-01T09:45:00Z" },
          { start: "2026-12-01T10:00:00Z", end: "2026-12-01T11:00:00Z" }, // adiacente: non è conflitto
        ],
      },
      "b@x.it": { errors: [{ reason: "notFound" }] },
    });
    expect(out).toEqual({
      respond: true,
      statusCode: 200,
      body: {
        status: "conflict",
        busy: {
          "a@x.it": [{ start: "2026-12-01T09:30:00Z", end: "2026-12-01T09:45:00Z" }],
          // calendario illeggibile = occupato per tutto l'intervallo
          "b@x.it": [{ start: input.start, end: input.end }],
        },
      },
    });
  });

  it("nessun conflitto (o allowConflict=true) → corpo evento per Google", async () => {
    const free = { "org@x.it": { busy: [] }, "a@x.it": { busy: [] }, "b@x.it": { busy: [] } };
    for (const out of [
      await conflicts(free),
      await conflicts({ ...free, "a@x.it": { busy: [{ start: input.start, end: input.end }] } }, true),
    ]) {
      expect(out).toEqual({
        respond: false,
        eventBody: {
          summary: "Riunione",
          description: "Ordine del giorno\n\nCreato da org@x.it tramite Agenda aziendale",
          start: { dateTime: input.start, timeZone: "Europe/Rome" },
          end: { dateTime: input.end, timeZone: "Europe/Rome" },
          attendees: [{ email: "org@x.it" }, { email: "a@x.it" }, { email: "b@x.it" }],
          extendedProperties: { private: { agendaRequestId: input.requestId } },
        },
      });
    }
  });

  it("risposta di creazione: solo eventId e htmlLink", async () => {
    const code = codeOf(wf, "Prepara risposta");
    const out = await runCode(code, {
      input: { json: { statusCode: 200, body: { id: "evt9", htmlLink: "https://x/e", summary: "Riunione" } } },
    });
    expect(out).toEqual({ respond: true, statusCode: 200, body: { status: "created", eventId: "evt9", htmlLink: "https://x/e" } });
    expect(await runCode(code, { input: { json: { statusCode: 403, body: {} } } })).toMatchObject({ statusCode: 502 });
  });
});

// --------------------------------------------------------------- cancel-event

describe("agenda-cancel-event: logica", () => {
  const wf = load(files["agenda-cancel-event"]);
  const v = { ok: true, calendarId: "shared@x", requestId: "req-1", googleEventId: "evt1" };

  const check = (json: unknown) => runCode(codeOf(wf, "Controlla evento"), { input: { json }, nodes: { "Valida input": v } });
  const own = { extendedProperties: { private: { agendaRequestId: "req-1" } } };

  it("valida input", async () => {
    const code = codeOf(wf, "Valida input");
    const vars = { AGENDA_SHARED_CALENDAR_ID: "shared@x" };
    expect(await runCode(code, { input: { json: { body: { requestId: "req-1", googleEventId: "evt1" } } }, vars })).toEqual(v);
    for (const body of [{ requestId: "req-1" }, { requestId: "req-1", googleEventId: "../x" }, { googleEventId: "evt1" }]) {
      expect(await runCode(code, { input: { json: { body } }, vars })).toMatchObject({ ok: false, statusCode: 400 });
    }
  });

  it("evento già eliminato (404/410 o status cancelled) → cancelled", async () => {
    const cancelled = { respond: true, statusCode: 200, body: { status: "cancelled" } };
    expect(await check({ statusCode: 404, body: {} })).toEqual(cancelled);
    expect(await check({ statusCode: 410, body: {} })).toEqual(cancelled);
    expect(await check({ statusCode: 200, body: { ...own, status: "cancelled" } })).toEqual(cancelled);
  });

  it("evento di un'altra richiesta → 403 forbidden", async () => {
    const forbidden = { respond: true, statusCode: 403, body: { error: "forbidden" } };
    expect(
      await check({ statusCode: 200, body: { status: "confirmed", extendedProperties: { private: { agendaRequestId: "req-2" } } } }),
    ).toEqual(forbidden);
    expect(await check({ statusCode: 200, body: { status: "confirmed" } })).toEqual(forbidden);
  });

  it("evento proprio → prosegue con la cancellazione; errori Google → 502", async () => {
    expect(await check({ statusCode: 200, body: { ...own, status: "confirmed" } })).toEqual({ respond: false });
    expect(await check({ statusCode: 500, body: {} })).toMatchObject({ statusCode: 502 });
    expect(await check({ error: { message: "timeout" } })).toMatchObject({ statusCode: 502 });
  });

  it("delete con sendUpdates=all; 204/404/410 → cancelled, altro → 502", async () => {
    const del = nodeByName(wf, "Elimina evento");
    expect(del.parameters.method).toBe("DELETE");
    expect(JSON.stringify(del.parameters.queryParameters)).toContain('"name":"sendUpdates","value":"all"');
    const code = codeOf(wf, "Prepara risposta");
    for (const statusCode of [204, 404, 410]) {
      expect(await runCode(code, { input: { json: { statusCode, body: "" } } })).toEqual({
        respond: true,
        statusCode: 200,
        body: { status: "cancelled" },
      });
    }
    expect(await runCode(code, { input: { json: { statusCode: 403, body: {} } } })).toMatchObject({ statusCode: 502 });
  });
});
