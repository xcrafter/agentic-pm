import { type Context, Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { type MemberRow, ensureWorkspace, logActivity, notify } from "./domain";
import { type AppEnv, HttpError, newId, nowIso, randomToken, sha256Hex } from "./util";

const SESSION_COOKIE = "apm_session";
const STATE_COOKIE = "apm_oauth_state";
const SESSION_DAYS = 30;

function isSecure(env: AppEnv) {
  return env.PUBLIC_URL.startsWith("https://");
}

export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "/";
  return next;
}

export async function getSessionMember(env: AppEnv, cookieValue: string | undefined): Promise<MemberRow | null> {
  if (!cookieValue) return null;
  const hash = await sha256Hex(cookieValue);
  const row = await env.DB.prepare(
    `SELECT m.* FROM sessions s JOIN members m ON m.id = s.member_id
     WHERE s.id_hash = ? AND s.expires_at > ? AND m.active = 1 AND m.kind = 'human'`,
  )
    .bind(hash, nowIso())
    .first<MemberRow>();
  return row ?? null;
}

async function createSession(env: AppEnv, memberId: string) {
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  await env.DB.prepare("INSERT INTO sessions (id_hash, member_id, expires_at, created_at) VALUES (?,?,?,?)")
    .bind(await sha256Hex(token), memberId, expires, nowIso())
    .run();
  return token;
}

function allowedDomains(env: AppEnv) {
  return (env.ALLOWED_EMAIL_DOMAINS || "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

async function uniqueHandle(env: AppEnv, workspaceId: string, base: string) {
  const clean = base.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "member";
  let handle = clean;
  for (let i = 2; ; i++) {
    const exists = await env.DB.prepare("SELECT 1 FROM members WHERE workspace_id = ? AND handle = ?").bind(workspaceId, handle).first();
    if (!exists) return handle;
    handle = `${clean}${i}`;
  }
}
export { uniqueHandle };

export async function loginHuman(
  env: AppEnv,
  profile: { email: string; name: string; avatarUrl?: string | null; googleSub?: string | null },
): Promise<MemberRow> {
  const email = profile.email.trim().toLowerCase();
  const domains = allowedDomains(env);
  const domain = email.split("@")[1] ?? "";
  if (domains.length && !domains.includes(domain)) {
    throw new HttpError(403, `Sign-in is limited to: ${domains.join(", ")}`);
  }
  const ws = await ensureWorkspace(env);
  const existing = await env.DB.prepare("SELECT * FROM members WHERE workspace_id = ? AND email = ?").bind(ws.id, email).first<MemberRow>();
  if (existing) {
    if (!existing.active) throw new HttpError(403, "Your account has been deactivated");
    await env.DB.prepare("UPDATE members SET avatar_url = COALESCE(?, avatar_url), google_sub = COALESCE(?, google_sub) WHERE id = ?")
      .bind(profile.avatarUrl ?? null, profile.googleSub ?? null, existing.id)
      .run();
    return existing;
  }
  const humans = await env.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE workspace_id = ? AND kind = 'human'")
    .bind(ws.id)
    .first<{ n: number }>();
  const id = newId();
  const handle = await uniqueHandle(env, ws.id, email.split("@")[0]);
  const role = humans?.n ? "member" : "admin";
  await env.DB.prepare(
    `INSERT INTO members (id, workspace_id, kind, name, handle, avatar_url, role, email, google_sub, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(id, ws.id, "human", profile.name || email, handle, profile.avatarUrl ?? null, role, email, profile.googleSub ?? null, nowIso())
    .run();
  const member = (await env.DB.prepare("SELECT * FROM members WHERE id = ?").bind(id).first<MemberRow>())!;
  await logActivity(env, ws.id, { member, via: "web" }, "member", id, "joined");
  return member;
}

export const authRoutes = new Hono<{ Bindings: AppEnv }>();

authRoutes.get("/auth/google", async (c) => {
  if (!c.env.GOOGLE_CLIENT_ID) return c.text("Google sign-in is not configured (GOOGLE_CLIENT_ID).", 500);
  const state = randomToken(16);
  const next = safeNext(c.req.query("next"));
  setCookie(c, STATE_COOKIE, `${state}|${next}`, {
    httpOnly: true,
    secure: isSecure(c.env),
    sameSite: "Lax",
    path: "/auth",
    maxAge: 600,
  });
  const params = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: `${c.env.PUBLIC_URL}/auth/google/callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  });
  const hd = allowedDomains(c.env);
  if (hd.length === 1) params.set("hd", hd[0]);
  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

authRoutes.get("/auth/google/callback", async (c) => {
  const [expectedState, next] = (getCookie(c, STATE_COOKIE) ?? "|").split("|");
  deleteCookie(c, STATE_COOKIE, { path: "/auth" });
  const code = c.req.query("code");
  if (!code || !expectedState || c.req.query("state") !== expectedState) return c.text("Sign-in failed: invalid state", 400);
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${c.env.PUBLIC_URL}/auth/google/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) return c.text("Sign-in failed: token exchange", 400);
  const { access_token } = await tokenRes.json<{ access_token: string }>();
  const infoRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  const info = await infoRes.json<{ sub: string; email: string; email_verified: boolean; name: string; picture?: string }>();
  if (!info.email_verified) return c.text("Your Google email is not verified", 403);
  try {
    const member = await loginHuman(c.env, { email: info.email, name: info.name, avatarUrl: info.picture, googleSub: info.sub });
    const token = await createSession(c.env, member.id);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: isSecure(c.env),
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_DAYS * 86400,
    });
    return c.redirect(safeNext(next));
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as 403);
    throw err;
  }
});

// ---------- Email + password ----------

const PBKDF2_ITERATIONS = 100_000;
const MIN_PASSWORD = 8;
const MAX_FAILED_LOGINS = 10;
const INVITE_DAYS = 7;
const RESET_HOURS = 24;

const toB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));

async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toB64(salt)}$${toB64(await pbkdf2(password, salt, PBKDF2_ITERATIONS))}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const [scheme, iter, salt, hash] = (stored ?? "").split("$");
  if (scheme !== "pbkdf2" || !salt || !hash) {
    // Spend the same time as a real check so unknown emails aren't distinguishable.
    await pbkdf2(password, new Uint8Array(16), PBKDF2_ITERATIONS);
    return false;
  }
  const actual = await pbkdf2(password, fromB64(salt) as Uint8Array<ArrayBuffer>, Number(iter));
  const expected = fromB64(hash);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

function checkPassword(password: unknown): string {
  if (typeof password !== "string" || password.length < MIN_PASSWORD) {
    throw new HttpError(400, `Password must be at least ${MIN_PASSWORD} characters`);
  }
  if (password.length > 200) throw new HttpError(400, "Password is too long");
  return password;
}

function checkEmail(env: AppEnv, raw: unknown): string {
  const email = String(raw ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "Enter a valid email address");
  const domains = allowedDomains(env);
  if (domains.length && !domains.includes(email.split("@")[1])) {
    throw new HttpError(403, `Only ${domains.map((d) => "@" + d).join(", ")} addresses can join`);
  }
  return email;
}

async function humanCount(env: AppEnv, workspaceId: string) {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE workspace_id = ? AND kind = 'human'")
    .bind(workspaceId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

export async function needsSetup(env: AppEnv) {
  const ws = await ensureWorkspace(env);
  return (await humanCount(env, ws.id)) === 0;
}

async function insertHuman(env: AppEnv, workspaceId: string, p: { email: string; name: string; role: "admin" | "member"; passwordHash: string; createdBy?: string | null }) {
  const id = newId();
  const handle = await uniqueHandle(env, workspaceId, p.email.split("@")[0]);
  await env.DB.prepare(
    `INSERT INTO members (id, workspace_id, kind, name, handle, role, email, password_hash, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(id, workspaceId, "human", p.name || p.email.split("@")[0], handle, p.role, p.email, p.passwordHash, p.createdBy ?? null, nowIso())
    .run();
  return (await env.DB.prepare("SELECT * FROM members WHERE id = ?").bind(id).first<MemberRow>())!;
}

async function startSession(c: Context<{ Bindings: AppEnv }>, memberId: string) {
  const token = await createSession(c.env, memberId);
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, secure: isSecure(c.env), sameSite: "Lax", path: "/", maxAge: SESSION_DAYS * 86400 });
}

// JSON-only bodies: a cross-site HTML form can't send application/json without a CORS preflight.
async function jsonBody<T>(c: Context<{ Bindings: AppEnv }>): Promise<T> {
  if (!(c.req.header("Content-Type") ?? "").includes("application/json")) throw new HttpError(415, "Expected JSON");
  return c.req.json<T>();
}

authRoutes.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
  console.error(err);
  return c.json({ error: "Internal error" }, 500);
});

// First run only: the first person creates the workspace admin account.
authRoutes.post("/auth/setup", async (c) => {
  const body = await jsonBody<{ name?: string; email?: string; password?: string }>(c);
  const ws = await ensureWorkspace(c.env);
  if ((await humanCount(c.env, ws.id)) > 0) throw new HttpError(403, "This workspace is already set up. Ask an admin for an invite.");
  const email = checkEmail(c.env, body.email);
  const member = await insertHuman(c.env, ws.id, {
    email,
    name: String(body.name ?? "").trim(),
    role: "admin",
    passwordHash: await hashPassword(checkPassword(body.password)),
  });
  await logActivity(c.env, ws.id, { member, via: "web" }, "member", member.id, "joined", undefined, { setup: true });
  await startSession(c, member.id);
  return c.json({ ok: true });
});

authRoutes.post("/auth/login", async (c) => {
  const body = await jsonBody<{ email?: string; password?: string }>(c);
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const throttleKey = `login-fail:${await sha256Hex(email)}`;
  const failures = Number((await c.env.OAUTH_KV.get(throttleKey)) ?? 0);
  if (failures >= MAX_FAILED_LOGINS) throw new HttpError(429, "Too many failed attempts. Try again in 15 minutes.");
  const ws = await ensureWorkspace(c.env);
  const member = await c.env.DB.prepare("SELECT * FROM members WHERE workspace_id = ? AND kind = 'human' AND email = ?")
    .bind(ws.id, email)
    .first<MemberRow>();
  const valid = await verifyPassword(password, member?.password_hash ?? null);
  if (!member || !valid) {
    await c.env.OAUTH_KV.put(throttleKey, String(failures + 1), { expirationTtl: 900 });
    throw new HttpError(401, "Wrong email or password");
  }
  if (!member.active) throw new HttpError(403, "Your account has been deactivated");
  await c.env.OAUTH_KV.delete(throttleKey);
  await startSession(c, member.id);
  return c.json({ ok: true });
});

export interface InviteRow {
  id: string;
  workspace_id: string;
  email: string;
  name: string | null;
  role: "admin" | "member";
  member_id: string | null;
  created_by: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

/** Creates a one-time link: an invite for a new person, or a password reset when memberId is set. */
export async function createInvite(
  env: AppEnv,
  by: MemberRow,
  p: { email: string; name?: string | null; role?: "admin" | "member"; memberId?: string | null },
) {
  const email = p.memberId ? p.email : checkEmail(env, p.email);
  if (!p.memberId) {
    const exists = await env.DB.prepare("SELECT 1 FROM members WHERE workspace_id = ? AND email = ?").bind(by.workspace_id, email).first();
    if (exists) throw new HttpError(409, "That person is already a member. Use “Reset password” instead.");
  }
  // A new link replaces any unused one for the same address.
  await env.DB.prepare("DELETE FROM invites WHERE workspace_id = ? AND email = ? AND used_at IS NULL").bind(by.workspace_id, email).run();
  const token = randomToken();
  const ms = p.memberId ? RESET_HOURS * 3600_000 : INVITE_DAYS * 86400_000;
  const id = newId();
  await env.DB.prepare(
    `INSERT INTO invites (id, workspace_id, token_hash, email, name, role, member_id, created_by, created_at, expires_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(id, by.workspace_id, await sha256Hex(token), email, p.name ?? null, p.role ?? "member", p.memberId ?? null, by.id, nowIso(), new Date(Date.now() + ms).toISOString())
    .run();
  return { id, url: `${env.PUBLIC_URL}/invite/${token}`, expires_at: new Date(Date.now() + ms).toISOString() };
}

async function findInvite(env: AppEnv, token: string) {
  const row = await env.DB.prepare("SELECT * FROM invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?")
    .bind(await sha256Hex(token), nowIso())
    .first<InviteRow>();
  if (!row) throw new HttpError(404, "This link is invalid or has expired. Ask an admin for a new one.");
  return row;
}

authRoutes.get("/auth/invite/:token", async (c) => {
  const inv = await findInvite(c.env, c.req.param("token"));
  const ws = await ensureWorkspace(c.env);
  return c.json({ email: inv.email, name: inv.name, reset: !!inv.member_id, workspace: ws.name });
});

authRoutes.post("/auth/invite/:token", async (c) => {
  const body = await jsonBody<{ name?: string; password?: string }>(c);
  const inv = await findInvite(c.env, c.req.param("token"));
  const passwordHash = await hashPassword(checkPassword(body.password));
  const claimed = await c.env.DB.prepare("UPDATE invites SET used_at = ? WHERE id = ? AND used_at IS NULL").bind(nowIso(), inv.id).run();
  if (!claimed.meta.changes) throw new HttpError(409, "This link was already used");
  let member: MemberRow;
  if (inv.member_id) {
    member = (await c.env.DB.prepare("SELECT * FROM members WHERE id = ?").bind(inv.member_id).first<MemberRow>())!;
    if (!member?.active) throw new HttpError(403, "Your account has been deactivated");
    await c.env.DB.prepare("UPDATE members SET password_hash = ? WHERE id = ?").bind(passwordHash, member.id).run();
    // A reset signs out every other session.
    await c.env.DB.prepare("DELETE FROM sessions WHERE member_id = ?").bind(member.id).run();
    await logActivity(c.env, inv.workspace_id, { member, via: "web" }, "member", member.id, "password_reset");
  } else {
    member = await insertHuman(c.env, inv.workspace_id, {
      email: inv.email,
      name: String(body.name ?? inv.name ?? "").trim(),
      role: inv.role,
      passwordHash,
      createdBy: inv.created_by,
    });
    await logActivity(c.env, inv.workspace_id, { member, via: "web" }, "member", member.id, "joined", undefined, { invited_by: inv.created_by });
    await notify(c.env, inv.workspace_id, { type: "members" });
  }
  await startSession(c, member.id);
  return c.json({ ok: true });
});

authRoutes.post("/auth/logout", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await c.env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(await sha256Hex(token)).run();
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

export { SESSION_COOKIE };
