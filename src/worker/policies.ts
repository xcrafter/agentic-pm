/**
 * Policies: the workspace's operating manual — SOPs, policies, strategies, structure — as documents in
 * folders. Agents are told which policies apply to them when they're woken, can search and read them over
 * MCP, and "required" policies must be read (latest version) before an agent may change anything on tasks.
 */
import { Hono } from "hono";
import type { Actor, MemberRow, TaskRow, WorkspaceRow } from "./domain";
import { logActivity, notify } from "./domain";
import { type AppEnv, HttpError, badRequest, forbidden, newId, notFound, nowIso, parseJson } from "./util";

type Vars = { me: MemberRow; ws: WorkspaceRow; actor: Actor };

export type Audience = "all" | "agents" | "reference";
export interface PolicyRow {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  kind: "folder" | "doc";
  title: string;
  content: string;
  summary: string;
  audience: Audience;
  agent_ids: string;
  project_ids: string;
  required: number;
  version: number;
  position: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

const MAX_CONTENT = 200_000;
const MAX_ITEMS = 1000;

const base = (env: AppEnv) => env.PUBLIC_URL.replace(/\/$/, "");
export const policyUrl = (env: AppEnv, id: string) => `${base(env)}/policies/${id}`;

async function allPolicies(env: AppEnv, wsId: string) {
  const rows = await env.DB.prepare("SELECT * FROM policies WHERE workspace_id = ? ORDER BY position, created_at").bind(wsId).all<PolicyRow>();
  return rows.results;
}

function pathOf(p: PolicyRow, byId: Map<string, PolicyRow>) {
  const parts: string[] = [];
  let cur: PolicyRow | undefined = p;
  for (let i = 0; cur && i < 20; i++) {
    parts.unshift(cur.title);
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
  }
  return parts.join(" / ");
}

function meta(p: PolicyRow) {
  const { content, agent_ids, project_ids, ...rest } = p;
  return { ...rest, agent_ids: parseJson<string[]>(agent_ids, []), project_ids: parseJson<string[]>(project_ids, []), required: !!p.required };
}

/** Does this doc apply to `agent` working on `task` (or on no particular task)? */
function appliesTo(p: PolicyRow, agent: MemberRow, task?: Pick<TaskRow, "project_id"> | null) {
  if (p.kind !== "doc" || p.audience === "reference") return false;
  if (p.audience === "agents" && !parseJson<string[]>(p.agent_ids, []).includes(agent.id)) return false;
  const projects = parseJson<string[]>(p.project_ids, []);
  if (projects.length && !(task?.project_id && projects.includes(task.project_id))) return false;
  return true;
}

/** Policies that apply to an agent (optionally for a task), with whether it has read the latest version. */
export async function policiesFor(env: AppEnv, wsId: string, agent: MemberRow, task?: Pick<TaskRow, "project_id"> | null) {
  const all = await allPolicies(env, wsId);
  const byId = new Map(all.map((p) => [p.id, p]));
  const mine = all.filter((p) => appliesTo(p, agent, task));
  if (!mine.length) return [];
  const reads = await env.DB.prepare("SELECT policy_id, version FROM policy_reads WHERE member_id = ?").bind(agent.id).all<{ policy_id: string; version: number }>();
  const readV = new Map(reads.results.map((r) => [r.policy_id, r.version]));
  return mine.map((p) => ({
    id: p.id,
    title: p.title,
    path: pathOf(p, byId),
    summary: p.summary,
    required: !!p.required,
    version: p.version,
    read_latest: (readV.get(p.id) ?? 0) >= p.version,
    url: policyUrl(env, p.id),
  }));
}

/**
 * Agents working over MCP must have read every required policy that applies to them (latest version)
 * before they change anything. Throws a 412 that tells the agent exactly what to read.
 */
export async function assertPoliciesRead(env: AppEnv, ws: Pick<WorkspaceRow, "id">, actor: Actor, task?: Pick<TaskRow, "project_id"> | null) {
  if (actor.via !== "mcp" || actor.member.kind !== "agent") return;
  const missing = (await policiesFor(env, ws.id, actor.member, task)).filter((p) => p.required && !p.read_latest);
  if (!missing.length) return;
  throw new HttpError(
    412,
    `Before working, read the workspace policies that apply to you (${missing.length === 1 ? "it is" : "they are"} required, and may have changed): ` +
      missing.map((p) => `"${p.path}" (get_policy id ${p.id})`).join(", ") +
      ". Call get_policy for each, follow them, then retry.",
  );
}

export async function markPolicyRead(env: AppEnv, member: MemberRow, p: PolicyRow) {
  await env.DB.prepare(
    "INSERT INTO policy_reads (member_id, policy_id, version, read_at) VALUES (?,?,?,?) ON CONFLICT(member_id, policy_id) DO UPDATE SET version = excluded.version, read_at = excluded.read_at",
  )
    .bind(member.id, p.id, p.version, nowIso())
    .run();
}

/** Find a policy by id, or by exact path/title (case-insensitive). */
export async function findPolicy(env: AppEnv, wsId: string, ref: string): Promise<PolicyRow> {
  const byIdRow = await env.DB.prepare("SELECT * FROM policies WHERE id = ? AND workspace_id = ?").bind(ref, wsId).first<PolicyRow>();
  if (byIdRow) return byIdRow;
  const all = await allPolicies(env, wsId);
  const byId = new Map(all.map((p) => [p.id, p]));
  const want = ref.trim().toLowerCase();
  const hit =
    all.find((p) => pathOf(p, byId).toLowerCase() === want) ??
    all.find((p) => p.kind === "doc" && p.title.toLowerCase() === want);
  if (!hit) throw notFound("Policy");
  return hit;
}

/** Tree listing for agents: every doc's path and summary, plus whether it applies to them. */
export async function listPoliciesForAgent(env: AppEnv, wsId: string, agent: MemberRow, query?: string) {
  const all = await allPolicies(env, wsId);
  const byId = new Map(all.map((p) => [p.id, p]));
  const applies = new Map((await policiesFor(env, wsId, agent)).map((p) => [p.id, p]));
  const q = query?.trim().toLowerCase();
  return all
    .filter((p) => p.kind === "doc")
    .filter((p) => !q || `${p.title} ${p.summary} ${p.content}`.toLowerCase().includes(q))
    .map((p) => ({
      id: p.id,
      path: pathOf(p, byId),
      summary: p.summary,
      applies_to_you: applies.has(p.id) || undefined,
      required: (applies.has(p.id) && !!p.required) || undefined,
      read_latest: applies.has(p.id) ? applies.get(p.id)!.read_latest : undefined,
    }))
    .sort((a, b) => Number(!!b.applies_to_you) - Number(!!a.applies_to_you) || a.path.localeCompare(b.path));
}

export function policyForAgent(env: AppEnv, p: PolicyRow, all: PolicyRow[]) {
  const byId = new Map(all.map((x) => [x.id, x]));
  return {
    id: p.id,
    path: pathOf(p, byId),
    title: p.title,
    summary: p.summary,
    version: p.version,
    updated_at: p.updated_at,
    url: policyUrl(env, p.id),
    content: p.content,
  };
}

// ---------- Routes (signed-in people) ----------

export const policyRoutes = new Hono<{ Bindings: AppEnv; Variables: Vars }>();

async function getOwn(env: AppEnv, wsId: string, id: string) {
  const p = await env.DB.prepare("SELECT * FROM policies WHERE id = ? AND workspace_id = ?").bind(id, wsId).first<PolicyRow>();
  if (!p) throw notFound("Policy");
  return p;
}

async function checkParent(env: AppEnv, wsId: string, parentId: string | null, selfId?: string) {
  if (!parentId) return null;
  const parent = await getOwn(env, wsId, parentId);
  if (parent.kind !== "folder") throw badRequest("Pick a folder to put this in");
  if (selfId) {
    // No moving a folder into itself or one of its own subfolders.
    const all = await allPolicies(env, wsId);
    const byId = new Map(all.map((p) => [p.id, p]));
    for (let cur: PolicyRow | undefined = parent, i = 0; cur && i < 50; cur = cur.parent_id ? byId.get(cur.parent_id) : undefined, i++) {
      if (cur.id === selfId) throw badRequest("A folder can't go inside itself");
    }
  }
  return parent;
}

const ids = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string"))].slice(0, 200) : undefined);

policyRoutes.get("/api/policies", async (c) => {
  const ws = c.get("ws");
  const all = await allPolicies(c.env, ws.id);
  return c.json(all.map(meta));
});

policyRoutes.get("/api/policies/:id", async (c) => {
  const ws = c.get("ws");
  const p = await getOwn(c.env, ws.id, c.req.param("id"));
  const [reads, revisions] = await Promise.all([
    c.env.DB.prepare("SELECT member_id, version, read_at FROM policy_reads WHERE policy_id = ? ORDER BY read_at DESC").bind(p.id).all(),
    c.env.DB.prepare("SELECT id, version, title, author_id, created_at FROM policy_revisions WHERE policy_id = ? ORDER BY version DESC LIMIT 50").bind(p.id).all(),
  ]);
  const all = await allPolicies(c.env, ws.id);
  const byId = new Map(all.map((x) => [x.id, x]));
  return c.json({ ...meta(p), content: p.content, path: pathOf(p, byId), reads: reads.results, revisions: revisions.results });
});

policyRoutes.get("/api/policy-revisions/:id", async (c) => {
  const r = await c.env.DB.prepare(
    "SELECT r.* FROM policy_revisions r JOIN policies p ON p.id = r.policy_id WHERE r.id = ? AND p.workspace_id = ?",
  )
    .bind(c.req.param("id"), c.get("ws").id)
    .first();
  if (!r) throw notFound("Revision");
  return c.json(r);
});

policyRoutes.post("/api/policies", async (c) => {
  const ws = c.get("ws");
  const me = c.get("me");
  const b = await c.req.json<{ kind?: string; title?: string; parent_id?: string | null; content?: string }>();
  const kind = b.kind === "folder" ? "folder" : "doc";
  const title = (b.title ?? "").trim() || (kind === "folder" ? "New folder" : "Untitled");
  if (title.length > 120) throw badRequest("Keep the title under 120 characters");
  const content = String(b.content ?? "");
  if (content.length > MAX_CONTENT) throw badRequest("This document is too long");
  await checkParent(c.env, ws.id, b.parent_id ?? null);
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM policies WHERE workspace_id = ?").bind(ws.id).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_ITEMS) throw badRequest(`This workspace already has ${MAX_ITEMS} policies and folders`);
  const id = newId();
  const now = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO policies (id, workspace_id, parent_id, kind, title, content, position, created_by, updated_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(id, ws.id, b.parent_id ?? null, kind, title, content, Date.now(), me.id, me.id, now, now)
    .run();
  await logActivity(c.env, ws.id, c.get("actor"), "policy", id, "created", undefined, { kind, title });
  await notify(c.env, ws.id, { type: "policies" });
  return c.json(meta(await getOwn(c.env, ws.id, id)), 201);
});

policyRoutes.patch("/api/policies/:id", async (c) => {
  const ws = c.get("ws");
  const me = c.get("me");
  const p = await getOwn(c.env, ws.id, c.req.param("id"));
  const b = await c.req.json<Record<string, unknown>>();
  const next = { ...p };
  if (typeof b.title === "string") {
    const t = b.title.trim();
    if (!t || t.length > 120) throw badRequest("Give it a title (up to 120 characters)");
    next.title = t;
  }
  if (typeof b.content === "string") {
    if (b.content.length > MAX_CONTENT) throw badRequest("This document is too long");
    next.content = b.content;
  }
  if (typeof b.summary === "string") next.summary = b.summary.trim().slice(0, 300);
  if (b.audience === "all" || b.audience === "agents" || b.audience === "reference") next.audience = b.audience;
  const a = ids(b.agent_ids);
  if (a) next.agent_ids = JSON.stringify(a);
  const pr = ids(b.project_ids);
  if (pr) next.project_ids = JSON.stringify(pr);
  if (typeof b.required === "boolean") next.required = b.required ? 1 : 0;
  if (typeof b.position === "number" && Number.isFinite(b.position)) next.position = b.position;
  if (b.parent_id !== undefined) {
    const parentId = (b.parent_id as string | null) || null;
    await checkParent(c.env, ws.id, parentId, p.id);
    next.parent_id = parentId;
  }
  const changedText = next.title !== p.title || next.content !== p.content;
  if (changedText && p.kind === "doc") next.version = p.version + 1;
  const now = nowIso();
  const stmts = [
    c.env.DB.prepare(
      `UPDATE policies SET parent_id = ?, title = ?, content = ?, summary = ?, audience = ?, agent_ids = ?, project_ids = ?, required = ?,
       version = ?, position = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
    ).bind(next.parent_id, next.title, next.content, next.summary, next.audience, next.agent_ids, next.project_ids, next.required, next.version, next.position, me.id, now, p.id),
  ];
  if (changedText && p.kind === "doc") {
    // Keep the version being replaced so changes can be reviewed.
    stmts.push(
      c.env.DB.prepare("INSERT INTO policy_revisions (id, policy_id, version, title, content, author_id, created_at) VALUES (?,?,?,?,?,?,?)").bind(
        newId(),
        p.id,
        p.version,
        p.title,
        p.content,
        p.updated_by,
        p.updated_at,
      ),
    );
  }
  await c.env.DB.batch(stmts);
  const settings = ["audience", "agent_ids", "project_ids", "required", "parent_id"] as const;
  const changedSettings = settings.filter((k) => next[k] !== p[k]);
  if (changedText || changedSettings.length) {
    await logActivity(c.env, ws.id, c.get("actor"), "policy", p.id, "updated", undefined, { version: next.version, changed: [...(changedText ? ["text"] : []), ...changedSettings] });
  }
  await notify(c.env, ws.id, { type: "policies" });
  return c.json({ ...meta(await getOwn(c.env, ws.id, p.id)), content: next.content });
});

policyRoutes.delete("/api/policies/:id", async (c) => {
  const ws = c.get("ws");
  const me = c.get("me");
  const p = await getOwn(c.env, ws.id, c.req.param("id"));
  if (me.role !== "admin" && p.created_by !== me.id) throw forbidden("Only admins or whoever created this can delete it");
  // Collect the item and everything inside it.
  const all = await allPolicies(c.env, ws.id);
  const doomed = new Set([p.id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const x of all) if (x.parent_id && doomed.has(x.parent_id) && !doomed.has(x.id)) (doomed.add(x.id), (grew = true));
  }
  if (me.role !== "admin" && all.some((x) => doomed.has(x.id) && x.created_by !== me.id)) {
    throw forbidden("This folder holds documents other people wrote; ask an admin to delete it");
  }
  const list = [...doomed];
  const marks = list.map(() => "?").join(",");
  // Children before parents (parent_id references).
  const ordered = list.sort((a, b) => depth(b) - depth(a));
  function depth(id: string) {
    let d = 0;
    for (let cur = all.find((x) => x.id === id); cur?.parent_id && d < 50; cur = all.find((x) => x.id === cur!.parent_id)) d++;
    return d;
  }
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM policy_reads WHERE policy_id IN (${marks})`).bind(...list),
    c.env.DB.prepare(`DELETE FROM policy_revisions WHERE policy_id IN (${marks})`).bind(...list),
    ...ordered.map((id) => c.env.DB.prepare("DELETE FROM policies WHERE id = ?").bind(id)),
  ]);
  await logActivity(c.env, ws.id, c.get("actor"), "policy", p.id, "deleted", { title: p.title, kind: p.kind, content: p.content }, { removed: list.length });
  await notify(c.env, ws.id, { type: "policies" });
  return c.json({ ok: true, removed: list.length });
});
