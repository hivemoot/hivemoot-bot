import { createCipheriv, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveInstallationBYOKConfig } from "./byok.js";

const { mockGet, mockState } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockState: {
    status: "ready" as string,
    errorHandler: null as ((err: Error) => void) | null,
    disconnected: false,
  },
}));

vi.mock("ioredis", () => {
  const MockRedis = class {
    get = mockGet;
    on(event: string, handler: (...args: unknown[]) => void) {
      if (event === "error") mockState.errorHandler = handler as (err: Error) => void;
      return this;
    }
    disconnect() { mockState.disconnected = true; }
    get status() { return mockState.status; }
  };
  return { default: MockRedis, Redis: MockRedis };
});

type EnvelopeOverrides = Partial<{
  ciphertext: string;
  iv: string;
  tag: string;
  keyVersion: string;
  provider: string;
  model: string;
  status: string;
}>;

function encryptPlaintext(
  plaintext: string,
  masterKey: Buffer,
): { ciphertext: string; iv: string; tag: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(plaintext, "utf8")),
    cipher.final(),
  ]);

  return {
    ciphertext: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

function buildEnvelope(
  payload: unknown,
  masterKey: Buffer,
  overrides: EnvelopeOverrides = {},
): string {
  const plaintext =
    typeof payload === "string" ? payload : JSON.stringify(payload);
  const encrypted = encryptPlaintext(plaintext, masterKey);

  return JSON.stringify({
    ciphertext: encrypted.ciphertext,
    iv: encrypted.iv,
    tag: encrypted.tag,
    keyVersion: "v1",
    status: "active",
    ...overrides,
  });
}

function setRedisEnv(
  overrides: Record<string, string | undefined> = {},
): void {
  delete process.env.HIVEMOOT_REDIS_URL;
  delete process.env.BYOK_REDIS_KEY_PREFIX;

  process.env.HIVEMOOT_REDIS_URL = "rediss://redis.example.com:6380";

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function setMasterKeys(value: string | Record<string, string>): void {
  process.env.BYOK_MASTER_KEYS_JSON =
    typeof value === "string" ? value : JSON.stringify(value);
}

function stubRedisGet(value: string | null): void {
  mockGet.mockResolvedValue(value);
}

function stubRedisError(error: Error): void {
  mockGet.mockRejectedValue(error);
}

describe("resolveInstallationBYOKConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    mockGet.mockReset();
    mockState.status = "ready";
    mockState.errorHandler = null;
    mockState.disconnected = false;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns null when HIVEMOOT_REDIS_URL is blank", async () => {
    process.env.HIVEMOOT_REDIS_URL = "   ";

    await expect(resolveInstallationBYOKConfig(1)).resolves.toBeNull();
  });

  it("returns null when HIVEMOOT_REDIS_URL is undefined", async () => {
    delete process.env.HIVEMOOT_REDIS_URL;

    await expect(resolveInstallationBYOKConfig(1)).resolves.toBeNull();
  });

  it("normalizes quoted runtime config and resolves a gemini provider", async () => {
    const masterKey = randomBytes(32);
    setRedisEnv({
      HIVEMOOT_REDIS_URL: " 'rediss://redis.example.com:6380' ",
      BYOK_REDIS_KEY_PREFIX: " 'custom:byok' ",
    });
    setMasterKeys({ v1: masterKey.toString("base64") });

    const envelope = buildEnvelope(
      { apiKey: "sk-byok", provider: "gemini", model: "  gemini-2.0-flash  " },
      masterKey,
    );
    stubRedisGet(envelope);

    const resolved = await resolveInstallationBYOKConfig(99);

    expect(resolved).toEqual({
      apiKey: "sk-byok",
      provider: "google",
      model: "gemini-2.0-flash",
    });
    expect(mockGet).toHaveBeenCalledWith("custom:byok:99");
  });

  it("throws when Redis command fails", async () => {
    setRedisEnv();
    stubRedisError(new Error("ECONNRESET"));

    await expect(resolveInstallationBYOKConfig(2)).rejects.toThrow(
      "BYOK Redis lookup failed for installation 2: ECONNRESET",
    );
  });

  it("recreates client when previous client enters 'end' state", async () => {
    setRedisEnv();
    stubRedisGet(null);
    await resolveInstallationBYOKConfig(1);
    mockState.status = "end";
    stubRedisGet(null);

    await expect(resolveInstallationBYOKConfig(2)).resolves.toBeNull();
    expect(mockState.disconnected).toBe(true);
  });

  it("handles Redis client error events without crashing", async () => {
    setRedisEnv();
    // Force client creation so the error handler is registered
    mockState.status = "end";
    stubRedisGet(null);
    await resolveInstallationBYOKConfig(1);

    expect(mockState.errorHandler).toBeInstanceOf(Function);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockState.errorHandler!(new Error("ECONNRESET"));
    expect(spy).toHaveBeenCalledWith("[byok] Redis client error: ECONNRESET");
    spy.mockRestore();
  });

  it("returns null for revoked BYOK records", async () => {
    setRedisEnv();
    stubRedisGet(
      JSON.stringify({
        ciphertext: "AA==",
        iv: "AA==",
        tag: "AA==",
        keyVersion: "v1",
        status: "revoked",
      }),
    );

    await expect(resolveInstallationBYOKConfig(3)).resolves.toBeNull();
  });

  it("throws for non-active, non-revoked BYOK record status", async () => {
    setRedisEnv();
    stubRedisGet(
      JSON.stringify({
        ciphertext: "AA==",
        iv: "AA==",
        tag: "AA==",
        keyVersion: "v1",
        status: "pending",
      }),
    );

    await expect(resolveInstallationBYOKConfig(3)).rejects.toThrow(
      "BYOK record for installation 3 is not active (status=pending)",
    );
  });

  it("throws when BYOK record status is missing", async () => {
    const masterKey = randomBytes(32);
    setRedisEnv();
    setMasterKeys({ v1: masterKey.toString("base64") });
    const envelope = JSON.parse(
      buildEnvelope({ apiKey: "sk", provider: "openai" }, masterKey),
    ) as Record<string, unknown>;
    delete envelope.status;
    stubRedisGet(JSON.stringify(envelope));

    await expect(resolveInstallationBYOKConfig(3)).rejects.toThrow(
      "BYOK record for installation 3 is not active (status=missing)",
    );
  });

  it("throws when BYOK record status is blank", async () => {
    const masterKey = randomBytes(32);
    setRedisEnv();
    setMasterKeys({ v1: masterKey.toString("base64") });
    stubRedisGet(
      buildEnvelope(
        { apiKey: "sk", provider: "openai" },
        masterKey,
        { status: " " },
      ),
    );

    await expect(resolveInstallationBYOKConfig(3)).rejects.toThrow(
      "BYOK record for installation 3 is not active (status= )",
    );
  });

  it("throws when BYOK master keys are missing", async () => {
    const masterKey = randomBytes(32);
    setRedisEnv();
    delete process.env.BYOK_MASTER_KEYS_JSON;
    stubRedisGet(
      buildEnvelope({ apiKey: "sk", provider: "openai" }, masterKey),
    );

    await expect(resolveInstallationBYOKConfig(4)).rejects.toThrow(
      "BYOK master keys are not configured: set BYOK_MASTER_KEYS_JSON",
    );
  });

  it("throws when BYOK master keys are invalid JSON", async () => {
    const masterKey = randomBytes(32);
    setRedisEnv();
    setMasterKeys("not-json");
    stubRedisGet(
      buildEnvelope({ apiKey: "sk", provider: "openai" }, masterKey),
    );

    await expect(resolveInstallationBYOKConfig(4)).rejects.toThrow(
      "BYOK_MASTER_KEYS_JSON must be valid JSON",
    );
  });

  it("throws when BYOK master keys are not an object", async () => {
    const masterKey = randomBytes(32);
    setRedisEnv();
    setMasterKeys("[]");
    stubRedisGet(
      buildEnvelope({ apiKey: "sk", provider: "openai" }, masterKey),
    );

    await expect(resolveInstallationBYOKConfig(4)).rejects.toThrow(
      "BYOK_MASTER_KEYS_JSON must be a JSON object keyed by keyVersion",
    );
  });

  it("throws when BYOK master key entries are blank", async () => {
    const masterKey = randomBytes(32);
    setRedisEnv();
    setMasterKeys({ v1: "" });
    stubRedisGet(
      buildEnvelope({ apiKey: "sk", provider: "openai" }, masterKey),
    );

    await expect(resolveInstallationBYOKConfig(4)).rejects.toThrow(
      "BYOK_MASTER_KEYS_JSON.v1 must be a non-empty base64 string",
    );
  });

  it("throws when BYOK master key length is invalid", async () => {
    const masterKey = randomBytes(32);
    setRedisEnv();
    setMasterKeys({ v1: randomBytes(16).toString("base64") });
    stubRedisGet(
      buildEnvelope({ apiKey: "sk", provider: "openai" }, masterKey),
    );

    await expect(resolveInstallationBYOKConfig(4)).rejects.toThrow(
      "BYOK_MASTER_KEYS_JSON.v1 must decode to 32 bytes for AES-256-GCM",
    );
  });

  it("throws when BYOK master keys object is empty", async () => {
    const masterKey = randomBytes(32);
    setRedisEnv();
    setMasterKeys({});
    stubRedisGet(
      buildEnvelope({ apiKey: "sk", provider: "openai" }, masterKey),
    );

    await expect(resolveInstallationBYOKConfig(4)).rejects.toThrow(
      "BYOK_MASTER_KEYS_JSON must include at least one key version",
    );
  });

  it("throws when Redis returns an empty string", async () => {
    setRedisEnv();
    stubRedisGet("");

    await expect(resolveInstallationBYOKConfig(5)).rejects.toThrow(
      "BYOK envelope is not valid JSON",
    );
  });

  it("throws when BYOK envelope is not valid JSON", async () => {
    setRedisEnv();
    stubRedisGet("not-json");

    await expect(resolveInstallationBYOKConfig(5)).rejects.toThrow(
      "BYOK envelope is not valid JSON",
    );
  });

  it("throws when BYOK envelope is not an object", async () => {
    setRedisEnv();
    stubRedisGet("[]");

    await expect(resolveInstallationBYOKConfig(5)).rejects.toThrow(
      "BYOK envelope must be a JSON object",
    );
  });

  it("throws when BYOK envelope is missing required fields", async () => {
    setRedisEnv();
    stubRedisGet(
      JSON.stringify({ keyVersion: "v1" }),
    );

    await expect(resolveInstallationBYOKConfig(5)).rejects.toThrow(
      "BYOK envelope is missing required fields",
    );
  });

  it("throws when BYOK envelope fields are invalid base64", async () => {
    const masterKey = randomBytes(32);
    setRedisEnv();
    setMasterKeys({ v1: masterKey.toString("base64") });
    stubRedisGet(
      buildEnvelope(
        { apiKey: "sk", provider: "openai" },
        masterKey,
        { iv: "" },
      ),
    );

    await expect(resolveInstallationBYOKConfig(6)).rejects.toThrow(
      "BYOK envelope field 'iv' is not valid base64",
    );
  });

  it("throws when BYOK envelope IV is not 12 bytes (rejects 16-byte IV)", async () => {
    const masterKey = randomBytes(32);
    setRedisEnv();
    setMasterKeys({ v1: masterKey.toString("base64") });
    const iv16 = randomBytes(16);
    const cipher = createCipheriv("aes-256-gcm" as any, masterKey, iv16);
    const payload = { apiKey: "sk", provider: "openai" };
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(payload), "utf8")),
      cipher.final(),
    ]);
    const envelope = JSON.stringify({
      ciphertext: ciphertext.toString("base64"),
      iv: iv16.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      keyVersion: "v1",
      status: "active",
    });
    stubRedisGet(envelope);

    await expect(resolveInstallationBYOKConfig(6)).rejects.toThrow(
      "BYOK envelope IV must be 12 bytes (96 bits) for AES-256-GCM; got 16",
    );
  });

  it("throws when decrypted payload is not valid JSON", async () => {
    const masterKey = randomBytes(32);
    setRedisEnv();
    setMasterKeys({ v1: masterKey.toString("base64") });
    stubRedisGet(
      buildEnvelope("not-json", masterKey),
    );

    await expect(resolveInstallationBYOKConfig(7)).rejects.toThrow(
      "BYOK decrypted payload is not valid JSON",
    );
  });

  it("throws when decrypted payload is not an object", async () => {
    const masterKey = randomBytes(32);
    setRedisEnv();
    setMasterKeys({ v1: masterKey.toString("base64") });
    stubRedisGet(
      buildEnvelope(JSON.stringify("string-payload"), masterKey),
    );

    await expect(resolveInstallationBYOKConfig(7)).rejects.toThrow(
      "BYOK decrypted payload must be a JSON object",
    );
  });

  it("throws when decrypted payload is missing apiKey", async () => {
    const masterKey = randomBytes(32);
    setRedisEnv();
    setMasterKeys({ v1: masterKey.toString("base64") });
    stubRedisGet(
      buildEnvelope({ provider: "openai" }, masterKey),
    );

    await expect(resolveInstallationBYOKConfig(7)).rejects.toThrow(
      "BYOK decrypted payload is missing apiKey",
    );
  });

  it("throws when provider is missing from decrypted payload", async () => {
    const masterKey = randomBytes(32);
    setRedisEnv();
    setMasterKeys({ v1: masterKey.toString("base64") });
    stubRedisGet(
      buildEnvelope(
        { apiKey: "sk-only" },
        masterKey,
        { provider: "openai", model: "gpt-4o-mini" },
      ),
    );

    await expect(resolveInstallationBYOKConfig(7)).rejects.toThrow(
      "BYOK provider is missing",
    );
  });

  it("ignores unauthenticated envelope model metadata", async () => {
    const masterKey = randomBytes(32);
    setRedisEnv();
    setMasterKeys({ v1: masterKey.toString("base64") });
    stubRedisGet(
      buildEnvelope(
        { apiKey: "sk", provider: "openai" },
        masterKey,
        { model: "gpt-4o-mini" },
      ),
    );

    await expect(resolveInstallationBYOKConfig(7)).resolves.toEqual({
      apiKey: "sk",
      provider: "openai",
      model: undefined,
    });
  });

  it("throws when provider is unsupported", async () => {
    const masterKey = randomBytes(32);
    setRedisEnv();
    setMasterKeys({ v1: masterKey.toString("base64") });
    stubRedisGet(
      buildEnvelope({ apiKey: "sk", provider: "vertex" }, masterKey),
    );

    await expect(resolveInstallationBYOKConfig(7)).rejects.toThrow(
      "Unsupported BYOK provider: vertex",
    );
  });
});
