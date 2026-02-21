import { createDecipheriv } from "node:crypto";

import { Redis } from "ioredis";

import type { LLMProvider } from "./types.js";

const DEFAULT_REDIS_KEY_PREFIX = "hive:byok";
const REDIS_URL_ENV = "HIVEMOOT_REDIS_URL";
const MASTER_KEYS_ENV = "BYOK_MASTER_KEYS_JSON";
const REDIS_KEY_PREFIX_ENV = "BYOK_REDIS_KEY_PREFIX";
const REDIS_COMMAND_TIMEOUT_MS = 5000;

interface RedisRuntimeConfig {
  redisUrl: string;
  keyPrefix: string;
}

interface BYOKEnvelope {
  ciphertext: string;
  iv: string;
  tag: string;
  keyVersion: string;
  provider?: string;
  model?: string;
  status?: string;
}

interface BYOKPayload {
  apiKey: string;
  provider?: string;
  model?: string;
}

export interface InstallationBYOKConfig {
  provider: LLMProvider;
  model?: string;
  apiKey: string;
}

function normalizeEnvString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  let normalized = value.trim();
  if (normalized.length === 0) {
    return undefined;
  }

  const hasMatchingQuotes =
    (normalized.startsWith("\"") && normalized.endsWith("\"")) ||
    (normalized.startsWith("'") && normalized.endsWith("'"));
  if (hasMatchingQuotes) {
    normalized = normalized.slice(1, -1).trim();
  }

  return normalized.length > 0 ? normalized : undefined;
}

function getRedisRuntimeConfig(): RedisRuntimeConfig | null {
  const redisUrl = normalizeEnvString(process.env[REDIS_URL_ENV]);
  if (!redisUrl) {
    return null;
  }

  const keyPrefix = normalizeEnvString(process.env[REDIS_KEY_PREFIX_ENV]) ?? DEFAULT_REDIS_KEY_PREFIX;

  return { redisUrl, keyPrefix };
}

let redisClient: Redis | null = null;

function getOrCreateRedisClient(redisUrl: string): Redis {
  if (redisClient && redisClient.status !== "end" && redisClient.status !== "close") {
    return redisClient;
  }

  // Dispose of dead client if one exists
  if (redisClient) {
    redisClient.disconnect();
    redisClient = null;
  }

  const client = new Redis(redisUrl, {
    lazyConnect: true,
    commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
    // One retry catches transient blips; more risks webhook timeout
    // (worst-case ≈ connectTimeout × retries + commandTimeout)
    maxRetriesPerRequest: 1,
    connectTimeout: 5000,
  });

  // Prevent unhandled 'error' events from crashing long-lived processes.
  // Command-level errors are already caught in fetchEnvelope's try-catch.
  client.on("error", (err: Error) => {
    console.error(`[byok] Redis client error: ${err.message}`);
  });

  redisClient = client;
  return client;
}

function parseProvider(raw: unknown): LLMProvider {
  if (typeof raw !== "string") {
    throw new Error("BYOK provider is missing");
  }

  const normalized = raw.trim().toLowerCase();
  switch (normalized) {
    case "anthropic":
    case "openai":
    case "google":
    case "mistral":
      return normalized;
    case "gemini":
      return "google";
    default:
      throw new Error(`Unsupported BYOK provider: ${raw}`);
  }
}

function parseMasterKeys(): ReadonlyMap<string, Buffer> {
  const raw = normalizeEnvString(process.env[MASTER_KEYS_ENV]);
  if (!raw) {
    throw new Error(`BYOK master keys are not configured: set ${MASTER_KEYS_ENV}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${MASTER_KEYS_ENV} must be valid JSON`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${MASTER_KEYS_ENV} must be a JSON object keyed by keyVersion`);
  }

  const result = new Map<string, Buffer>();
  for (const [version, encodedKey] of Object.entries(parsed)) {
    if (typeof encodedKey !== "string" || encodedKey.trim().length === 0) {
      throw new Error(`${MASTER_KEYS_ENV}.${version} must be a non-empty base64 string`);
    }

    const key = Buffer.from(encodedKey, "base64");
    if (key.length !== 32) {
      throw new Error(`${MASTER_KEYS_ENV}.${version} must decode to 32 bytes for AES-256-GCM`);
    }
    result.set(version, key);
  }

  if (result.size === 0) {
    throw new Error(`${MASTER_KEYS_ENV} must include at least one key version`);
  }

  return result;
}

function decodeBase64Field(fieldName: string, value: string): Buffer {
  try {
    const decoded = Buffer.from(value, "base64");
    if (decoded.length === 0) {
      throw new Error();
    }
    return decoded;
  } catch {
    throw new Error(`BYOK envelope field '${fieldName}' is not valid base64`);
  }
}

function parseEnvelope(rawEnvelope: string): BYOKEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawEnvelope);
  } catch {
    throw new Error("BYOK envelope is not valid JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("BYOK envelope must be a JSON object");
  }

  const envelope = parsed as Partial<BYOKEnvelope>;

  if (
    typeof envelope.ciphertext !== "string" ||
    typeof envelope.iv !== "string" ||
    typeof envelope.tag !== "string" ||
    typeof envelope.keyVersion !== "string"
  ) {
    throw new Error("BYOK envelope is missing required fields");
  }

  return {
    ciphertext: envelope.ciphertext,
    iv: envelope.iv,
    tag: envelope.tag,
    keyVersion: envelope.keyVersion,
    provider: envelope.provider,
    model: envelope.model,
    status: envelope.status,
  };
}

function decryptEnvelope(
  envelope: BYOKEnvelope,
  masterKeys: ReadonlyMap<string, Buffer>,
): BYOKPayload {
  const key = masterKeys.get(envelope.keyVersion);
  if (!key) {
    throw new Error(`BYOK key version '${envelope.keyVersion}' is unavailable`);
  }

  const iv = decodeBase64Field("iv", envelope.iv);
  if (iv.length !== 12) {
    throw new Error(`BYOK envelope IV must be 12 bytes (96 bits) for AES-256-GCM; got ${iv.length}`);
  }

  const authTag = decodeBase64Field("tag", envelope.tag);
  const ciphertext = decodeBase64Field("ciphertext", envelope.ciphertext);

  let plaintext: string;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    throw new Error("BYOK key material could not be decrypted", { cause: error });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(plaintext);
  } catch {
    throw new Error("BYOK decrypted payload is not valid JSON");
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("BYOK decrypted payload must be a JSON object");
  }

  const byokPayload = payload as Partial<BYOKPayload>;
  if (typeof byokPayload.apiKey !== "string" || byokPayload.apiKey.trim().length === 0) {
    throw new Error("BYOK decrypted payload is missing apiKey");
  }

  return {
    apiKey: byokPayload.apiKey.trim(),
    provider: byokPayload.provider,
    model: byokPayload.model,
  };
}

async function fetchEnvelope(
  runtimeConfig: RedisRuntimeConfig,
  installationId: number,
): Promise<BYOKEnvelope | null> {
  const key = `${runtimeConfig.keyPrefix}:${installationId}`;
  const client = getOrCreateRedisClient(runtimeConfig.redisUrl);

  let raw: string | null;
  try {
    raw = await client.get(key);
  } catch (error) {
    throw new Error(
      `BYOK Redis lookup failed for installation ${installationId}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  if (raw === null) {
    return null;
  }

  return parseEnvelope(raw);
}

/**
 * Resolve BYOK config for an installation from encrypted Redis records.
 *
 * Returns null when BYOK is not configured for the installation, and throws
 * when BYOK material exists but cannot be validated/decrypted (fail-closed).
 */
export async function resolveInstallationBYOKConfig(
  installationId: number
): Promise<InstallationBYOKConfig | null> {
  const runtimeConfig = getRedisRuntimeConfig();
  if (!runtimeConfig) {
    return null;
  }

  const envelope = await fetchEnvelope(runtimeConfig, installationId);
  if (!envelope) {
    return null;
  }

  if (envelope.status === "revoked") {
    return null;
  }

  if (envelope.status !== "active") {
    const status = envelope.status ?? "missing";
    throw new Error(
      `BYOK record for installation ${installationId} is not active (status=${status})`
    );
  }

  const masterKeys = parseMasterKeys();
  const decrypted = decryptEnvelope(envelope, masterKeys);

  return {
    apiKey: decrypted.apiKey,
    provider: parseProvider(decrypted.provider),
    model: normalizeEnvString(decrypted.model),
  };
}
