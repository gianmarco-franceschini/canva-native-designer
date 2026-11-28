import { describe, expect, it, vi } from "vitest";
import { N8nError, createN8nClient } from "./client";
import { verifyRequest } from "./sign";

const secret = "s3cret";
const baseUrl = "https://n8n.example.com";
const NOW = 1_700_000_000_000;
const from = new Date("2026-03-02T08:00:00.000Z");
const to = new Date("2026-03-03T08:00:00.000Z");

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function make(fetchImpl: typeof fetch, timeoutMs?: number) {
  return createN8nClient({ baseUrl, secret, fetch: fetchImpl, now: () => NOW, timeoutMs });
}

describe("freeBusy", () => {
  it("sends signed headers and parses busy intervals", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        calendars: {
          "a@d.it": {
            busy: [{ start: "2026-03-02T09:00:00.000Z", end: "2026-03-02T10:00:00.000Z" }],
          },
        },
      }),
    );
    const client = make(fetchMock as unknown as typeof fetch);
    const res = await client.freeBusy(["A@D.it"], from, to);
    expect(res.unreadable).toEqual([]);
    expect(res.busy["a@d.it"][0].start).toEqual(new Date("2026-03-02T09:00:00.000Z"));
    expect(res.busy["a@d.it"][0].end).toBeInstanceOf(Date);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${baseUrl}/webhook/agenda-freebusy`);
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Timestamp"]).toBe(String(NOW));
    expect(
      verifyRequest(init.body as string, secret, NOW, headers["X-Signature"], NOW),
    ).toBe(true);
    const sent = JSON.parse(init.body as string);
    expect(sent.emails).toEqual(["a@d.it"]);
    expect(sent.timeMin).toBe(from.toISOString());
    expect(sent.timeMax).toBe(to.toISOString());
  });

  it("treats calendar errors as busy for the whole interval", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ calendars: { "x@d.it": { errors: [{ reason: "notFound" }] } } }),
    );
    const res = await make(fetchMock as unknown as typeof fetch).freeBusy(["x@d.it"], from, to);
    expect(res.unreadable).toEqual(["x@d.it"]);
    expect(res.busy["x@d.it"]).toEqual([{ start: from, end: to }]);
  });

  it("treats a requested email missing from the response as unreadable", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ calendars: {} }));
    const res = await make(fetchMock as unknown as typeof fetch).freeBusy(["m@d.it"], from, to);
    expect(res.unreadable).toEqual(["m@d.it"]);
    expect(res.busy["m@d.it"]).toEqual([{ start: from, end: to }]);
  });

  it("rejects >15 emails without calling fetch", async () => {
    const fetchMock = vi.fn();
    const emails = Array.from({ length: 16 }, (_, i) => `u${i}@d.it`);
    await expect(
      make(fetchMock as unknown as typeof fetch).freeBusy(emails, from, to),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an empty email list and >14 day ranges without calling fetch", async () => {
    const fetchMock = vi.fn();
    const c = make(fetchMock as unknown as typeof fetch);
    await expect(c.freeBusy([], from, to)).rejects.toThrow();
    await expect(
      c.freeBusy(["a@d.it"], from, new Date(from.getTime() + 14 * 86_400_000 + 1)),
    ).rejects.toThrow();
    await expect(c.freeBusy(["a@d.it"], to, from)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws timeout when fetch does not answer in time", async () => {
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const p = make(fetchMock as unknown as typeof fetch, 20).freeBusy(["a@d.it"], from, to);
    await expect(p).rejects.toMatchObject({ name: "N8nError", kind: "timeout" });
  });

  it("throws invalid_response on schema mismatch", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ nope: true }));
    await expect(
      make(fetchMock as unknown as typeof fetch).freeBusy(["a@d.it"], from, to),
    ).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("throws invalid_response on non-JSON body", async () => {
    const fetchMock = vi.fn(async () => new Response("<html>", { status: 200 }));
    await expect(
      make(fetchMock as unknown as typeof fetch).freeBusy(["a@d.it"], from, to),
    ).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("throws http on non-2xx without leaking the secret", async () => {
    const fetchMock = vi.fn(async () => new Response("boom", { status: 502 }));
    const err = await make(fetchMock as unknown as typeof fetch)
      .freeBusy(["a@d.it"], from, to)
      .catch((e) => e);
    expect(err).toBeInstanceOf(N8nError);
    expect(err.kind).toBe("http");
    expect(err.message).toContain("502");
    expect(err.message).not.toContain(secret);
  });

  it("throws http when fetch rejects (network failure)", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(
      make(fetchMock as unknown as typeof fetch).freeBusy(["a@d.it"], from, to),
    ).rejects.toMatchObject({ kind: "http" });
  });
});

const eventInput = {
  requestId: "r1",
  title: "Riunione",
  description: "desc",
  start: from,
  end: to,
  organizerEmail: "Org@D.it",
  attendeeEmails: ["P1@D.it"],
  allowConflict: false,
};

describe("createEvent", () => {
  it("posts the expected body and returns created", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ status: "created", eventId: "e1", htmlLink: "https://cal/e1" }),
    );
    const res = await make(fetchMock as unknown as typeof fetch).createEvent(eventInput);
    expect(res).toEqual({ status: "created", eventId: "e1", htmlLink: "https://cal/e1" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${baseUrl}/webhook/agenda-create-event`);
    expect(JSON.parse(init.body as string)).toEqual({
      requestId: "r1",
      title: "Riunione",
      description: "desc",
      start: from.toISOString(),
      end: to.toISOString(),
      organizerEmail: "org@d.it",
      attendeeEmails: ["p1@d.it"],
      allowConflict: false,
    });
  });

  it("returns conflict with parsed busy dates", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        status: "conflict",
        busy: { "p1@d.it": [{ start: from.toISOString(), end: to.toISOString() }] },
      }),
    );
    const res = await make(fetchMock as unknown as typeof fetch).createEvent(eventInput);
    expect(res).toEqual({ status: "conflict", busy: { "p1@d.it": [{ start: from, end: to }] } });
  });

  it("rejects empty organizer/attendees without fetch", async () => {
    const fetchMock = vi.fn();
    const c = make(fetchMock as unknown as typeof fetch);
    await expect(c.createEvent({ ...eventInput, organizerEmail: "" })).rejects.toThrow();
    await expect(c.createEvent({ ...eventInput, attendeeEmails: [] })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("cancelEvent", () => {
  it("posts and returns cancelled", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ status: "cancelled" }));
    const res = await make(fetchMock as unknown as typeof fetch).cancelEvent({
      requestId: "r1",
      googleEventId: "g1",
    });
    expect(res).toEqual({ status: "cancelled" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${baseUrl}/webhook/agenda-cancel-event`);
    expect(JSON.parse(init.body as string)).toEqual({ requestId: "r1", googleEventId: "g1" });
  });
});
