import { describe, expect, it } from "vitest";
import { isAllowedEmail, isAllowedGoogleUser } from "./domain";

const D = "example.com";

describe("isAllowedEmail", () => {
  it("accetta un'email del dominio, anche in maiuscolo", () => {
    expect(isAllowedEmail("mario.rossi@example.com", D)).toBe(true);
    expect(isAllowedEmail("Mario.Rossi@Example.COM", D)).toBe(true);
    expect(isAllowedEmail("mario@example.com", "Example.com")).toBe(true);
  });

  it("rifiuta domini simili o con suffisso/prefisso", () => {
    expect(isAllowedEmail("x@evil-example.com", D)).toBe(false);
    expect(isAllowedEmail("x@example.com.evil", D)).toBe(false);
    expect(isAllowedEmail("x@sub.example.com", D)).toBe(false);
    expect(isAllowedEmail("x@evilexample.com", D)).toBe(false);
  });

  it("richiede esattamente una @ e una parte locale", () => {
    expect(isAllowedEmail("x@y@example.com", D)).toBe(false);
    expect(isAllowedEmail("example.com", D)).toBe(false);
    expect(isAllowedEmail("@example.com", D)).toBe(false);
  });

  it("rifiuta valori vuoti, spazi e dominio configurato vuoto", () => {
    expect(isAllowedEmail(undefined, D)).toBe(false);
    expect(isAllowedEmail("", D)).toBe(false);
    expect(isAllowedEmail(" x@example.com", D)).toBe(false);
    expect(isAllowedEmail("x @example.com", D)).toBe(false);
    expect(isAllowedEmail("x@", "")).toBe(false);
    expect(isAllowedEmail("x@example.com", "")).toBe(false);
  });
});

function googleUser(over: { email?: string; provider?: unknown; hd?: unknown; noClaims?: boolean } = {}) {
  return {
    email: "email" in over ? over.email : "mario@example.com",
    app_metadata: { provider: "provider" in over ? over.provider : "google" },
    user_metadata: over.noClaims ? {} : { custom_claims: { hd: "hd" in over ? over.hd : "example.com" } },
  };
}

describe("isAllowedGoogleUser", () => {
  it("accetta un utente Google del dominio con claim hd corretto", () => {
    expect(isAllowedGoogleUser(googleUser(), D)).toBe(true);
  });

  it("rifiuta provider diverso da google", () => {
    expect(isAllowedGoogleUser(googleUser({ provider: "email" }), D)).toBe(false);
    expect(isAllowedGoogleUser(googleUser({ provider: undefined }), D)).toBe(false);
  });

  it("rifiuta claim hd mancante o diverso", () => {
    expect(isAllowedGoogleUser(googleUser({ noClaims: true }), D)).toBe(false);
    expect(isAllowedGoogleUser(googleUser({ hd: undefined }), D)).toBe(false);
    expect(isAllowedGoogleUser(googleUser({ hd: "" }), D)).toBe(false);
    expect(isAllowedGoogleUser(googleUser({ hd: "evil-example.com" }), D)).toBe(false);
    expect(isAllowedGoogleUser(googleUser({ hd: "sub.example.com" }), D)).toBe(false);
    expect(isAllowedGoogleUser(googleUser({ hd: ["example.com"] }), D)).toBe(false);
  });

  it("rifiuta email fuori dominio anche con hd corretto", () => {
    expect(isAllowedGoogleUser(googleUser({ email: "mario@gmail.com" }), D)).toBe(false);
    expect(isAllowedGoogleUser(googleUser({ email: undefined }), D)).toBe(false);
  });

  it("rifiuta metadata assenti", () => {
    expect(isAllowedGoogleUser({ email: "mario@example.com" }, D)).toBe(false);
  });
});
