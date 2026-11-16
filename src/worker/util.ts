import { ulid } from "ulid";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export type AppEnv = Env & {
  OAUTH_PROVIDER: OAuthHelpers;
  /** Seconds between webhook retries (×attempt). Default 30; tests set 1 in .dev.vars. */
  WEBHOOK_RETRY_SECONDS?: string;
};

export const newId = () => ulid();
export const nowIso = () => new Date().toISOString();

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const notFound = (what: string) => new HttpError(404, `${what} not found`);
export const badRequest = (msg: string) => new HttpError(400, msg);
export const forbidden = (msg = "Forbidden") => new HttpError(403, msg);

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(bytes = 32): string {
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...arr)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
function bytesToB64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

async function aesKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", b64ToBytes(env.WEBHOOK_KEY_ENCRYPTION_KEY), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptSecret(env: Env, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env), new TextEncoder().encode(plain));
  return `${bytesToB64(iv)}.${bytesToB64(new Uint8Array(ct))}`;
}

export async function decryptSecret(env: Env, enc: string): Promise<string> {
  const [iv, ct] = enc.split(".");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(iv) }, await aesKey(env), b64ToBytes(ct));
  return new TextDecoder().decode(pt);
}

async function hmacKey(env: Env) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signValue(env: Env, value: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env), new TextEncoder().encode(value));
  return bytesToB64(new Uint8Array(sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function verifySignedValue(env: Env, value: string, sig: string): Promise<boolean> {
  const expected = await signValue(env, value);
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
