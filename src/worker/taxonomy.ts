/**
 * Labels and task statuses: the workspace's own vocabulary for tasks.
 *
 * Labels: any number per task, from a workspace-wide set. Anyone (people and agents) can create one
 * and put it on tasks; admins, or whoever created a label, can rename, recolour or delete it.
 *
 * Statuses: the six built-in statuses keep their keys, because agents, automations and reports rely on
 * them (done finishes runs and posts to the feed, waiting_on_human is set by questions, ...). Admins can
 * rename, recolour and reorder them, and add custom statuses. Each custom status belongs to one built-in
 * "category" and behaves exactly like it: tasks.status holds the category, tasks.status_key the custom key.
 */
import { Hono } from "hono";
import type { Actor, MemberRow, TaskRow, TaskStatus, WorkspaceRow } from "./domain";
import { TASK_STATUSES, addSystemEntry, logActivity, notify } from "./domain";
import { type AppEnv, badRequest, forbidden, newId, notFound, nowIso } from "./util";

// ---------- Statuses ----------

export interface StatusDef {
  key: string;
  name: string;
  color: string;
  category: TaskStatus;
  builtin: boolean;
  position: number;
}

export const DEFAULT_STATUSES: StatusDef[] = [
  { key: "backlog", name: "Backlog", color: "#a3a5ab", category: "backlog", builtin: true, position: 1000 },
  { key: "todo", name: "Todo", color: "#7c7e85", category: "todo", builtin: true, position: 2000 },
  { key: "in_progress", name: "In Progress", color: "#2b6feb", category: "in_progress", builtin: true, position: 3000 },
  { key: "waiting_on_human", name: "Waiting on human", color: "#e5791d", category: "waiting_on_human", builtin: true, position: 4000 },
  { key: "done", name: "Done", color: "#1f9d5c", category: "done", builtin: true, position: 5000 },
  { key: "canceled", name: "Canceled", color: "#a3a5ab", category: "canceled", builtin: true, position: 6000 },
];

const isBuiltin = (key: string): key is TaskStatus => (TASK_STATUSES as readonly string[]).includes(key);
const HEX = /^#[0-9a-f]{6}$/i;

function cleanName(raw: unknown, what: string) {
  const name = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (!name) throw badRequest(`${what} name is required`);
  if (name.length > 40) throw badRequest(`${what} name is too long (40 characters at most)`);
  return name;
}
function cleanColor(raw: unknown, fallback: string) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw !== "string" || !HEX.test(raw)) throw badRequest("Color must look like #2b6feb");
  return raw.toLowerCase();
}

/** The workspace's statuses in display order: built-ins (with any overrides) plus custom ones. */
export async function listStatuses(env: AppEnv, workspaceId: string): Promise<StatusDef[]> {
  const rows = await env.DB.prepare("SELECT key, name, color, category, position FROM task_statuses WHERE workspace_id = ?")
    .bind(workspaceId)
    .all<{ key: string; name: string; color: string; category: TaskStatus; position: number }>();
  const byKey = new Map(rows.results.map((r) => [r.key, r]));
  const list: StatusDef[] = DEFAULT_STATUSES.map((d) => {
    const o = byKey.get(d.key);
    return o ? { ...d, name: o.name, color: o.color, position: o.position } : d;
  });
  for (const r of rows.results) if (!isBuiltin(r.key)) list.push({ ...r, builtin: false });
  return list.sort((a, b) => a.position - b.position || a.key.localeCompare(b.key));
}

/** A status by key or (case-insensitive) name. */
export async function resolveStatus(env: AppEnv, workspaceId: string, ref: string): Promise<StatusDef> {
  const all = await listStatuses(env, workspaceId);
  const r = String(ref ?? "").trim();
  const hit = all.find((s) => s.key === r) ?? all.find((s) => s.name.toLowerCase() === r.toLowerCase());
  if (!hit) throw badRequest(`Unknown status "${r}". Statuses: ${all.map((s) => s.key).join(", ")}`);
  return hit;
}

/** The status a task shows: its custom status if it has one, otherwise its built-in status. */
export const statusKeyOf = (t: Pick<TaskRow, "status" | "status_key">) => t.status_key ?? t.status;

function slug(name: string) {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 30) || "status"
  );
}

function requireAdmin(me: MemberRow) {
  if (me.kind !== "human" || me.role !== "admin") throw forbidden("Only admins can change task statuses");
}

async function upsertStatus(env: AppEnv, workspaceId: string, s: StatusDef) {
  await env.DB.prepare(
    `INSERT INTO task_statuses (workspace_id, key, name, color, category, position, created_at) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT (workspace_id, key) DO UPDATE SET name = excluded.name, color = excluded.color, position = excluded.position`,
  )
    .bind(workspaceId, s.key, s.name, s.color, s.category, s.position, nowIso())
    .run();
}

async function assertNameFree(all: StatusDef[], name: string, exceptKey?: string) {
  const clash = all.find((s) => s.key !== exceptKey && s.name.toLowerCase() === name.toLowerCase());
  if (clash) throw badRequest(`There's already a status called ${clash.name}`);
}

export async function createStatus(env: AppEnv, ws: WorkspaceRow, actor: Actor, input: { name?: unknown; color?: unknown; category?: unknown }) {
  requireAdmin(actor.member);
  const name = cleanName(input.name, "Status");
  const category = String(input.category ?? "");
  if (!isBuiltin(category)) throw badRequest(`Pick which built-in status it behaves like: ${TASK_STATUSES.join(", ")}`);
  const all = await listStatuses(env, ws.id);
  await assertNameFree(all, name);
  if (all.filter((s) => !s.builtin).length >= 30) throw badRequest("A workspace can have up to 30 custom statuses");
  let key = slug(name);
  for (let i = 2; all.some((s) => s.key === key) || isBuiltin(key); i++) key = `${slug(name)}_${i}`;
  // New statuses go right after the last status of the same category.
  const sameCat = all.filter((s) => s.category === category);
  const after = sameCat[sameCat.length - 1];
  const next = all[all.indexOf(after) + 1];
  const position = next ? (after.position + next.position) / 2 : after.position + 1000;
  const def: StatusDef = { key, name, color: cleanColor(input.color, DEFAULT_STATUSES.find((d) => d.key === category)!.color), category, builtin: false, position };
  await upsertStatus(env, ws.id, def);
  await logActivity(env, ws.id, actor, "task_status", key, "created", undefined, def);
  await notify(env, ws.id, { type: "statuses" });
  return def;
}

export async function updateStatus(env: AppEnv, ws: WorkspaceRow, actor: Actor, key: string, patch: { name?: unknown; color?: unknown }) {
  requireAdmin(actor.member);
  const all = await listStatuses(env, ws.id);
  const cur = all.find((s) => s.key === key);
  if (!cur) throw notFound("Status");
  const next = { ...cur };
  if (patch.name !== undefined) {
    next.name = cleanName(patch.name, "Status");
    await assertNameFree(all, next.name, key);
  }
  if (patch.color !== undefined) next.color = cleanColor(patch.color, cur.color);
  await upsertStatus(env, ws.id, next);
  await logActivity(env, ws.id, actor, "task_status", key, "updated", cur, next);
  await notify(env, ws.id, { type: "statuses" });
  return next;
}

export async function reorderStatuses(env: AppEnv, ws: WorkspaceRow, actor: Actor, keys: unknown) {
  requireAdmin(actor.member);
  const all = await listStatuses(env, ws.id);
  if (!Array.isArray(keys) || keys.length !== all.length || new Set(keys).size !== all.length || !all.every((s) => keys.includes(s.key))) {
    throw badRequest("Send every status key once, in the new order");
  }
  const byKey = new Map(all.map((s) => [s.key, s]));
  await env.DB.batch(
    keys.map((k: string, i: number) => {
      const s = byKey.get(k)!;
      return env.DB.prepare(
        `INSERT INTO task_statuses (workspace_id, key, name, color, category, position, created_at) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT (workspace_id, key) DO UPDATE SET position = excluded.position`,
      ).bind(ws.id, s.key, s.name, s.color, s.category, (i + 1) * 1000, nowIso());
    }),
  );
  await logActivity(env, ws.id, actor, "task_status", "order", "reordered", all.map((s) => s.key), keys);
  await notify(env, ws.id, { type: "statuses" });
  return listStatuses(env, ws.id);
}

/** Built-in statuses go back to their original name and colour; custom ones are removed. */
export async function deleteStatus(env: AppEnv, ws: WorkspaceRow, actor: Actor, key: string) {
  requireAdmin(actor.member);
  const all = await listStatuses(env, ws.id);
  const cur = all.find((s) => s.key === key);
  if (!cur) throw notFound("Status");
  if (cur.builtin) {
    const d = DEFAULT_STATUSES.find((x) => x.key === key)!;
    await env.DB.prepare("UPDATE task_statuses SET name = ?, color = ? WHERE workspace_id = ? AND key = ?").bind(d.name, d.color, ws.id, key).run();
    await logActivity(env, ws.id, actor, "task_status", key, "reset", cur, d);
    await notify(env, ws.id, { type: "statuses" });
    return { reset: true, moved: 0 };
  }
  // Its tasks fall back to the built-in status it behaves like; nothing else about them changes.
  const res = await env.DB.batch([
    env.DB.prepare("UPDATE tasks SET status_key = NULL WHERE workspace_id = ? AND status_key = ?").bind(ws.id, key),
    env.DB.prepare("DELETE FROM task_statuses WHERE workspace_id = ? AND key = ?").bind(ws.id, key),
  ]);
  const moved = res[0].meta.changes ?? 0;
  await logActivity(env, ws.id, actor, "task_status", key, "deleted", cur, { moved_to: cur.category, tasks: moved });
  await notify(env, ws.id, { type: "statuses" });
  if (moved) await notify(env, ws.id, { type: "task" });
  return { deleted: true, moved, moved_to: cur.category };
}

export async function statusCounts(env: AppEnv, workspaceId: string) {
  const r = await env.DB.prepare(
    "SELECT COALESCE(status_key, status) AS key, COUNT(*) AS n FROM tasks WHERE workspace_id = ? AND archived_at IS NULL GROUP BY 1",
  )
    .bind(workspaceId)
    .all<{ key: string; n: number }>();
  return new Map(r.results.map((x) => [x.key, x.n]));
}

// ---------- Labels ----------

export interface LabelRow {
  id: string;
  workspace_id: string;
  name: string;
  color: string;
  created_by: string | null;
  created_at: string;
}
export type LabelRef = { id: string; name: string; color: string };

export const LABEL_COLORS = ["#6b7280", "#2b6feb", "#1f9d5c", "#e5791d", "#d64545", "#8b5cf6", "#d9468f", "#0e9488", "#b7791f"];
const randomColor = () => LABEL_COLORS[Math.floor(Math.random() * LABEL_COLORS.length)];

export async function listLabels(env: AppEnv, workspaceId: string) {
  const r = await env.DB.prepare(
    `SELECT l.*, (SELECT COUNT(*) FROM task_labels tl JOIN tasks t ON t.id = tl.task_id WHERE tl.label_id = l.id AND t.archived_at IS NULL) AS task_count
     FROM labels l WHERE l.workspace_id = ? ORDER BY l.name COLLATE NOCASE`,
  )
    .bind(workspaceId)
    .all<LabelRow & { task_count: number }>();
  return r.results;
}

/** Labels of each task, for serializing task lists. */
export async function labelsByTask(env: AppEnv, workspaceId: string, taskIds: string[]) {
  const out = new Map<string, LabelRef[]>();
  if (!taskIds.length) return out;
  const r = await env.DB.prepare(
    `SELECT tl.task_id, l.id, l.name, l.color FROM task_labels tl JOIN labels l ON l.id = tl.label_id
     WHERE l.workspace_id = ? ORDER BY l.name COLLATE NOCASE`,
  )
    .bind(workspaceId)
    .all<LabelRef & { task_id: string }>();
  const wanted = new Set(taskIds);
  for (const { task_id, ...l } of r.results) {
    if (!wanted.has(task_id)) continue;
    const list = out.get(task_id) ?? [];
    list.push(l);
    out.set(task_id, list);
  }
  return out;
}

export async function createLabel(env: AppEnv, ws: WorkspaceRow, actor: Actor, input: { name?: unknown; color?: unknown }) {
  const name = cleanName(input.name, "Label");
  const clash = await env.DB.prepare("SELECT name FROM labels WHERE workspace_id = ? AND name = ? COLLATE NOCASE").bind(ws.id, name).first<{ name: string }>();
  if (clash) throw badRequest(`There's already a label called ${clash.name}`);
  const label: LabelRow = { id: newId(), workspace_id: ws.id, name, color: cleanColor(input.color, randomColor()), created_by: actor.member.id, created_at: nowIso() };
  await env.DB.prepare("INSERT INTO labels (id, workspace_id, name, color, created_by, created_at) VALUES (?,?,?,?,?,?)")
    .bind(label.id, ws.id, label.name, label.color, label.created_by, label.created_at)
    .run();
  await logActivity(env, ws.id, actor, "label", label.id, "created", undefined, label);
  await notify(env, ws.id, { type: "labels" });
  return label;
}

async function getLabel(env: AppEnv, workspaceId: string, id: string) {
  const l = await env.DB.prepare("SELECT * FROM labels WHERE id = ? AND workspace_id = ?").bind(id, workspaceId).first<LabelRow>();
  if (!l) throw notFound("Label");
  return l;
}

function requireLabelOwner(me: MemberRow, l: LabelRow, what: string) {
  if (me.role !== "admin" && l.created_by !== me.id) throw forbidden(`Only admins or whoever created this label can ${what} it`);
}

export async function updateLabel(env: AppEnv, ws: WorkspaceRow, actor: Actor, id: string, patch: { name?: unknown; color?: unknown }) {
  const l = await getLabel(env, ws.id, id);
  requireLabelOwner(actor.member, l, "change");
  const next = { ...l };
  if (patch.name !== undefined) {
    next.name = cleanName(patch.name, "Label");
    const clash = await env.DB.prepare("SELECT name FROM labels WHERE workspace_id = ? AND name = ? COLLATE NOCASE AND id != ?")
      .bind(ws.id, next.name, id)
      .first<{ name: string }>();
    if (clash) throw badRequest(`There's already a label called ${clash.name}`);
  }
  if (patch.color !== undefined) next.color = cleanColor(patch.color, l.color);
  await env.DB.prepare("UPDATE labels SET name = ?, color = ? WHERE id = ?").bind(next.name, next.color, id).run();
  await logActivity(env, ws.id, actor, "label", id, "updated", l, next);
  await notify(env, ws.id, { type: "labels" });
  return next;
}

/** Removes the label from every task too. People only (agents can't delete). */
export async function deleteLabel(env: AppEnv, ws: WorkspaceRow, actor: Actor, id: string) {
  if (actor.member.kind !== "human") throw forbidden("Agents can't delete");
  const l = await getLabel(env, ws.id, id);
  requireLabelOwner(actor.member, l, "delete");
  const res = await env.DB.batch([
    env.DB.prepare("DELETE FROM task_labels WHERE label_id = ?").bind(id),
    env.DB.prepare("DELETE FROM labels WHERE id = ?").bind(id),
  ]);
  const removed = res[0].meta.changes ?? 0;
  await logActivity(env, ws.id, actor, "label", id, "deleted", l, { tasks: removed });
  await notify(env, ws.id, { type: "labels" });
  if (removed) await notify(env, ws.id, { type: "task" });
  return { deleted: true, tasks: removed };
}

/**
 * Labels by id or (case-insensitive) name. With createMissing, unknown names become new labels;
 * otherwise they're an error.
 */
export async function resolveLabels(env: AppEnv, ws: WorkspaceRow, actor: Actor, refs: unknown, createMissing: boolean) {
  if (!Array.isArray(refs)) throw badRequest("labels must be a list of label ids or names");
  const wanted = [...new Set(refs.map((r) => String(r).trim()).filter(Boolean))];
  if (wanted.length > 20) throw badRequest("A task can have up to 20 labels");
  const all = (await env.DB.prepare("SELECT * FROM labels WHERE workspace_id = ?").bind(ws.id).all<LabelRow>()).results;
  const out: LabelRow[] = [];
  for (const ref of wanted) {
    const hit = all.find((l) => l.id === ref) ?? all.find((l) => l.name.toLowerCase() === ref.toLowerCase());
    if (hit) out.push(hit);
    else if (createMissing) {
      const l = await createLabel(env, ws, actor, { name: ref });
      all.push(l);
      out.push(l);
    } else throw badRequest(`Unknown label "${ref}"`);
  }
  return [...new Map(out.map((l) => [l.id, l])).values()];
}

/** Replace a task's labels; records what changed in the thread. */
export async function setTaskLabels(env: AppEnv, ws: WorkspaceRow, actor: Actor, task: TaskRow, labels: LabelRow[]) {
  const cur = (
    await env.DB.prepare("SELECT l.* FROM task_labels tl JOIN labels l ON l.id = tl.label_id WHERE tl.task_id = ?").bind(task.id).all<LabelRow>()
  ).results;
  const curIds = new Set(cur.map((l) => l.id));
  const nextIds = new Set(labels.map((l) => l.id));
  const added = labels.filter((l) => !curIds.has(l.id));
  const removed = cur.filter((l) => !nextIds.has(l.id));
  if (!added.length && !removed.length) return false;
  const now = nowIso();
  await env.DB.batch([
    ...removed.map((l) => env.DB.prepare("DELETE FROM task_labels WHERE task_id = ? AND label_id = ?").bind(task.id, l.id)),
    ...added.map((l) => env.DB.prepare("INSERT OR IGNORE INTO task_labels (task_id, label_id, created_at) VALUES (?,?,?)").bind(task.id, l.id, now)),
    env.DB.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").bind(now, task.id),
  ]);
  await logActivity(env, ws.id, actor, "task", task.id, "labels_changed", cur.map((l) => l.name), labels.map((l) => l.name));
  await addSystemEntry(env, task, actor.member, "labels_changed", { added: added.map((l) => l.name), removed: removed.map((l) => l.name) });
  await notify(env, ws.id, { type: "task", task_id: task.id });
  return true;
}

// ---------- Routes ----------

type Vars = { me: MemberRow; ws: WorkspaceRow; actor: Actor };
export const taxonomyRoutes = new Hono<{ Bindings: AppEnv; Variables: Vars }>();

taxonomyRoutes.get("/api/statuses", async (c) => {
  const [list, counts] = await Promise.all([listStatuses(c.env, c.get("ws").id), statusCounts(c.env, c.get("ws").id)]);
  return c.json(list.map((s) => ({ ...s, task_count: counts.get(s.key) ?? 0 })));
});
taxonomyRoutes.post("/api/statuses", async (c) => c.json(await createStatus(c.env, c.get("ws"), c.get("actor"), await c.req.json()), 201));
taxonomyRoutes.put("/api/statuses/order", async (c) => {
  const b = await c.req.json<{ keys?: unknown }>();
  return c.json(await reorderStatuses(c.env, c.get("ws"), c.get("actor"), b.keys));
});
taxonomyRoutes.patch("/api/statuses/:key", async (c) => c.json(await updateStatus(c.env, c.get("ws"), c.get("actor"), c.req.param("key"), await c.req.json())));
taxonomyRoutes.delete("/api/statuses/:key", async (c) => c.json(await deleteStatus(c.env, c.get("ws"), c.get("actor"), c.req.param("key"))));

taxonomyRoutes.get("/api/labels", async (c) => c.json(await listLabels(c.env, c.get("ws").id)));
taxonomyRoutes.post("/api/labels", async (c) => c.json(await createLabel(c.env, c.get("ws"), c.get("actor"), await c.req.json()), 201));
taxonomyRoutes.patch("/api/labels/:id", async (c) => c.json(await updateLabel(c.env, c.get("ws"), c.get("actor"), c.req.param("id"), await c.req.json())));
taxonomyRoutes.delete("/api/labels/:id", async (c) => c.json(await deleteLabel(c.env, c.get("ws"), c.get("actor"), c.req.param("id"))));
