import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { type MemberRow, ensureWorkspace, logActivity } from "./domain";
import { type AppEnv, HttpError, escapeHtml, newId, nowIso, randomToken, sha256Hex } from "./util";

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

// Development-only sign-in (DEV_LOGIN=true). Never enable in production.
authRoutes.get("/auth/dev", (c) => {
  if (c.env.DEV_LOGIN !== "true") return c.notFound();
  const next = escapeHtml(safeNext(c.req.query("next")));
  return c.html(`<!doctype html><meta charset="utf-8"><title>Dev sign-in</title>
<style>body{font-family:system-ui;max-width:360px;margin:80px auto}input,button{display:block;width:100%;margin:8px 0;padding:8px}</style>
<h2>Developer sign-in</h2><p>Local development only.</p>
<form method="post"><input name="email" placeholder="you@${escapeHtml(allowedDomains(c.env)[0] ?? "example.com")}" required>
<input name="name" placeholder="Your name"><input type="hidden" name="next" value="${next}"><button>Sign in</button></form>`);
});

authRoutes.post("/auth/dev", async (c) => {
  if (c.env.DEV_LOGIN !== "true") return c.notFound();
  const form = await c.req.formData();
  const email = String(form.get("email") ?? "");
  try {
    const member = await loginHuman(c.env, { email, name: String(form.get("name") || email.split("@")[0]) });
    const token = await createSession(c.env, member.id);
    setCookie(c, SESSION_COOKIE, token, { httpOnly: true, secure: isSecure(c.env), sameSite: "Lax", path: "/", maxAge: SESSION_DAYS * 86400 });
    return c.redirect(safeNext(String(form.get("next") ?? "/")));
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as 403);
    throw err;
  }
});

authRoutes.post("/auth/logout", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await c.env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(await sha256Hex(token)).run();
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

export { SESSION_COOKIE };
