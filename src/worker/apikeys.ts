/**
 * Personal API keys. A key acts as the person who made it, with exactly their permissions, on every
 * /api/* endpoint the app itself uses. Keys are shown once, stored as a SHA-256 hash, and revocable.
 * Requests made with a key can't create, list or revoke keys, so a leaked key can't mint more.
 */
import { Hono } from "hono";
import type { Actor, MemberRow, WorkspaceRow } from "./domain";
import { type AppEnv, badRequest, forbidden, newId, notFound, nowIso, randomToken, sha256Hex } from "./util";

export const KEY_PREFIX = "apm_";

/** The member behind `Authorization: Bearer apm_…`, or null. Records last use (at most once a minute). */
export async function memberFromApiKey(env: AppEnv, header: string | undefined): Promise<MemberRow | null> {
  const m = /^Bearer\s+(apm_[A-Za-z0-9_-]{20,})\s*$/.exec(header ?? "");
  if (!m) return null;
  const hash = await sha256Hex(m[1]);
  const row = await env.DB.prepare(
    `SELECT m.*, k.id AS _key_id, k.last_used_at AS _last_used FROM api_keys k JOIN members m ON m.id = k.member_id
     WHERE k.key_hash = ? AND k.revoked_at IS NULL AND m.active = 1 AND m.kind = 'human'`,
  )
    .bind(hash)
    .first<MemberRow & { _key_id: string; _last_used: string | null }>();
  if (!row) return null;
  const { _key_id, _last_used, ...member } = row;
  if (!_last_used || Date.now() - Date.parse(_last_used) > 60_000) {
    await env.DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(nowIso(), _key_id).run();
  }
  return member as MemberRow;
}

type Vars = { me: MemberRow; ws: WorkspaceRow; actor: Actor; viaKey: boolean };
export const apiKeyRoutes = new Hono<{ Bindings: AppEnv; Variables: Vars }>();

const noKeys = (viaKey: boolean) => {
  if (viaKey) throw forbidden("API keys can't manage API keys. Use the app (Settings → API keys).");
};

const publicKey = (k: Record<string, unknown>) => ({
  id: k.id,
  name: k.name,
  prefix: k.prefix,
  member: k.member_id ? { id: k.member_id, name: k.member_name } : undefined,
  created_at: k.created_at,
  last_used_at: k.last_used_at,
});

// Yours; admins also see everyone else's (to revoke them).
apiKeyRoutes.get("/api/keys", async (c) => {
  noKeys(c.get("viaKey"));
  const me = c.get("me");
  const all = me.role === "admin";
  const rows = await c.env.DB.prepare(
    `SELECT k.*, m.name AS member_name FROM api_keys k JOIN members m ON m.id = k.member_id
     WHERE k.workspace_id = ? AND k.revoked_at IS NULL ${all ? "" : "AND k.member_id = ?"} ORDER BY k.created_at DESC`,
  )
    .bind(...(all ? [c.get("ws").id] : [c.get("ws").id, me.id]))
    .all();
  return c.json(rows.results.map(publicKey));
});

apiKeyRoutes.post("/api/keys", async (c) => {
  noKeys(c.get("viaKey"));
  const b = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
  const name = (b.name ?? "").trim().slice(0, 80);
  if (!name) throw badRequest("Give the key a name, like what will use it");
  const me = c.get("me");
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE member_id = ? AND revoked_at IS NULL")
    .bind(me.id)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= 20) throw badRequest("You have 20 keys. Revoke one you don't use first.");
  const token = KEY_PREFIX + randomToken(24);
  const row = {
    id: newId(),
    workspace_id: c.get("ws").id,
    member_id: me.id,
    name,
    prefix: token.slice(0, 8),
    key_hash: await sha256Hex(token),
    created_at: nowIso(),
  };
  await c.env.DB.prepare("INSERT INTO api_keys (id, workspace_id, member_id, name, prefix, key_hash, created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(row.id, row.workspace_id, row.member_id, row.name, row.prefix, row.key_hash, row.created_at)
    .run();
  // The only time the full key is returned.
  return c.json({ ...publicKey({ ...row, member_name: me.name, last_used_at: null }), key: token }, 201);
});

apiKeyRoutes.delete("/api/keys/:id", async (c) => {
  noKeys(c.get("viaKey"));
  const me = c.get("me");
  const k = await c.env.DB.prepare("SELECT * FROM api_keys WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL")
    .bind(c.req.param("id"), c.get("ws").id)
    .first<{ member_id: string }>();
  if (!k) throw notFound("Key");
  if (k.member_id !== me.id && me.role !== "admin") throw forbidden("Only its owner or an admin can revoke this key");
  await c.env.DB.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ?").bind(nowIso(), c.req.param("id")).run();
  return c.json({ ok: true });
});
