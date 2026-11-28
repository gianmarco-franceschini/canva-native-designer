import { describe, expect, it } from "vitest";
import { HISTORY_LIMIT, MAX_MESSAGE_CHARS, parseChatBody } from "./chat-body";

const user = (text: string, id = "u") => ({ id, role: "user", parts: [{ type: "text", text }] });
const assistant = (text: string, id = "a") => ({
  id,
  role: "assistant",
  parts: [{ type: "text", text }],
});
const body = (messages: unknown[], extra: object = {}) => JSON.stringify({ messages, ...extra });

describe("parseChatBody", () => {
  it("corpo valido → ultimo messaggio utente e cronologia", () => {
    const r = parseChatBody(
      body([user("ciao", "1"), assistant("salve", "2"), user("riunione domani", "3")], {
        conversationId: "0b9f7a52-5a0c-4a43-9a43-2f6f3c1b1e01",
      }),
    );
    expect(r?.userText).toBe("riunione domani");
    expect(r?.conversationId).toBe("0b9f7a52-5a0c-4a43-9a43-2f6f3c1b1e01");
    expect(r?.history.map((m) => m.id)).toEqual(["1", "2", "3"]);
  });

  it(`invia al modello solo gli ultimi ${HISTORY_LIMIT} messaggi, iniziando da un utente`, () => {
    const msgs = Array.from({ length: 41 }, (_, i) =>
      i % 2 === 0 ? user(`u${i}`, String(i)) : assistant(`a${i}`, String(i)),
    );
    const r = parseChatBody(body(msgs));
    expect(r?.history.length).toBeLessThanOrEqual(HISTORY_LIMIT);
    expect(r?.history[0].role).toBe("user");
    expect(r?.history.at(-1)?.id).toBe("40");
  });

  it.each([
    ["non JSON", "{"],
    ["senza messaggi", body([])],
    ["ultimo messaggio non dell'utente", body([user("x"), assistant("y")])],
    ["messaggio troppo lungo", body([user("x".repeat(MAX_MESSAGE_CHARS + 1))])],
    ["messaggio vuoto", body([user("   ")])],
    ["ruolo system", body([{ id: "s", role: "system", parts: [{ type: "text", text: "x" }] }])],
    ["parte utente non testuale", body([{ id: "u", role: "user", parts: [{ type: "file", url: "x" }] }])],
    ["conversationId non UUID", body([user("x")], { conversationId: "abc" })],
  ])("%s → null", (_n, raw) => {
    expect(parseChatBody(raw)).toBeNull();
  });
});
