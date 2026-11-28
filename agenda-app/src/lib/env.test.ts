import { afterEach, describe, expect, it, vi } from "vitest";
import { serverEnv } from "./env";

const FULL = {
  ANTHROPIC_API_KEY: "sk-ant-test",
  N8N_BASE_URL: "https://n8n.example.com",
  N8N_WEBHOOK_SECRET: "segreto",
  SUPABASE_SERVICE_ROLE_KEY: "service-role",
  ALLOWED_DOMAIN: "example.com",
};

describe("serverEnv", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("restituisce i valori quando sono tutte presenti", () => {
    for (const [k, v] of Object.entries(FULL)) vi.stubEnv(k, v);
    expect(serverEnv()).toEqual(FULL);
  });

  it("lancia citando N8N_WEBHOOK_SECRET se manca", () => {
    for (const [k, v] of Object.entries(FULL)) vi.stubEnv(k, v);
    vi.stubEnv("N8N_WEBHOOK_SECRET", "");
    expect(() => serverEnv()).toThrow(/N8N_WEBHOOK_SECRET/);
  });
});
