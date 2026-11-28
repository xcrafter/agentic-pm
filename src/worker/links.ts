/**
 * Task dependencies ("blocked by") and emoji reactions on thread messages.
 *
 * A dependency says task A can't really start until task B is done. When the last open blocker of a
 * task is finished, the task gets an "unblocked" entry and, if an agent owns it and it's planned
 * (todo / in progress), that agent is woken. Dependencies never form cycles.
 *
 * Reactions: 👍 on a reply means "acknowledged". People and agents can react.
 */
import { onAgentTrigger } from "./orchestrator";
import { type Actor, type TaskRow, type WorkspaceRow, addSystemEntry, getMember, logActivity, notify, taskKey } from "./domain";
import { type AppEnv, HttpError, badRequest, notFound, nowIso } from "./util";

export const ENTRY_REACTIONS = ["👍", "🎉", "👀", "❤️"] as const;
const FINISHED = new Set(["done", "canceled"]);

export interface DepTask {
  id: string;
  key: string;
  title: string;
  status: string;
  status_key: string;
  assignee: { id: string; name: string } | null;
}

async function depRows(env: AppEnv, ws: WorkspaceRow, sql: string, id: string): Promise<DepTask[]> {
  const rows = await env.DB.prepare(sql).bind(id).all<{
    id: string;
    number: number;
    title: string;
    status: string;
    status_key: string | null;
    assignee_id: string | null;
    assignee_name: string | null;
  }>();
  return rows.results.map((r) => ({
    id: r.id,
    key: `${ws.key_prefix}-${r.number}`,
    title: r.title,
    status: r.status,
    status_key: r.status_key ?? r.status,
    assignee: r.assignee_id ? { id: r.assignee_id, name: r.assignee_name ?? "" } : null,
  }));
}

export async function dependenciesOf(env: AppEnv, ws: WorkspaceRow, taskId: string) {
  const cols = "t.id, t.number, t.title, t.status, t.status_key, t.assignee_id, m.name AS assignee_name";
  const [blocked_by, blocking] = await Promise.all([
    depRows(
      env,
      ws,
      `SELECT ${cols} FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on_id LEFT JOIN members m ON m.id = t.assignee_id WHERE d.task_id = ? ORDER BY t.number`,
      taskId,
    ),
    depRows(
      env,
      ws,
      `SELECT ${cols} FROM task_dependencies d JOIN tasks t ON t.id = d.task_id LEFT JOIN members m ON m.id = t.assignee_id WHERE d.depends_on_id = ? ORDER BY t.number`,
      taskId,
    ),
  ]);
  return {
    blocked_by,
    blocking,
    open_blockers: blocked_by.filter((t) => !FINISHED.has(t.status)).length,
  };
}

/** Would "task blocked by dependsOn" create a cycle? True if task is already (transitively) a blocker of dependsOn. */
async function wouldCycle(env: AppEnv, taskId: string, dependsOnId: string) {
  const row = await env.DB.prepare(
    `WITH RECURSIVE up(id) AS (
       SELECT depends_on_id FROM task_dependencies WHERE task_id = ?
       UNION SELECT d.depends_on_id FROM task_dependencies d JOIN up ON d.task_id = up.id
     ) SELECT 1 AS hit FROM up WHERE id = ? LIMIT 1`,
  )
    .bind(dependsOnId, taskId)
    .first();
  return !!row;
}

/** Record that `task` is blocked by `blocker`. Idempotent. */
export async function addDependency(env: AppEnv, ws: WorkspaceRow, actor: Actor, task: TaskRow, blocker: TaskRow) {
  if (task.id === blocker.id) throw badRequest("A task can't depend on itself");
  if (task.workspace_id !== ws.id || blocker.workspace_id !== ws.id) throw notFound("Task");
  if (await wouldCycle(env, task.id, blocker.id)) {
    throw new HttpError(409, `${taskKey(ws, blocker)} already depends on ${taskKey(ws, task)}, so this would be a loop`);
  }
  const res = await env.DB.prepare(
    "INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_id, created_by, created_at) VALUES (?,?,?,?)",
  )
    .bind(task.id, blocker.id, actor.member.id, nowIso())
    .run();
  if (!res.meta.changes) return false;
  await logActivity(env, ws.id, actor, "task", task.id, "dependency_added", null, { depends_on: blocker.id });
  await addSystemEntry(env, task, actor.member, "blocked_by_added", {
    key: taskKey(ws, blocker),
    title: blocker.title,
  });
  await addSystemEntry(env, blocker, actor.member, "blocks_added", {
    key: taskKey(ws, task),
    title: task.title,
  });
  await notify(env, ws.id, { type: "task", task_id: task.id });
  await notify(env, ws.id, { type: "task", task_id: blocker.id });
  return true;
}

export async function removeDependency(env: AppEnv, ws: WorkspaceRow, actor: Actor, task: TaskRow, blocker: TaskRow) {
  const res = await env.DB.prepare("DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_id = ?").bind(task.id, blocker.id).run();
  if (!res.meta.changes) return false;
  await logActivity(env, ws.id, actor, "task", task.id, "dependency_removed", { depends_on: blocker.id }, null);
  await addSystemEntry(env, task, actor.member, "blocked_by_removed", {
    key: taskKey(ws, blocker),
    title: blocker.title,
  });
  await addSystemEntry(env, blocker, actor.member, "blocks_removed", {
    key: taskKey(ws, task),
    title: task.title,
  });
  await notify(env, ws.id, { type: "task", task_id: task.id });
  await notify(env, ws.id, { type: "task", task_id: blocker.id });
  return true;
}

/** Called when `finished` moves to done/canceled: unblock dependents whose blockers are now all finished. */
export async function onBlockerFinished(env: AppEnv, ws: WorkspaceRow, actor: Actor, finished: TaskRow) {
  const dependents = await env.DB.prepare(
    `SELECT t.* FROM task_dependencies d JOIN tasks t ON t.id = d.task_id
     WHERE d.depends_on_id = ? AND t.status NOT IN ('done','canceled')
       AND NOT EXISTS (SELECT 1 FROM task_dependencies d2 JOIN tasks b ON b.id = d2.depends_on_id
                       WHERE d2.task_id = t.id AND b.status NOT IN ('done','canceled'))`,
  )
    .bind(finished.id)
    .all<TaskRow>();
  for (const t of dependents.results) {
    await addSystemEntry(env, t, actor.member, "unblocked", {
      key: taskKey(ws, finished),
      title: finished.title,
      outcome: finished.status,
    });
    if (t.assignee_id && (t.status === "todo" || t.status === "in_progress")) {
      const a = await getMember(env, t.assignee_id);
      if (a.kind === "agent" && a.active)
        await onAgentTrigger(env, {
          task: t,
          agent: a,
          trigger: "followup",
          triggeredBy: actor.member.id,
        });
    }
    await notify(env, ws.id, { type: "task", task_id: t.id });
  }
}

// ---------- Reactions ----------

export type ReactionSummary = { emoji: string; count: number; by: string[] };

export async function reactionsFor(env: AppEnv, taskId: string): Promise<Map<string, ReactionSummary[]>> {
  const rows = await env.DB.prepare(
    `SELECT r.entry_id, r.member_id, r.emoji FROM entry_reactions r JOIN thread_entries e ON e.id = r.entry_id
     WHERE e.task_id = ? ORDER BY r.created_at`,
  )
    .bind(taskId)
    .all<{ entry_id: string; member_id: string; emoji: string }>();
  const out = new Map<string, ReactionSummary[]>();
  for (const r of rows.results) {
    const list = out.get(r.entry_id) ?? [];
    let s = list.find((x) => x.emoji === r.emoji);
    if (!s) list.push((s = { emoji: r.emoji, count: 0, by: [] }));
    s.count++;
    s.by.push(r.member_id);
    out.set(r.entry_id, list);
  }
  for (const list of out.values())
    list.sort((a, b) => ENTRY_REACTIONS.indexOf(a.emoji as never) - ENTRY_REACTIONS.indexOf(b.emoji as never));
  return out;
}

/** Toggle (or force with `on`) a reaction on a thread message. Returns whether it is now on. */
export async function reactToEntry(env: AppEnv, ws: WorkspaceRow, actor: Actor, entryId: string, emoji: string, on?: boolean) {
  if (!(ENTRY_REACTIONS as readonly string[]).includes(emoji)) throw badRequest(`Reaction must be one of ${ENTRY_REACTIONS.join(" ")}`);
  const e = await env.DB.prepare(
    "SELECT e.id, e.task_id, e.type, e.data FROM thread_entries e JOIN tasks t ON t.id = e.task_id WHERE e.id = ? AND t.workspace_id = ?",
  )
    .bind(entryId, ws.id)
    .first<{ id: string; task_id: string; type: string; data: string }>();
  if (!e) throw notFound("Message");
  if (!["comment", "update", "question", "answer"].includes(e.type)) throw badRequest("You can only react to messages");
  if (JSON.parse(e.data || "{}").deleted) throw badRequest("That message was deleted");
  const had = !!(await env.DB.prepare("SELECT 1 FROM entry_reactions WHERE entry_id = ? AND member_id = ? AND emoji = ?")
    .bind(e.id, actor.member.id, emoji)
    .first());
  const want = on ?? !had;
  if (want && !had) {
    await env.DB.prepare("INSERT INTO entry_reactions (entry_id, member_id, emoji, created_at) VALUES (?,?,?,?)")
      .bind(e.id, actor.member.id, emoji, nowIso())
      .run();
  } else if (!want && had) {
    await env.DB.prepare("DELETE FROM entry_reactions WHERE entry_id = ? AND member_id = ? AND emoji = ?")
      .bind(e.id, actor.member.id, emoji)
      .run();
  }
  if (want !== had) await notify(env, ws.id, { type: "thread", task_id: e.task_id });
  return { entry_id: e.id, emoji, on: want };
}
