/**
 * Core domain logic shared by the web API and the MCP server.
 * Every mutation goes through here so activity logging, thread system entries,
 * realtime notifications and agent wake-ups happen consistently.
 */
import { type AppEnv, HttpError, badRequest, forbidden, newId, notFound, nowIso, parseJson } from "./util";
import { onAgentTrigger, touchRun, endRunsFor } from "./orchestrator";
import { canWake } from "./agents";
import { postTaskCompleted } from "./feed";
import { ideasLiveForTask } from "./ideas";
import { addDependency, dependenciesOf, onBlockerFinished, reactionsFor } from "./links";

// ---------- Types ----------

export type MemberKind = "human" | "agent";
export interface MemberRow {
  id: string;
  workspace_id: string;
  kind: MemberKind;
  name: string;
  handle: string;
  avatar_url: string | null;
  role: "admin" | "member";
  active: number;
  email: string | null;
  google_sub: string | null;
  description: string | null;
  webhook_url: string | null;
  webhook_key_encrypted: string | null;
  wake_on_mention: number;
  max_runs_per_hour: number;
  password_hash: string | null;
  created_by: string | null;
  created_at: string;
}

export interface WorkspaceRow {
  id: string;
  name: string;
  key_prefix: string;
  next_task_number: number;
  created_at: string;
  website: string | null;
  logo_key: string | null;
  logo_updated_at: string | null;
  allowed_domains: string | null;
  pm_agent_id: string | null;
  pm_triage: number;
  link_previews: "off" | "title" | "full";
}

export const TASK_STATUSES = ["backlog", "todo", "in_progress", "waiting_on_human", "done", "canceled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];

export interface TaskRow {
  id: string;
  workspace_id: string;
  number: number;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  assignee_id: string | null;
  project_id: string | null;
  due_date: string | null;
  position: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface ProjectRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  lead_member_id: string | null;
  status: "active" | "archived";
  created_by: string;
  created_at: string;
}

export type EntryType =
  | "comment"
  | "update"
  | "question"
  | "answer"
  | "note_created"
  | "checklist_created"
  | "attachment_added"
  | "system";

export interface EntryRow {
  id: string;
  task_id: string;
  author_id: string;
  type: EntryType;
  body: string;
  data: string;
  reply_to_id: string | null;
  created_at: string;
  edited_at: string | null;
}

export interface Actor {
  member: MemberRow;
  via: "web" | "mcp" | "system";
}

// ---------- Small helpers ----------

export async function getWorkspace(env: AppEnv, id: string): Promise<WorkspaceRow> {
  const ws = await env.DB.prepare("SELECT * FROM workspaces WHERE id = ?").bind(id).first<WorkspaceRow>();
  if (!ws) throw notFound("Workspace");
  return ws;
}

/** Single-workspace v1: the first (and only) workspace, created on demand. */
export async function ensureWorkspace(env: AppEnv): Promise<WorkspaceRow> {
  const ws = await env.DB.prepare("SELECT * FROM workspaces ORDER BY created_at LIMIT 1").first<WorkspaceRow>();
  if (ws) return ws;
  const row: WorkspaceRow = {
    id: newId(),
    name: env.WORKSPACE_NAME || "Workspace",
    key_prefix: (env.WORKSPACE_KEY || "TASK").toUpperCase(),
    next_task_number: 1,
    created_at: nowIso(),
    website: null,
    logo_key: null,
    logo_updated_at: null,
    allowed_domains: null,
    pm_agent_id: null,
    link_previews: "off",
    pm_triage: 0, // opt-in: the PM stays idle unless an agent is assigned or @mentioned
  };
  await env.DB.prepare("INSERT INTO workspaces (id, name, key_prefix, next_task_number, created_at, pm_triage) VALUES (?,?,?,?,?,0)")
    .bind(row.id, row.name, row.key_prefix, 1, row.created_at)
    .run();
  return row;
}

export async function getMember(env: AppEnv, id: string): Promise<MemberRow> {
  const m = await env.DB.prepare("SELECT * FROM members WHERE id = ?").bind(id).first<MemberRow>();
  if (!m) throw notFound("Member");
  return m;
}

export async function findMemberByRef(env: AppEnv, workspaceId: string, ref: string): Promise<MemberRow> {
  const handle = ref.replace(/^@/, "").toLowerCase();
  const m = await env.DB.prepare("SELECT * FROM members WHERE workspace_id = ? AND (id = ? OR handle = ? OR email = ?)")
    .bind(workspaceId, ref, handle, ref.toLowerCase())
    .first<MemberRow>();
  if (!m) throw notFound(`Member "${ref}"`);
  return m;
}

export function publicMember(m: MemberRow) {
  return {
    id: m.id,
    kind: m.kind,
    name: m.name,
    handle: m.handle,
    avatar_url: m.avatar_url,
    role: m.role,
    active: !!m.active,
    email: m.email,
    description: m.description,
    has_webhook: !!m.webhook_url,
    webhook_url: m.webhook_url,
    wake_on_mention: !!m.wake_on_mention,
    max_runs_per_hour: m.max_runs_per_hour,
    created_by: m.created_by ?? null,
    created_at: m.created_at,
  };
}
export type PublicMember = ReturnType<typeof publicMember>;

export async function logActivity(
  env: AppEnv,
  workspaceId: string,
  actor: Actor | null,
  entityType: string,
  entityId: string,
  action: string,
  before?: unknown,
  after?: unknown,
) {
  await env.DB.prepare(
    "INSERT INTO activity (id, workspace_id, actor_id, via, entity_type, entity_id, action, before, after, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      newId(),
      workspaceId,
      actor?.member.id ?? null,
      actor?.via ?? "system",
      entityType,
      entityId,
      action,
      before === undefined ? null : JSON.stringify(before),
      after === undefined ? null : JSON.stringify(after),
      nowIso(),
    )
    .run();
}

export async function notify(env: AppEnv, workspaceId: string, event: Record<string, unknown>) {
  try {
    const stub = env.REALTIME.get(env.REALTIME.idFromName(workspaceId));
    await stub.fetch("https://realtime/broadcast", { method: "POST", body: JSON.stringify(event) });
  } catch (err) {
    console.error("realtime notify failed", err);
  }
}

// ---------- Tasks ----------

export function taskKey(ws: WorkspaceRow, t: TaskRow) {
  return `${ws.key_prefix}-${t.number}`;
}

export async function getTaskByRef(env: AppEnv, workspaceId: string, ref: string): Promise<TaskRow> {
  const m = /^[A-Za-z]+-(\d+)$/.exec(ref.trim());
  const t = m
    ? await env.DB.prepare("SELECT * FROM tasks WHERE workspace_id = ? AND number = ?")
        .bind(workspaceId, Number(m[1]))
        .first<TaskRow>()
    : await env.DB.prepare("SELECT * FROM tasks WHERE workspace_id = ? AND id = ?").bind(workspaceId, ref).first<TaskRow>();
  if (!t) throw notFound(`Task "${ref}"`);
  return t;
}

export interface TaskFilters {
  status?: string[];
  assigneeId?: string;
  projectId?: string;
  memberKind?: MemberKind;
  query?: string;
  limit?: number;
}

export async function listTasks(env: AppEnv, workspaceId: string, f: TaskFilters = {}) {
  const where = ["t.workspace_id = ?"];
  const binds: unknown[] = [workspaceId];
  if (f.status?.length) {
    where.push(`t.status IN (${f.status.map(() => "?").join(",")})`);
    binds.push(...f.status);
  }
  if (f.assigneeId === "none") where.push("t.assignee_id IS NULL");
  else if (f.assigneeId) {
    where.push("t.assignee_id = ?");
    binds.push(f.assigneeId);
  }
  if (f.projectId === "none") where.push("t.project_id IS NULL");
  else if (f.projectId) {
    where.push("t.project_id = ?");
    binds.push(f.projectId);
  }
  if (f.memberKind) {
    where.push("m.kind = ?");
    binds.push(f.memberKind);
  }
  if (f.query) {
    const num = /^(?:[A-Za-z]+-)?(\d+)$/.exec(f.query.trim());
    where.push(`(t.title LIKE ? OR t.description LIKE ?${num ? " OR t.number = ?" : ""})`);
    binds.push(`%${f.query}%`, `%${f.query}%`, ...(num ? [Number(num[1])] : []));
  }
  const limit = Math.min(f.limit ?? 500, 1000);
  const rows = await env.DB.prepare(
    `SELECT t.* FROM tasks t LEFT JOIN members m ON m.id = t.assignee_id
     WHERE ${where.join(" AND ")} ORDER BY t.position ASC, t.number DESC LIMIT ${limit}`,
  )
    .bind(...binds)
    .all<TaskRow>();
  return rows.results;
}

export async function serializeTasks(env: AppEnv, ws: WorkspaceRow, tasks: TaskRow[]) {
  if (!tasks.length) return [];
  const [members, projects, openQs, runs, blockers] = await Promise.all([
    env.DB.prepare("SELECT * FROM members WHERE workspace_id = ?").bind(ws.id).all<MemberRow>(),
    env.DB.prepare("SELECT id, name FROM projects WHERE workspace_id = ?").bind(ws.id).all<{ id: string; name: string }>(),
    env.DB.prepare(
      `SELECT e.task_id, COUNT(*) AS n FROM thread_entries e JOIN tasks t ON t.id = e.task_id
       WHERE t.workspace_id = ? AND e.type = 'question' AND json_extract(e.data, '$.state') = 'open' GROUP BY e.task_id`,
    )
      .bind(ws.id)
      .all<{ task_id: string; n: number }>(),
    env.DB.prepare(
      `SELECT r.task_id, r.status FROM agent_runs r JOIN tasks t ON t.id = r.task_id
       WHERE t.workspace_id = ? AND r.status IN ('queued','dispatched','active','failed','stale') AND r.dismissed = 0`,
    )
      .bind(ws.id)
      .all<{ task_id: string; status: string }>(),
    env.DB.prepare(
      `SELECT d.task_id, COUNT(*) AS n FROM task_dependencies d JOIN tasks b ON b.id = d.depends_on_id
       WHERE b.workspace_id = ? AND b.status NOT IN ('done','canceled') GROUP BY d.task_id`,
    )
      .bind(ws.id)
      .all<{ task_id: string; n: number }>(),
  ]);
  const blockedByTask = new Map(blockers.results.map((b) => [b.task_id, b.n]));
  const mById = new Map(members.results.map((m) => [m.id, m]));
  const pById = new Map(projects.results.map((p) => [p.id, p]));
  const qByTask = new Map(openQs.results.map((q) => [q.task_id, q.n]));
  const runByTask = new Map<string, string>();
  for (const r of runs.results) {
    const prev = runByTask.get(r.task_id);
    // Problems win over in-flight states for display.
    if (!prev || r.status === "failed" || r.status === "stale") runByTask.set(r.task_id, r.status);
  }
  return tasks.map((t) => {
    const a = t.assignee_id ? mById.get(t.assignee_id) : undefined;
    const p = t.project_id ? pById.get(t.project_id) : undefined;
    return {
      id: t.id,
      key: taskKey(ws, t),
      number: t.number,
      title: t.title,
      description: t.description,
      status: t.status,
      priority: t.priority,
      due_date: t.due_date,
      position: t.position,
      assignee: a ? { id: a.id, name: a.name, handle: a.handle, kind: a.kind, avatar_url: a.avatar_url } : null,
      project: p ? { id: p.id, name: p.name } : null,
      created_by: t.created_by,
      created_at: t.created_at,
      updated_at: t.updated_at,
      completed_at: t.completed_at,
      open_questions: qByTask.get(t.id) ?? 0,
      run_status: runByTask.get(t.id) ?? null,
      open_blockers: blockedByTask.get(t.id) ?? 0,
    };
  });
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: Priority;
  assigneeId?: string | null;
  projectId?: string | null;
  dueDate?: string | null;
  /** Ask the workspace PM to pick an assignee (only when there's none). Defaults to the workspace setting. */
  triage?: boolean;
  /** Task keys or ids this new task is blocked by. */
  blockedBy?: string[];
}

export async function createTask(env: AppEnv, ws: WorkspaceRow, actor: Actor, input: CreateTaskInput): Promise<TaskRow> {
  const title = input.title?.trim();
  if (!title) throw badRequest("Title is required");
  if (input.status && !TASK_STATUSES.includes(input.status)) throw badRequest("Invalid status");
  if (input.priority && !PRIORITIES.includes(input.priority)) throw badRequest("Invalid priority");
  if (input.assigneeId) await assertMemberInWorkspace(env, ws.id, input.assigneeId);
  if (input.projectId) await assertProjectInWorkspace(env, ws.id, input.projectId);
  const blockers = await Promise.all([...new Set(input.blockedBy ?? [])].slice(0, 20).map((r) => getTaskByRef(env, ws.id, r)));

  const numRow = await env.DB.prepare(
    "UPDATE workspaces SET next_task_number = next_task_number + 1 WHERE id = ? RETURNING next_task_number - 1 AS n",
  )
    .bind(ws.id)
    .first<{ n: number }>();
  const now = nowIso();
  const task: TaskRow = {
    id: newId(),
    workspace_id: ws.id,
    number: numRow!.n,
    title,
    description: input.description ?? "",
    status: input.status ?? "todo",
    priority: input.priority ?? "none",
    assignee_id: input.assigneeId ?? null,
    project_id: input.projectId ?? null,
    due_date: input.dueDate ?? null,
    position: Date.now(),
    created_by: actor.member.id,
    created_at: now,
    updated_at: now,
    completed_at: null,
  };
  await env.DB.prepare(
    `INSERT INTO tasks (id, workspace_id, number, title, description, status, priority, assignee_id, project_id, due_date, position, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      task.id,
      ws.id,
      task.number,
      task.title,
      task.description,
      task.status,
      task.priority,
      task.assignee_id,
      task.project_id,
      task.due_date,
      task.position,
      task.created_by,
      now,
      now,
    )
    .run();
  await logActivity(env, ws.id, actor, "task", task.id, "created", undefined, task);
  await addSystemEntry(env, task, actor.member, "created", {});
  for (const b of blockers) await addDependency(env, ws, actor, task, b);
  if (task.assignee_id) {
    const assignee = await getMember(env, task.assignee_id);
    await addSystemEntry(env, task, actor.member, "assigned", { to: assignee.id, to_name: assignee.name });
    if (canWake(actor, assignee, ws)) {
      await onAgentTrigger(env, { task, agent: assignee, trigger: "assigned", triggeredBy: actor.member.id });
    }
  } else if (actor.member.kind === "human" && ws.pm_agent_id && (input.triage ?? !!ws.pm_triage)) {
    // No assignee: let the workspace PM agent pick the right agent (or person) for it.
    const pm = await env.DB.prepare("SELECT * FROM members WHERE id = ? AND kind = 'agent' AND active = 1").bind(ws.pm_agent_id).first<MemberRow>();
    if (pm) await onAgentTrigger(env, { task, agent: pm, trigger: "triage", triggeredBy: actor.member.id });
  }
  await notify(env, ws.id, { type: "task", task_id: task.id });
  return task;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: Priority;
  assigneeId?: string | null;
  projectId?: string | null;
  dueDate?: string | null;
  position?: number;
  /** Shown in the automatic feed post when this change completes the task. */
  summary?: string;
}

export async function updateTask(
  env: AppEnv,
  ws: WorkspaceRow,
  actor: Actor,
  task: TaskRow,
  patch: UpdateTaskInput,
): Promise<TaskRow> {
  const next: TaskRow = { ...task };
  const changes: { field: string; from: unknown; to: unknown }[] = [];

  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) throw badRequest("Title cannot be empty");
    if (title !== task.title) {
      next.title = title;
      changes.push({ field: "title", from: task.title, to: title });
    }
  }
  if (patch.description !== undefined && patch.description !== task.description) {
    next.description = patch.description;
    changes.push({ field: "description", from: null, to: null });
  }
  if (patch.status !== undefined && patch.status !== task.status) {
    if (!TASK_STATUSES.includes(patch.status)) throw badRequest("Invalid status");
    next.status = patch.status;
    next.completed_at = patch.status === "done" ? nowIso() : null;
    changes.push({ field: "status", from: task.status, to: patch.status });
  }
  if (patch.priority !== undefined && patch.priority !== task.priority) {
    if (!PRIORITIES.includes(patch.priority)) throw badRequest("Invalid priority");
    next.priority = patch.priority;
    changes.push({ field: "priority", from: task.priority, to: patch.priority });
  }
  if (patch.assigneeId !== undefined && patch.assigneeId !== task.assignee_id) {
    if (patch.assigneeId) await assertMemberInWorkspace(env, ws.id, patch.assigneeId);
    next.assignee_id = patch.assigneeId;
    changes.push({ field: "assignee", from: task.assignee_id, to: patch.assigneeId });
  }
  if (patch.projectId !== undefined && patch.projectId !== task.project_id) {
    if (patch.projectId) await assertProjectInWorkspace(env, ws.id, patch.projectId);
    next.project_id = patch.projectId;
    changes.push({ field: "project", from: task.project_id, to: patch.projectId });
  }
  if (patch.dueDate !== undefined && patch.dueDate !== task.due_date) {
    next.due_date = patch.dueDate;
    changes.push({ field: "due_date", from: task.due_date, to: patch.dueDate });
  }
  const positionChanged = patch.position !== undefined && patch.position !== task.position;
  if (positionChanged) next.position = patch.position!;

  if (!changes.length && !positionChanged) return task;
  next.updated_at = nowIso();

  await env.DB.prepare(
    `UPDATE tasks SET title=?, description=?, status=?, priority=?, assignee_id=?, project_id=?, due_date=?, position=?, updated_at=?, completed_at=? WHERE id=?`,
  )
    .bind(
      next.title,
      next.description,
      next.status,
      next.priority,
      next.assignee_id,
      next.project_id,
      next.due_date,
      next.position,
      next.updated_at,
      next.completed_at,
      task.id,
    )
    .run();

  if (changes.length) {
    await logActivity(env, ws.id, actor, "task", task.id, "updated", task, next);
    for (const c of changes) {
      if (c.field === "description") continue;
      if (c.field === "assignee") {
        const to = c.to ? await getMember(env, c.to as string) : null;
        await addSystemEntry(env, next, actor.member, to ? "assigned" : "unassigned", {
          from: c.from,
          to: to?.id ?? null,
          to_name: to?.name ?? null,
        });
      } else if (c.field === "project") {
        const p = c.to
          ? await env.DB.prepare("SELECT name FROM projects WHERE id = ?").bind(c.to).first<{ name: string }>()
          : null;
        await addSystemEntry(env, next, actor.member, "project_changed", { to: c.to, to_name: p?.name ?? null });
      } else {
        await addSystemEntry(env, next, actor.member, `${c.field}_changed`, { from: c.from, to: c.to });
      }
    }
  }

  // Wake a newly assigned agent (humans wake any agent; an orchestrator only its own sub-agents: loop guard).
  const assigneeChange = changes.find((c) => c.field === "assignee");
  if (assigneeChange) {
    if (assigneeChange.from) {
      const prev = await getMember(env, assigneeChange.from as string);
      if (prev.kind === "agent") await endRunsFor(env, task.id, prev.id, "unassigned");
    }
    // An agent handing the task to someone else (e.g. the PM assigning it) is done with it.
    if (actor.member.kind === "agent" && assigneeChange.to !== actor.member.id && assigneeChange.from !== actor.member.id) {
      await endRunsFor(env, task.id, actor.member.id, "unassigned");
    }
    if (assigneeChange.to) {
      const agent = await getMember(env, assigneeChange.to as string);
      if (canWake(actor, agent, ws)) {
        await onAgentTrigger(env, { task: next, agent, trigger: "assigned", triggeredBy: actor.member.id });
      }
    }
  }
  // Finished or canceled (by anyone): close every open agent run so nothing shows as working or gone quiet.
  const statusChange = changes.find((c) => c.field === "status");
  if (statusChange && (statusChange.to === "done" || statusChange.to === "canceled")) {
    const open = await env.DB.prepare(
      "SELECT DISTINCT agent_id FROM agent_runs WHERE task_id = ? AND status IN ('queued','dispatched','active','stale')",
    )
      .bind(task.id)
      .all<{ agent_id: string }>();
    for (const r of open.results) await endRunsFor(env, task.id, r.agent_id, "completed");
    if (statusChange.to === "done") {
      await postTaskCompleted(env, ws, actor, next, patch.summary);
      await ideasLiveForTask(env, ws, actor, next.id);
    }
    await onBlockerFinished(env, ws, actor, next);
  } else if (actor.member.kind === "agent") {
    await touchRun(env, next.id, actor.member.id);
  }

  await notify(env, ws.id, { type: "task", task_id: task.id });
  return next;
}

async function assertMemberInWorkspace(env: AppEnv, workspaceId: string, memberId: string) {
  const m = await env.DB.prepare("SELECT id FROM members WHERE id = ? AND workspace_id = ? AND active = 1")
    .bind(memberId, workspaceId)
    .first();
  if (!m) throw badRequest("Unknown assignee");
}
async function assertProjectInWorkspace(env: AppEnv, workspaceId: string, projectId: string) {
  const p = await env.DB.prepare("SELECT id FROM projects WHERE id = ? AND workspace_id = ?").bind(projectId, workspaceId).first();
  if (!p) throw badRequest("Unknown project");
}

// ---------- Thread ----------

export async function addSystemEntry(
  env: AppEnv,
  task: TaskRow,
  author: MemberRow | null,
  event: string,
  data: Record<string, unknown>,
): Promise<void> {
  // System entries without a human/agent author are attributed to the task creator's workspace "system"
  // by storing the acting member when known, otherwise the task creator.
  await env.DB.prepare(
    "INSERT INTO thread_entries (id, task_id, author_id, type, body, data, created_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(newId(), task.id, author?.id ?? task.created_by, "system", "", JSON.stringify({ event, actor_known: !!author, ...data }), nowIso())
    .run();
}

const MENTION_RE = /(^|[^\w@])@([a-z0-9][a-z0-9_-]*)/gi;
export function extractMentions(body: string): string[] {
  const out = new Set<string>();
  // The editor's Markdown output may escape "_" in handles as "\_".
  for (const m of body.replace(/\\_/g, "_").matchAll(MENTION_RE)) out.add(m[2].toLowerCase());
  return [...out];
}

export interface PostEntryInput {
  type: "comment" | "update" | "question" | "answer";
  body: string;
  replyToId?: string | null;
  addressedTo?: string | null;
}

export async function postEntry(
  env: AppEnv,
  ws: WorkspaceRow,
  actor: Actor,
  task: TaskRow,
  input: PostEntryInput,
): Promise<EntryRow> {
  const body = (input.body ?? "").trim();
  if (!body) throw badRequest("Message body is required");
  if (input.type === "question" && actor.member.kind !== "agent") {
    // Humans can ask questions too, but we only track "open questions" for agents → humans.
    input = { ...input, type: "comment" };
  }

  let replyTo: EntryRow | null = null;
  if (input.replyToId) {
    replyTo = await env.DB.prepare("SELECT * FROM thread_entries WHERE id = ? AND task_id = ?")
      .bind(input.replyToId, task.id)
      .first<EntryRow>();
    if (!replyTo) throw badRequest("reply_to entry not found on this task");
  }
  // A reply to an open question is an answer.
  let type = input.type;
  if (replyTo?.type === "question" && (type === "comment" || type === "answer")) type = "answer";
  if (type === "answer" && replyTo?.type !== "question") {
    throw badRequest("An answer must reply to a question");
  }

  const data: Record<string, unknown> = {};
  if (type === "question") {
    data.state = "open";
    if (input.addressedTo) {
      const target = await findMemberByRef(env, ws.id, input.addressedTo);
      data.addressed_to = target.id;
    }
  }

  const entry: EntryRow = {
    id: newId(),
    task_id: task.id,
    author_id: actor.member.id,
    type,
    body,
    data: JSON.stringify(data),
    reply_to_id: replyTo?.id ?? null,
    created_at: nowIso(),
    edited_at: null,
  };
  await env.DB.prepare(
    "INSERT INTO thread_entries (id, task_id, author_id, type, body, data, reply_to_id, created_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind(entry.id, entry.task_id, entry.author_id, entry.type, entry.body, entry.data, entry.reply_to_id, entry.created_at)
    .run();
  await logActivity(env, ws.id, actor, "thread_entry", entry.id, `posted_${type}`, undefined, { task_id: task.id });
  await env.DB.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").bind(entry.created_at, task.id).run();

  // Status effects
  if (type === "question") {
    if (task.status !== "waiting_on_human") {
      await env.DB.prepare("UPDATE tasks SET status = 'waiting_on_human' WHERE id = ?").bind(task.id).run();
      await addSystemEntry(env, task, actor.member, "status_changed", { from: task.status, to: "waiting_on_human" });
    }
  }
  if (type === "answer" && replyTo) {
    const qData = parseJson<Record<string, unknown>>(replyTo.data, {});
    if (qData.state === "open") {
      qData.state = "answered";
      qData.answered_by = actor.member.id;
      qData.answer_id = entry.id;
      await env.DB.prepare("UPDATE thread_entries SET data = ? WHERE id = ?").bind(JSON.stringify(qData), replyTo.id).run();
    }
    const stillOpen = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM thread_entries WHERE task_id = ? AND type = 'question' AND json_extract(data, '$.state') = 'open'",
    )
      .bind(task.id)
      .first<{ n: number }>();
    const fresh = await env.DB.prepare("SELECT status FROM tasks WHERE id = ?").bind(task.id).first<{ status: TaskStatus }>();
    if (!stillOpen?.n && fresh?.status === "waiting_on_human") {
      await env.DB.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").bind(task.id).run();
      await addSystemEntry(env, task, actor.member, "status_changed", { from: "waiting_on_human", to: "in_progress" });
    }
  }

  // Agent run bookkeeping & wake-ups
  if (actor.member.kind === "agent") {
    await touchRun(env, task.id, actor.member.id);
    if (type === "question") await endRunsFor(env, task.id, actor.member.id, "asked_question");
  }
  // Wake-ups: humans can wake any agent; an orchestrator agent only its own sub-agents (loop guard).
  {
    if (type === "answer" && replyTo) {
      const asker = await getMember(env, replyTo.author_id);
      if (asker.active && canWake(actor, asker, ws)) {
        await onAgentTrigger(env, {
          task,
          agent: asker,
          trigger: "answered",
          triggerEntryId: entry.id,
          triggeredBy: actor.member.id,
        });
      }
    }
    const handles = extractMentions(body);
    if (handles.length) {
      const mentioned = await env.DB.prepare(
        `SELECT * FROM members WHERE workspace_id = ? AND kind = 'agent' AND active = 1 AND wake_on_mention = 1
         AND handle IN (${handles.map(() => "?").join(",")})`,
      )
        .bind(ws.id, ...handles)
        .all<MemberRow>();
      for (const agent of mentioned.results) {
        if (!canWake(actor, agent, ws)) continue;
        await onAgentTrigger(env, {
          task,
          agent,
          trigger: "mentioned",
          triggerEntryId: entry.id,
          triggeredBy: actor.member.id,
        });
      }
    }
  }

  await notify(env, ws.id, { type: "thread", task_id: task.id });
  return entry;
}

export async function editEntry(env: AppEnv, ws: WorkspaceRow, actor: Actor, entryId: string, body: string) {
  const entry = await env.DB.prepare("SELECT * FROM thread_entries WHERE id = ?").bind(entryId).first<EntryRow>();
  if (!entry) throw notFound("Entry");
  if (entry.author_id !== actor.member.id) throw forbidden("Only the author can edit this entry");
  if (entry.type === "system") throw forbidden("System entries can't be edited");
  const trimmed = body.trim();
  if (!trimmed) throw badRequest("Body is required");
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO thread_entry_revisions (id, entry_id, body, created_at) VALUES (?,?,?,?)").bind(
      newId(),
      entry.id,
      entry.body,
      now,
    ),
    env.DB.prepare("UPDATE thread_entries SET body = ?, edited_at = ? WHERE id = ?").bind(trimmed, now, entry.id),
  ]);
  await logActivity(env, ws.id, actor, "thread_entry", entry.id, "edited", { body: entry.body }, { body: trimmed });
  await notify(env, ws.id, { type: "thread", task_id: entry.task_id });
}

// ---------- Notes ----------

export async function writeNote(
  env: AppEnv,
  ws: WorkspaceRow,
  actor: Actor,
  task: TaskRow,
  input: { noteId?: string | null; title?: string; content?: string },
) {
  const now = nowIso();
  if (input.noteId) {
    const note = await env.DB.prepare("SELECT * FROM notes WHERE id = ? AND task_id = ?")
      .bind(input.noteId, task.id)
      .first<{ id: string; title: string; content: string }>();
    if (!note) throw notFound("Note");
    const title = input.title?.trim() || note.title;
    const content = input.content ?? note.content;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO note_revisions (id, note_id, title, content, author_id, created_at) VALUES (?,?,?,?,?,?)",
      ).bind(newId(), note.id, note.title, note.content, actor.member.id, now),
      env.DB.prepare("UPDATE notes SET title = ?, content = ?, updated_by = ?, updated_at = ? WHERE id = ?").bind(
        title,
        content,
        actor.member.id,
        now,
        note.id,
      ),
    ]);
    await logActivity(env, ws.id, actor, "note", note.id, "updated");
    if (actor.member.kind === "agent") await touchRun(env, task.id, actor.member.id);
    await notify(env, ws.id, { type: "notes", task_id: task.id });
    return { id: note.id, title, content };
  }
  const title = input.title?.trim() || "Untitled note";
  const content = input.content ?? "";
  const id = newId();
  await env.DB.prepare(
    "INSERT INTO notes (id, task_id, title, content, created_by, updated_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind(id, task.id, title, content, actor.member.id, actor.member.id, now, now)
    .run();
  await env.DB.prepare(
    "INSERT INTO thread_entries (id, task_id, author_id, type, body, data, created_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(newId(), task.id, actor.member.id, "note_created", "", JSON.stringify({ note_id: id, title }), now)
    .run();
  await logActivity(env, ws.id, actor, "note", id, "created");
  if (actor.member.kind === "agent") await touchRun(env, task.id, actor.member.id);
  await notify(env, ws.id, { type: "thread", task_id: task.id });
  return { id, title, content };
}

// ---------- Checklists ----------

export async function createChecklist(
  env: AppEnv,
  ws: WorkspaceRow,
  actor: Actor,
  task: TaskRow,
  title: string,
  items: string[],
) {
  const now = nowIso();
  const id = newId();
  const t = title.trim() || "Checklist";
  const stmts = [
    env.DB.prepare("INSERT INTO checklists (id, task_id, title, created_by, created_at) VALUES (?,?,?,?,?)").bind(
      id,
      task.id,
      t,
      actor.member.id,
      now,
    ),
    ...items
      .map((s) => s.trim())
      .filter(Boolean)
      .map((text, i) =>
        env.DB.prepare("INSERT INTO checklist_items (id, checklist_id, text, position) VALUES (?,?,?,?)").bind(
          newId(),
          id,
          text,
          i,
        ),
      ),
    env.DB.prepare(
      "INSERT INTO thread_entries (id, task_id, author_id, type, body, data, created_at) VALUES (?,?,?,?,?,?,?)",
    ).bind(newId(), task.id, actor.member.id, "checklist_created", "", JSON.stringify({ checklist_id: id, title: t }), now),
  ];
  await env.DB.batch(stmts);
  await logActivity(env, ws.id, actor, "checklist", id, "created");
  if (actor.member.kind === "agent") await touchRun(env, task.id, actor.member.id);
  await notify(env, ws.id, { type: "thread", task_id: task.id });
  return getChecklist(env, id);
}

export async function getChecklist(env: AppEnv, id: string) {
  const cl = await env.DB.prepare("SELECT * FROM checklists WHERE id = ?").bind(id).first<{
    id: string;
    task_id: string;
    title: string;
  }>();
  if (!cl) throw notFound("Checklist");
  const items = await env.DB.prepare("SELECT * FROM checklist_items WHERE checklist_id = ? ORDER BY position").bind(id).all();
  return { ...cl, items: items.results };
}

async function checklistTaskForItem(env: AppEnv, workspaceId: string, itemId: string) {
  const row = await env.DB.prepare(
    `SELECT i.*, c.task_id FROM checklist_items i JOIN checklists c ON c.id = i.checklist_id JOIN tasks t ON t.id = c.task_id
     WHERE i.id = ? AND t.workspace_id = ?`,
  )
    .bind(itemId, workspaceId)
    .first<{ id: string; checklist_id: string; task_id: string; done: number; text: string }>();
  if (!row) throw notFound("Checklist item");
  return row;
}

export async function setChecklistItem(
  env: AppEnv,
  ws: WorkspaceRow,
  actor: Actor,
  itemId: string,
  patch: { done?: boolean; text?: string },
) {
  const item = await checklistTaskForItem(env, ws.id, itemId);
  if (patch.done !== undefined) {
    await env.DB.prepare("UPDATE checklist_items SET done = ?, done_by = ?, done_at = ? WHERE id = ?")
      .bind(patch.done ? 1 : 0, patch.done ? actor.member.id : null, patch.done ? nowIso() : null, itemId)
      .run();
  }
  if (patch.text !== undefined && patch.text.trim()) {
    await env.DB.prepare("UPDATE checklist_items SET text = ? WHERE id = ?").bind(patch.text.trim(), itemId).run();
  }
  await logActivity(env, ws.id, actor, "checklist_item", itemId, "updated", item, patch);
  if (actor.member.kind === "agent") await touchRun(env, item.task_id, actor.member.id);
  await notify(env, ws.id, { type: "checklists", task_id: item.task_id });
  return getChecklist(env, item.checklist_id);
}

export async function addChecklistItem(env: AppEnv, ws: WorkspaceRow, actor: Actor, checklistId: string, text: string) {
  const cl = await env.DB.prepare(
    "SELECT c.* FROM checklists c JOIN tasks t ON t.id = c.task_id WHERE c.id = ? AND t.workspace_id = ?",
  )
    .bind(checklistId, ws.id)
    .first<{ id: string; task_id: string }>();
  if (!cl) throw notFound("Checklist");
  if (!text.trim()) throw badRequest("Item text is required");
  const pos = await env.DB.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM checklist_items WHERE checklist_id = ?")
    .bind(checklistId)
    .first<{ p: number }>();
  await env.DB.prepare("INSERT INTO checklist_items (id, checklist_id, text, position) VALUES (?,?,?,?)")
    .bind(newId(), checklistId, text.trim(), pos?.p ?? 0)
    .run();
  await logActivity(env, ws.id, actor, "checklist", checklistId, "item_added", undefined, { text });
  if (actor.member.kind === "agent") await touchRun(env, cl.task_id, actor.member.id);
  await notify(env, ws.id, { type: "checklists", task_id: cl.task_id });
  return getChecklist(env, checklistId);
}

export async function deleteChecklistItem(env: AppEnv, ws: WorkspaceRow, actor: Actor, itemId: string) {
  const item = await checklistTaskForItem(env, ws.id, itemId);
  await env.DB.prepare("DELETE FROM checklist_items WHERE id = ?").bind(itemId).run();
  await logActivity(env, ws.id, actor, "checklist_item", itemId, "deleted", item);
  await notify(env, ws.id, { type: "checklists", task_id: item.task_id });
}

// ---------- Attachments ----------

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export async function addAttachment(
  env: AppEnv,
  ws: WorkspaceRow,
  actor: Actor,
  task: TaskRow,
  file: { filename: string; contentType: string; data: ArrayBuffer | ReadableStream; size: number },
) {
  if (file.size > MAX_ATTACHMENT_BYTES) throw new HttpError(413, "File is larger than 25 MB");
  const id = newId();
  const safeName = file.filename.replace(/[^\w.\- ]+/g, "_").slice(0, 200) || "file";
  const r2Key = `${ws.id}/${task.id}/${id}/${safeName}`;
  await env.FILES.put(r2Key, file.data, { httpMetadata: { contentType: file.contentType } });
  const now = nowIso();
  const entryId = newId();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO thread_entries (id, task_id, author_id, type, body, data, created_at) VALUES (?,?,?,?,?,?,?)",
    ).bind(
      entryId,
      task.id,
      actor.member.id,
      "attachment_added",
      "",
      JSON.stringify({ attachment_id: id, filename: safeName, content_type: file.contentType, size: file.size }),
      now,
    ),
    env.DB.prepare(
      "INSERT INTO attachments (id, task_id, thread_entry_id, filename, content_type, size, r2_key, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).bind(id, task.id, entryId, safeName, file.contentType, file.size, r2Key, actor.member.id, now),
  ]);
  await logActivity(env, ws.id, actor, "attachment", id, "uploaded", undefined, { filename: safeName, size: file.size });
  if (actor.member.kind === "agent") await touchRun(env, task.id, actor.member.id);
  await notify(env, ws.id, { type: "thread", task_id: task.id });
  return { id, filename: safeName, content_type: file.contentType, size: file.size };
}

// ---------- Read models ----------

export async function getTaskDetail(env: AppEnv, ws: WorkspaceRow, task: TaskRow) {
  const [serialized] = await serializeTasks(env, ws, [task]);
  const [entries, notes, checklists, items, attachments, runs] = await Promise.all([
    env.DB.prepare("SELECT * FROM thread_entries WHERE task_id = ? ORDER BY created_at, id").bind(task.id).all<EntryRow>(),
    env.DB.prepare("SELECT * FROM notes WHERE task_id = ? ORDER BY created_at").bind(task.id).all(),
    env.DB.prepare("SELECT * FROM checklists WHERE task_id = ? ORDER BY created_at").bind(task.id).all<{ id: string }>(),
    env.DB.prepare(
      "SELECT i.* FROM checklist_items i JOIN checklists c ON c.id = i.checklist_id WHERE c.task_id = ? ORDER BY i.position",
    )
      .bind(task.id)
      .all<{ checklist_id: string }>(),
    env.DB.prepare("SELECT id, filename, content_type, size, uploaded_by, created_at FROM attachments WHERE task_id = ? ORDER BY created_at")
      .bind(task.id)
      .all(),
    env.DB.prepare("SELECT * FROM agent_runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 20").bind(task.id).all(),
  ]);
  const [dependencies, reactions] = await Promise.all([dependenciesOf(env, ws, task.id), reactionsFor(env, task.id)]);
  return {
    task: serialized,
    entries: entries.results.map((e) => ({ ...e, data: parseJson(e.data, {}), reactions: reactions.get(e.id) ?? [] })),
    dependencies,
    notes: notes.results,
    checklists: checklists.results.map((c) => ({ ...c, items: items.results.filter((i) => i.checklist_id === c.id) })),
    attachments: attachments.results,
    runs: runs.results,
  };
}

export async function getInbox(env: AppEnv, ws: WorkspaceRow, me: MemberRow) {
  const questions = await env.DB.prepare(
    `SELECT e.*, t.number, t.title AS task_title, t.created_by AS task_created_by FROM thread_entries e
     JOIN tasks t ON t.id = e.task_id
     WHERE t.workspace_id = ? AND e.type = 'question' AND json_extract(e.data, '$.state') = 'open'
     AND (json_extract(e.data, '$.addressed_to') = ?
          OR (json_extract(e.data, '$.addressed_to') IS NULL AND t.created_by = ?)
          OR ? = 'admin' AND json_extract(e.data, '$.addressed_to') IS NULL)
     ORDER BY e.created_at DESC LIMIT 100`,
  )
    .bind(ws.id, me.id, me.id, me.role)
    .all<EntryRow & { number: number; task_title: string }>();

  const runs = await env.DB.prepare(
    `SELECT r.*, t.number, t.title AS task_title, m.name AS agent_name FROM agent_runs r
     JOIN tasks t ON t.id = r.task_id JOIN members m ON m.id = r.agent_id
     LEFT JOIN members tb ON tb.id = r.triggered_by
     WHERE t.workspace_id = ? AND r.status IN ('failed','stale') AND r.dismissed = 0
     AND (r.triggered_by = ?
          OR (? = 'admin' AND (r.triggered_by IS NULL OR tb.kind = 'agent'))
          OR (tb.kind = 'agent' AND tb.created_by = ?)
          OR m.created_by = ?)
     ORDER BY r.created_at DESC LIMIT 100`,
  )
    .bind(ws.id, me.id, me.role, me.id, me.id)
    .all<{ number: number }>();

  const mentions = await env.DB.prepare(
    `SELECT e.*, t.number, t.title AS task_title FROM thread_entries e JOIN tasks t ON t.id = e.task_id
     LEFT JOIN read_cursors rc ON rc.task_id = t.id AND rc.member_id = ?
     WHERE t.workspace_id = ? AND e.author_id != ? AND e.body LIKE ?
     AND (rc.last_read_at IS NULL OR e.created_at > rc.last_read_at)
     ORDER BY e.created_at DESC LIMIT 50`,
  )
    .bind(me.id, ws.id, me.id, `%@${me.handle}%`)
    .all<EntryRow & { number: number }>();

  const key = (n: number) => `${ws.key_prefix}-${n}`;
  return {
    questions: questions.results.map((q) => ({ ...q, data: parseJson(q.data, {}), task_key: key(q.number) })),
    runs: runs.results.map((r) => ({ ...r, task_key: key(r.number) })),
    mentions: mentions.results
      .filter((e) => extractMentions(e.body).includes(me.handle))
      .map((e) => ({ ...e, data: parseJson(e.data, {}), task_key: key(e.number) })),
  };
}

export async function markRead(env: AppEnv, memberId: string, taskId: string) {
  await env.DB.prepare(
    `INSERT INTO read_cursors (member_id, task_id, last_read_at) VALUES (?,?,?)
     ON CONFLICT(member_id, task_id) DO UPDATE SET last_read_at = excluded.last_read_at`,
  )
    .bind(memberId, taskId, nowIso())
    .run();
}

// ---------- Projects ----------

export async function createProject(
  env: AppEnv,
  ws: WorkspaceRow,
  actor: Actor,
  input: { name: string; description?: string; leadMemberId?: string | null },
) {
  const name = input.name?.trim();
  if (!name) throw badRequest("Project name is required");
  if (input.leadMemberId) await assertMemberInWorkspace(env, ws.id, input.leadMemberId);
  const id = newId();
  await env.DB.prepare(
    "INSERT INTO projects (id, workspace_id, name, description, lead_member_id, created_by, created_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(id, ws.id, name, input.description ?? "", input.leadMemberId ?? null, actor.member.id, nowIso())
    .run();
  await logActivity(env, ws.id, actor, "project", id, "created", undefined, input);
  await notify(env, ws.id, { type: "projects" });
  return env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first<ProjectRow>();
}

export async function updateProject(
  env: AppEnv,
  ws: WorkspaceRow,
  actor: Actor,
  id: string,
  patch: { name?: string; description?: string; leadMemberId?: string | null; status?: "active" | "archived" },
) {
  const p = await env.DB.prepare("SELECT * FROM projects WHERE id = ? AND workspace_id = ?").bind(id, ws.id).first<ProjectRow>();
  if (!p) throw notFound("Project");
  const next = {
    name: patch.name?.trim() || p.name,
    description: patch.description ?? p.description,
    lead_member_id: patch.leadMemberId === undefined ? p.lead_member_id : patch.leadMemberId,
    status: patch.status ?? p.status,
  };
  await env.DB.prepare("UPDATE projects SET name=?, description=?, lead_member_id=?, status=? WHERE id=?")
    .bind(next.name, next.description, next.lead_member_id, next.status, id)
    .run();
  await logActivity(env, ws.id, actor, "project", id, "updated", p, next);
  await notify(env, ws.id, { type: "projects" });
  return { ...p, ...next };
}

export async function listProjects(env: AppEnv, workspaceId: string) {
  const r = await env.DB.prepare(
    `SELECT p.*,
       (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS task_count,
       (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') AS done_count
     FROM projects p WHERE p.workspace_id = ? ORDER BY p.status, p.created_at DESC`,
  )
    .bind(workspaceId)
    .all();
  return r.results;
}
