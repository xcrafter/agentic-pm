/**
 * What each person sees in the sidebar.
 *
 * A sidebar profile is a named set of hidden sidebar items (e.g. "Sales" hides Policies and Tools).
 * Admins create profiles, assign them to people, and can make one the default for everyone without
 * a profile. On top of that, each person can hide or show items for themselves. Hiding an item only
 * tidies the sidebar: the page is still reachable by link and from search, so it isn't a permission.
 *
 * Effective hidden set = (profile.hidden ∪ personal.hidden) − personal.shown
 */
import { Hono } from "hono";
import { type Actor, type MemberRow, type WorkspaceRow, logActivity, notify } from "./domain";
import { type AppEnv, badRequest, forbidden, newId, notFound, nowIso } from "./util";

export const SIDEBAR_ITEMS = [
  { key: "inbox", label: "Needs you", group: "main" },
  { key: "feed", label: "Feed", group: "main" },
  { key: "my", label: "My tasks", group: "main" },
  { key: "ideas", label: "Ideas", group: "main" },
  { key: "customers", label: "Customers", group: "main" },
  { key: "policies", label: "Policies", group: "main" },
  { key: "all", label: "All tasks", group: "main" },
  { key: "workspace", label: "Overview", group: "team" },
  { key: "team", label: "Members & agents", group: "team" },
  { key: "reports", label: "Reports", group: "team" },
  { key: "projects", label: "Projects", group: "team" },
  { key: "tools", label: "Tools", group: "team" },
  { key: "settings", label: "Workspace settings", group: "team" },
  { key: "favorite_views", label: "Favorite views", group: "sections" },
  { key: "project_list", label: "Project list", group: "sections" },
] as const;
const KEYS = new Set<string>(SIDEBAR_ITEMS.map((i) => i.key));

export interface SidebarProfileRow {
  id: string;
  workspace_id: string;
  name: string;
  hidden: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const parseList = (raw: unknown): string[] => {
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(v) ? [...new Set(v.filter((k): k is string => typeof k === "string" && KEYS.has(k)))] : [];
  } catch {
    return [];
  }
};

/** Validate a list of item keys from a request body. */
function itemKeys(raw: unknown, field: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw badRequest(`${field} must be a list of sidebar items`);
  const bad = raw.filter((k) => typeof k !== "string" || !KEYS.has(k));
  if (bad.length) throw badRequest(`Unknown sidebar item: ${bad.join(", ")}. Use one of ${[...KEYS].join(", ")}`);
  return [...new Set(raw as string[])];
}

function personalPrefs(m: MemberRow) {
  try {
    const p = JSON.parse(m.sidebar_prefs || "{}");
    return { hidden: parseList(p.hidden), shown: parseList(p.shown) };
  } catch {
    return { hidden: [], shown: [] };
  }
}

async function getProfile(env: AppEnv, ws: WorkspaceRow, id: string) {
  const p = await env.DB.prepare("SELECT * FROM sidebar_profiles WHERE id = ? AND workspace_id = ?").bind(id, ws.id).first<SidebarProfileRow>();
  if (!p) throw notFound("Sidebar profile");
  return p;
}

/** The sidebar a member sees, and where it comes from. */
export async function effectiveSidebar(env: AppEnv, ws: WorkspaceRow, me: MemberRow) {
  const fresh = await env.DB.prepare("SELECT sidebar_profile_id, sidebar_prefs FROM members WHERE id = ?")
    .bind(me.id)
    .first<{ sidebar_profile_id: string | null; sidebar_prefs: string | null }>();
  const wsRow = await env.DB.prepare("SELECT default_sidebar_profile_id FROM workspaces WHERE id = ?")
    .bind(ws.id)
    .first<{ default_sidebar_profile_id: string | null }>();
  const ownId = fresh?.sidebar_profile_id ?? null;
  const profileId = ownId ?? wsRow?.default_sidebar_profile_id ?? null;
  const profile = profileId
    ? await env.DB.prepare("SELECT * FROM sidebar_profiles WHERE id = ? AND workspace_id = ?").bind(profileId, ws.id).first<SidebarProfileRow>()
    : null;
  const base = profile ? parseList(profile.hidden) : [];
  const personal = personalPrefs({ ...me, sidebar_prefs: fresh?.sidebar_prefs ?? null });
  const shown = new Set(personal.shown);
  const hidden = [...new Set([...base, ...personal.hidden])].filter((k) => !shown.has(k));
  return {
    hidden,
    profile: profile ? { id: profile.id, name: profile.name, hidden: base, source: ownId ? ("assigned" as const) : ("default" as const) } : null,
    personal,
    items: SIDEBAR_ITEMS,
  };
}

async function listProfiles(env: AppEnv, ws: WorkspaceRow) {
  const [rows, counts, wsRow] = await Promise.all([
    env.DB.prepare("SELECT * FROM sidebar_profiles WHERE workspace_id = ? ORDER BY name COLLATE NOCASE").bind(ws.id).all<SidebarProfileRow>(),
    env.DB.prepare(
      "SELECT sidebar_profile_id AS id, GROUP_CONCAT(id) AS ids FROM members WHERE workspace_id = ? AND sidebar_profile_id IS NOT NULL GROUP BY sidebar_profile_id",
    )
      .bind(ws.id)
      .all<{ id: string; ids: string }>(),
    env.DB.prepare("SELECT default_sidebar_profile_id FROM workspaces WHERE id = ?").bind(ws.id).first<{ default_sidebar_profile_id: string | null }>(),
  ]);
  const members = new Map(counts.results.map((r) => [r.id, r.ids.split(",")]));
  return rows.results.map((p) => ({
    id: p.id,
    name: p.name,
    hidden: parseList(p.hidden),
    member_ids: members.get(p.id) ?? [],
    is_default: wsRow?.default_sidebar_profile_id === p.id,
    created_at: p.created_at,
    updated_at: p.updated_at,
  }));
}

/** Validate member_ids from a request: people (not agents) in this workspace. */
async function checkMemberIds(env: AppEnv, ws: WorkspaceRow, raw: unknown): Promise<string[]> {
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string")) throw badRequest("member_ids must be a list of member ids");
  const ids = [...new Set(raw as string[])];
  if (ids.length) {
    const found = await env.DB.prepare(
      `SELECT id FROM members WHERE workspace_id = ? AND kind = 'human' AND id IN (${ids.map(() => "?").join(",")})`,
    )
      .bind(ws.id, ...ids)
      .all<{ id: string }>();
    if (found.results.length !== ids.length) throw badRequest("member_ids must be people in this workspace (agents have no sidebar)");
  }
  return ids;
}

/** Point exactly these people at the profile (others on it fall back to the default). */
async function setProfileMembers(env: AppEnv, profileId: string, ws: WorkspaceRow, ids: string[]) {
  const stmts = [env.DB.prepare("UPDATE members SET sidebar_profile_id = NULL WHERE workspace_id = ? AND sidebar_profile_id = ?").bind(ws.id, profileId)];
  if (ids.length)
    stmts.push(
      env.DB.prepare(`UPDATE members SET sidebar_profile_id = ? WHERE workspace_id = ? AND id IN (${ids.map(() => "?").join(",")})`).bind(
        profileId,
        ws.id,
        ...ids,
      ),
    );
  await env.DB.batch(stmts);
}

async function setDefault(env: AppEnv, ws: WorkspaceRow, profileId: string, on: boolean) {
  if (on) await env.DB.prepare("UPDATE workspaces SET default_sidebar_profile_id = ? WHERE id = ?").bind(profileId, ws.id).run();
  else
    await env.DB.prepare("UPDATE workspaces SET default_sidebar_profile_id = NULL WHERE id = ? AND default_sidebar_profile_id = ?")
      .bind(ws.id, profileId)
      .run();
}

/** Assign one person to a profile (or none). Admins only; used by PATCH /api/members/:id. */
export async function assignSidebarProfile(env: AppEnv, ws: WorkspaceRow, target: MemberRow, profileId: string | null) {
  if (target.kind !== "human") throw badRequest("Agents have no sidebar");
  if (profileId) await getProfile(env, ws, profileId);
  await env.DB.prepare("UPDATE members SET sidebar_profile_id = ? WHERE id = ?").bind(profileId, target.id).run();
}

type Vars = { me: MemberRow; ws: WorkspaceRow; actor: Actor; viaKey: boolean };
export const sidebarRoutes = new Hono<{ Bindings: AppEnv; Variables: Vars }>();

const adminOnly = (me: MemberRow) => {
  if (me.role !== "admin") throw forbidden("Only admins can manage sidebar profiles");
};
const changed = (env: AppEnv, ws: WorkspaceRow) => notify(env, ws.id, { type: "sidebar" });

// Your sidebar: what's hidden, which profile it comes from, and your own changes.
sidebarRoutes.get("/api/sidebar", async (c) => c.json(await effectiveSidebar(c.env, c.get("ws"), c.get("me"))));

// Your own changes on top of your profile. { hidden: [...], shown: [...] } replaces them; { reset: true } clears them.
sidebarRoutes.put("/api/sidebar", async (c) => {
  const me = c.get("me");
  if (me.kind !== "human") throw badRequest("Agents have no sidebar");
  const body = await c.req.json<{ hidden?: unknown; shown?: unknown; reset?: boolean }>().catch(() => ({}) as Record<string, never>);
  let prefs: string | null = null;
  if (!body.reset) {
    const hidden = itemKeys(body.hidden, "hidden");
    const shown = itemKeys(body.shown, "shown").filter((k) => !hidden.includes(k));
    prefs = hidden.length || shown.length ? JSON.stringify({ hidden, shown }) : null;
  }
  await c.env.DB.prepare("UPDATE members SET sidebar_prefs = ? WHERE id = ?").bind(prefs, me.id).run();
  return c.json(await effectiveSidebar(c.env, c.get("ws"), { ...me, sidebar_prefs: prefs }));
});

sidebarRoutes.get("/api/sidebar-profiles", async (c) => c.json({ items: SIDEBAR_ITEMS, profiles: await listProfiles(c.env, c.get("ws")) }));

sidebarRoutes.post("/api/sidebar-profiles", async (c) => {
  const me = c.get("me");
  const ws = c.get("ws");
  adminOnly(me);
  const body = await c.req.json<{ name?: string; hidden?: unknown; member_ids?: unknown; is_default?: boolean }>();
  const name = body.name?.trim();
  if (!name) throw badRequest("Give the profile a name");
  if (name.length > 60) throw badRequest("Keep the name under 60 characters");
  const hidden = itemKeys(body.hidden, "hidden");
  const memberIds = body.member_ids === undefined ? null : await checkMemberIds(c.env, ws, body.member_ids);
  const id = newId();
  const now = nowIso();
  await c.env.DB.prepare("INSERT INTO sidebar_profiles (id, workspace_id, name, hidden, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
    .bind(id, ws.id, name, JSON.stringify(hidden), me.id, now, now)
    .run();
  if (memberIds) await setProfileMembers(c.env, id, ws, memberIds);
  if (body.is_default !== undefined) await setDefault(c.env, ws, id, !!body.is_default);
  await logActivity(c.env, ws.id, c.get("actor"), "sidebar_profile", id, "created", null, { name });
  await changed(c.env, ws);
  return c.json((await listProfiles(c.env, ws)).find((p) => p.id === id), 201);
});

sidebarRoutes.patch("/api/sidebar-profiles/:id", async (c) => {
  const me = c.get("me");
  const ws = c.get("ws");
  adminOnly(me);
  const p = await getProfile(c.env, ws, c.req.param("id"));
  const body = await c.req.json<{ name?: string; hidden?: unknown; member_ids?: unknown; is_default?: boolean }>();
  const memberIds = body.member_ids === undefined ? null : await checkMemberIds(c.env, ws, body.member_ids);
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) throw badRequest("Give the profile a name");
    if (name.length > 60) throw badRequest("Keep the name under 60 characters");
    sets.push("name = ?");
    binds.push(name);
  }
  if (body.hidden !== undefined) {
    sets.push("hidden = ?");
    binds.push(JSON.stringify(itemKeys(body.hidden, "hidden")));
  }
  sets.push("updated_at = ?");
  binds.push(nowIso());
  await c.env.DB.prepare(`UPDATE sidebar_profiles SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, p.id).run();
  if (memberIds) await setProfileMembers(c.env, p.id, ws, memberIds);
  if (body.is_default !== undefined) await setDefault(c.env, ws, p.id, !!body.is_default);
  await logActivity(c.env, ws.id, c.get("actor"), "sidebar_profile", p.id, "updated", null, body);
  await changed(c.env, ws);
  return c.json((await listProfiles(c.env, ws)).find((x) => x.id === p.id));
});

sidebarRoutes.delete("/api/sidebar-profiles/:id", async (c) => {
  const me = c.get("me");
  const ws = c.get("ws");
  adminOnly(me);
  const p = await getProfile(c.env, ws, c.req.param("id"));
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE members SET sidebar_profile_id = NULL WHERE workspace_id = ? AND sidebar_profile_id = ?").bind(ws.id, p.id),
    c.env.DB.prepare("UPDATE workspaces SET default_sidebar_profile_id = NULL WHERE id = ? AND default_sidebar_profile_id = ?").bind(ws.id, p.id),
    c.env.DB.prepare("DELETE FROM sidebar_profiles WHERE id = ?").bind(p.id),
  ]);
  await logActivity(c.env, ws.id, c.get("actor"), "sidebar_profile", p.id, "deleted", { name: p.name }, null);
  await changed(c.env, ws);
  return c.json({ ok: true });
});
