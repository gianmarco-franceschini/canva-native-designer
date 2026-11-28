import { simulateReadableStream } from "ai";
import { MockLanguageModelV2 } from "ai/test";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_MESSAGE_ACTION, ConversationNotFoundError, type AuditEntry, type Repo } from "@/lib/db/repo";
import { DEFAULT_WORK_HOURS } from "@/lib/scheduling/types";

const m = vi.hoisted(() => ({
  user: null as unknown,
  deps: null as unknown,
  model: null as unknown,
}));

vi.mock("@/lib/auth/session", () => ({ getApiUser: async () => m.user }));
vi.mock("@/lib/requests/deps", () => ({ createRequestDeps: async () => m.deps }));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ ANTHROPIC_API_KEY: "test" }) }));
// Nessuna chiamata ad Anthropic: il provider restituisce un modello finto.
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: () => () => m.model }));

const { POST } = await import("./route");

const CONV = "0b9f7a52-5a0c-4a43-9a43-2f6f3c1b1e01";
const NEW_CONV = "5d7c0c3e-1f2a-4b3c-8d4e-9f0a1b2c3d4e";
const user = { id: "u1", email: "anna@example.com", fullName: "Anna Rossi", role: "user" };
const NOW = new Date("2026-11-26T08:00:00Z");

function makeRepo(count: number) {
  return {
    listColleagues: vi.fn(async () => []),
    getSettings: vi.fn(async () => ({ workHours: DEFAULT_WORK_HOURS, closures: [] })),
    insertRequest: vi.fn(),
    getRequest: vi.fn(),
    transitionRequest: vi.fn(),
    createConversation: vi.fn(async (userId: string, title: string | null) => ({
      id: NEW_CONV,
      userId,
      title,
      createdAt: NOW,
    })),
    appendMessage: vi.fn(async (_u: string, conversationId: string) => {
      if (conversationId !== CONV && conversationId !== NEW_CONV) {
        throw new ConversationNotFoundError();
      }
    }),
    countUserMessagesSince: vi.fn(async () => count),
    audit: vi.fn<(entry: AuditEntry) => Promise<void>>(async () => {}),
  } satisfies Repo;
}
let repo: ReturnType<typeof makeRepo>;

function textModel(text: string) {
  return new MockLanguageModelV2({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start" as const, id: "t1" },
          { type: "text-delta" as const, id: "t1", delta: text },
          { type: "text-end" as const, id: "t1" },
          {
            type: "finish" as const,
            finishReason: "stop" as const,
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ],
      }),
    }),
  });
}

const userMsg = (text: string, id = "m1") => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});

function req({
  origin = "https://agenda.example.com",
  body = { messages: [userMsg("Riunione domani con Giulia")] } as unknown,
  headers = {} as Record<string, string>,
} = {}) {
  const h: Record<string, string> = {
    host: "agenda.example.com",
    "content-type": "application/json",
    ...headers,
  };
  if (origin) h.origin = origin;
  return new NextRequest("https://agenda.example.com/api/chat", {
    method: "POST",
    headers: h,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const chatAudits = () =>
  repo.audit.mock.calls.filter(([e]) => e.action === CHAT_MESSAGE_ACTION);

beforeEach(() => {
  m.user = user;
  repo = makeRepo(0);
  m.deps = { repo, n8n: {}, now: () => NOW };
  m.model = textModel("Certo, controllo subito.");
});

describe("POST /api/chat", () => {
  it("senza sessione → 401, nessun accesso al db", async () => {
    m.user = null;
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(repo.countUserMessagesSince).not.toHaveBeenCalled();
  });

  it("Origin estraneo → 403", async () => {
    const res = await POST(req({ origin: "https://evil.example.net" }));
    expect(res.status).toBe(403);
    expect(repo.audit).not.toHaveBeenCalled();
  });

  it.each([
    ["non JSON", "{"],
    ["ultimo messaggio non dell'utente", { messages: [{ id: "a", role: "assistant", parts: [] }] }],
    ["messaggio oltre 4000 caratteri", { messages: [userMsg("x".repeat(4001))] }],
  ])("corpo %s → 400", async (_n, body) => {
    const res = await POST(req({ body }));
    expect(res.status).toBe(400);
    expect(repo.audit).not.toHaveBeenCalled();
  });

  it("content-length eccessivo → 413 senza leggere il corpo", async () => {
    const res = await POST(req({ headers: { "content-length": String(10_000_000) } }));
    expect(res.status).toBe(413);
    expect(repo.countUserMessagesSince).not.toHaveBeenCalled();
  });

  it("30 messaggi negli ultimi 10 minuti → 429 con messaggio esatto, niente audit né salvataggio", async () => {
    repo = makeRepo(30);
    m.deps = { repo, n8n: {}, now: () => NOW };
    const res = await POST(req());
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "Troppi messaggi, riprova tra qualche minuto." });
    expect(repo.countUserMessagesSince).toHaveBeenCalledWith(
      "u1",
      new Date(NOW.getTime() - 10 * 60 * 1000),
    );
    expect(repo.audit).not.toHaveBeenCalled();
    expect(repo.appendMessage).not.toHaveBeenCalled();
    expect(repo.createConversation).not.toHaveBeenCalled();
  });

  it("29 messaggi → 200: nuova conversazione, una riga di audit, messaggi salvati", async () => {
    repo = makeRepo(29);
    m.deps = { repo, n8n: {}, now: () => NOW };
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Conversation-Id")).toBe(NEW_CONV);
    const stream = await res.text(); // consuma il flusso: onFinish salva la risposta
    expect(stream).toContain("Certo, controllo subito.");

    expect(repo.createConversation).toHaveBeenCalledWith("u1", "Riunione domani con Giulia");
    expect(chatAudits()).toHaveLength(1);
    expect(chatAudits()[0][0]).toMatchObject({
      actorId: "u1",
      actorEmail: "anna@example.com",
      action: CHAT_MESSAGE_ACTION,
      targetType: "conversation",
      targetId: NEW_CONV,
    });
    expect(repo.appendMessage).toHaveBeenCalledWith("u1", NEW_CONV, "user", userMsg("Riunione domani con Giulia"));
    await vi.waitFor(() =>
      expect(repo.appendMessage).toHaveBeenCalledWith(
        "u1",
        NEW_CONV,
        "assistant",
        expect.objectContaining({ role: "assistant" }),
      ),
    );
  });

  it("conversazione esistente: riusata, senza crearne un'altra", async () => {
    const res = await POST(req({ body: { conversationId: CONV, messages: [userMsg("ciao")] } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Conversation-Id")).toBe(CONV);
    await res.text();
    expect(repo.createConversation).not.toHaveBeenCalled();
    expect(chatAudits()).toHaveLength(1);
  });

  it("conversationId altrui → 404, niente audit né modello", async () => {
    const model = textModel("x");
    m.model = model;
    const res = await POST(
      req({
        body: {
          conversationId: "11111111-2222-4333-8444-555555555555",
          messages: [userMsg("ciao")],
        },
      }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Conversazione non trovata." });
    expect(repo.audit).not.toHaveBeenCalled();
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it("al modello arrivano prompt di sistema, strumenti e solo gli ultimi 20 messaggi", async () => {
    const model = textModel("ok");
    m.model = model;
    const messages = Array.from({ length: 31 }, (_, i) =>
      i % 2 === 0
        ? userMsg(`u${i}`, `m${i}`)
        : { id: `m${i}`, role: "assistant", parts: [{ type: "text", text: `a${i}` }] },
    );
    const res = await POST(req({ body: { messages } }));
    await res.text();
    const call = model.doStreamCalls[0];
    const system = call.prompt.filter((p) => p.role === "system");
    const rest = call.prompt.filter((p) => p.role !== "system");
    expect(system).toHaveLength(1);
    expect(String(system[0].content)).toContain("giovedì 26 novembre 2026");
    expect(rest.length).toBeLessThanOrEqual(20);
    expect(call.tools?.map((t) => t.name).sort()).toEqual(
      ["check_availability", "find_free_slots", "list_colleagues", "propose_event"],
    );
  });
});
