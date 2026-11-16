/**
 * Workspace feed (short updates from people and agents, not tied to one task) and performance reports.
 *
 * Posts have a kind (update / done / blocker), may link a task and a URL, and may belong to a routine
 * ("daily-blog") so recurring work can be tracked for consistency. Completing a task posts a "done"
 * update automatically. People react with emoji; 👍 counts as "useful" in reports.
 */
import { Hono } from "hono";
import type { Actor, MemberRow, TaskRow, WorkspaceRow } from "./domain";
import { getTaskByRef, logActivity, notify, taskKey } from "./domain";
import { type AppEnv, HttpError, badRequest, forbidden, newId, notFound, nowIso } from "./util";

export const POST_KINDS = ["update", "done", "blocker"] as const;
export type PostKind = (typeof POST_KINDS)[number];
export const REACTIONS = ["👍", "🎉", "👀", "❤️"] as const;

interface PostRow {
  id: string;
  workspace_id: string;
  author_id: string;
  kind: PostKind;
  body: string;
  task_id: string | null;
  link_url: string | null;
  routine: string | null;
  auto: number;
  created_at: string;
  edited_at: string | null;
}

export interface NewPost {
  body: string;
  kind?: PostKind;
  taskRef?: string | null;
  link?: string | null;
  routine?: string | null;
  auto?: boolean;
}

const normRoutine = (r: string | null | undefined) =>
  r
    ? r
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || null
    : null;

export async function createPost(env: AppEnv, ws: WorkspaceRow, actor: Actor, input: NewPost) {
  const body = (input.body ?? "").trim();
  if (!body) throw badRequest("Write something to share");
  if (body.length > 4000) throw badRequest("Keep updates under 4,000 characters");
  const kind = input.kind ?? "update";
  if (!POST_KINDS.includes(kind)) throw badRequest("Kind must be update, done or blocker");
  let task: TaskRow | null = null;
  if (input.taskRef) task = await getTaskByRef(env, ws.id, input.taskRef);
  let link: string | null = null;
  if (input.link) {
    try {
      const u = new URL(input.link);
      if (!/^https?:$/.test(u.protocol)) throw new Error();
      link = u.toString();
    } catch {
      throw badRequest("Link must be an http(s) URL");
    }
  }
  const row: PostRow = {
    id: newId(),
    workspace_id: ws.id,
    author_id: actor.member.id,
    kind,
    body,
    task_id: task?.id ?? null,
    link_url: link,
    routine: normRoutine(input.routine),
    auto: input.auto ? 1 : 0,
    created_at: nowIso(),
    edited_at: null,
  };
  await env.DB.prepare(
    "INSERT INTO posts (id, workspace_id, author_id, kind, body, task_id, link_url, routine, auto, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(row.id, row.workspace_id, row.author_id, row.kind, row.body, row.task_id, row.link_url, row.routine, row.auto, row.created_at)
    .run();
  if (!row.auto) await logActivity(env, ws.id, actor, "post", row.id, "created", undefined, { kind, routine: row.routine });
  await notify(env, ws.id, { type: "feed" });
  return row;
}

/** Called when a task becomes done: a short "done" post by whoever finished it. */
export async function postTaskCompleted(env: AppEnv, ws: WorkspaceRow, actor: Actor, task: TaskRow, summary?: string) {
  const assignee = task.assignee_id && task.assignee_id !== actor.member.id
    ? await env.DB.prepare("SELECT name FROM members WHERE id = ?").bind(task.assignee_id).first<{ name: string }>()
    : null;
  const head = `Completed ${taskKey(ws, task)}: ${task.title}${assignee ? ` (assigned to ${assignee.name})` : ""}`;
  const text = summary?.trim() ? `${head}\n\n${summary.trim().slice(0, 1500)}` : head;
  try {
    await createPost(env, ws, actor, { body: text, kind: "done", taskRef: task.id, auto: true });
  } catch (err) {
    console.error("auto post failed", err);
  }
}

export async function listPosts(
  env: AppEnv,
  ws: WorkspaceRow,
  me: MemberRow,
  opts: { author?: string; kind?: string; routine?: string; memberKind?: string; before?: string; limit?: number } = {},
) {
  const where = ["p.workspace_id = ?"];
  const binds: unknown[] = [ws.id];
  if (opts.author) (where.push("(m.id = ? OR m.handle = ?)"), binds.push(opts.author, opts.author.replace(/^@/, "")));
  if (opts.kind && (POST_KINDS as readonly string[]).includes(opts.kind)) (where.push("p.kind = ?"), binds.push(opts.kind));
  if (opts.routine) (where.push("p.routine = ?"), binds.push(normRoutine(opts.routine)));
  if (opts.memberKind === "agent" || opts.memberKind === "human") (where.push("m.kind = ?"), binds.push(opts.memberKind));
  if (opts.before) (where.push("p.created_at < ?"), binds.push(opts.before));
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const rows = await env.DB.prepare(
    `SELECT p.*, t.number AS task_number, t.title AS task_title, t.status AS task_status
     FROM posts p JOIN members m ON m.id = p.author_id LEFT JOIN tasks t ON t.id = p.task_id
     WHERE ${where.join(" AND ")} ORDER BY p.created_at DESC LIMIT ?`,
  )
    .bind(...binds, limit)
    .all<PostRow & { task_number: number | null; task_title: string | null; task_status: string | null }>();
  const ids = rows.results.map((r) => r.id);
  const reactions = ids.length
    ? await env.DB.prepare(`SELECT post_id, member_id, emoji FROM post_reactions WHERE post_id IN (${ids.map(() => "?").join(",")})`)
        .bind(...ids)
        .all<{ post_id: string; member_id: string; emoji: string }>()
    : { results: [] };
  return rows.results.map((r) => {
    const mine = reactions.results.filter((x) => x.post_id === r.id);
    return {
      id: r.id,
      author_id: r.author_id,
      kind: r.kind,
      body: r.body,
      link_url: r.link_url,
      routine: r.routine,
      auto: !!r.auto,
      created_at: r.created_at,
      task: r.task_id && r.task_number != null ? { id: r.task_id, key: `${ws.key_prefix}-${r.task_number}`, title: r.task_title, status: r.task_status } : null,
      reactions: REACTIONS.map((emoji) => {
        const by = mine.filter((x) => x.emoji === emoji).map((x) => x.member_id);
        return { emoji, count: by.length, mine: by.includes(me.id), by };
      }).filter((x) => x.count > 0),
    };
  });
}

// ---------- Reports ----------

export async function buildReport(env: AppEnv, ws: WorkspaceRow, days: number) {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const db = env.DB;
  const q = <T>(sql: string, ...b: unknown[]) => db.prepare(sql).bind(...b).all<T>().then((r) => r.results);
  const [members, done, open, posts, useful, questions, runs, lastSeen, routines, routineDays] = await Promise.all([
    q<MemberRow>("SELECT * FROM members WHERE workspace_id = ? AND active = 1", ws.id),
    q<{ id: string; n: number; median_hours: number | null; avg_hours: number }>(
      `SELECT assignee_id AS id, COUNT(*) AS n, AVG((julianday(completed_at) - julianday(created_at)) * 24) AS avg_hours, NULL AS median_hours
       FROM tasks WHERE workspace_id = ? AND status = 'done' AND completed_at >= ? AND assignee_id IS NOT NULL GROUP BY assignee_id`,
      ws.id,
      since,
    ),
    q<{ id: string; n: number; overdue: number }>(
      `SELECT assignee_id AS id, COUNT(*) AS n, SUM(CASE WHEN due_date IS NOT NULL AND due_date < date('now') THEN 1 ELSE 0 END) AS overdue
       FROM tasks WHERE workspace_id = ? AND status NOT IN ('done','canceled') AND assignee_id IS NOT NULL GROUP BY assignee_id`,
      ws.id,
    ),
    q<{ id: string; kind: string; n: number }>(
      "SELECT author_id AS id, kind, COUNT(*) AS n FROM posts WHERE workspace_id = ? AND created_at >= ? AND auto = 0 GROUP BY author_id, kind",
      ws.id,
      since,
    ),
    q<{ id: string; n: number }>(
      `SELECT p.author_id AS id, COUNT(*) AS n FROM post_reactions r JOIN posts p ON p.id = r.post_id
       JOIN members rm ON rm.id = r.member_id
       WHERE p.workspace_id = ? AND p.created_at >= ? AND r.emoji = '👍' AND rm.kind = 'human' AND r.member_id != p.author_id
       GROUP BY p.author_id`,
      ws.id,
      since,
    ),
    q<{ id: string; n: number }>(
      `SELECT e.author_id AS id, COUNT(*) AS n FROM thread_entries e JOIN tasks t ON t.id = e.task_id
       WHERE t.workspace_id = ? AND e.type = 'question' AND e.created_at >= ? GROUP BY e.author_id`,
      ws.id,
      since,
    ),
    q<{ id: string; total: number; problems: number }>(
      `SELECT r.agent_id AS id, COUNT(*) AS total, SUM(CASE WHEN r.status IN ('failed','stale') THEN 1 ELSE 0 END) AS problems
       FROM agent_runs r JOIN tasks t ON t.id = r.task_id WHERE t.workspace_id = ? AND r.created_at >= ? GROUP BY r.agent_id`,
      ws.id,
      since,
    ),
    q<{ id: string; at: string }>(
      `SELECT id, MAX(at) AS at FROM (
         SELECT e.author_id AS id, MAX(e.created_at) AS at FROM thread_entries e JOIN tasks t ON t.id = e.task_id WHERE t.workspace_id = ? AND e.type != 'system' GROUP BY e.author_id
         UNION ALL SELECT author_id, MAX(created_at) FROM posts WHERE workspace_id = ? GROUP BY author_id
       ) GROUP BY id`,
      ws.id,
      ws.id,
    ),
    q<{ routine: string; author_id: string; n: number; last_at: string }>(
      `SELECT routine, author_id, COUNT(*) AS n, MAX(created_at) AS last_at FROM posts
       WHERE workspace_id = ? AND routine IS NOT NULL AND created_at >= ? GROUP BY routine, author_id ORDER BY last_at DESC`,
      ws.id,
      since,
    ),
    q<{ routine: string; author_id: string; day: string; n: number }>(
      `SELECT routine, author_id, substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM posts
       WHERE workspace_id = ? AND routine IS NOT NULL AND created_at >= ? GROUP BY routine, author_id, day`,
      ws.id,
      since,
    ),
  ]);
  const by = <T extends { id: string }>(rows: T[]) => new Map(rows.map((r) => [r.id, r]));
  const doneBy = by(done);
  const openBy = by(open);
  const usefulBy = by(useful);
  const qBy = by(questions);
  const runsBy = by(runs);
  const seenBy = by(lastSeen);
  const people = members.map((m) => {
    const p = (kind: string) => posts.find((x) => x.id === m.id && x.kind === kind)?.n ?? 0;
    const d = doneBy.get(m.id);
    const r = runsBy.get(m.id);
    return {
      id: m.id,
      name: m.name,
      handle: m.handle,
      kind: m.kind,
      avatar_url: m.avatar_url,
      tasks_done: d?.n ?? 0,
      avg_hours_to_done: d ? Math.round(d.avg_hours * 10) / 10 : null,
      open_tasks: openBy.get(m.id)?.n ?? 0,
      overdue: openBy.get(m.id)?.overdue ?? 0,
      updates: p("update") + p("done"),
      blockers: p("blocker"),
      useful: usefulBy.get(m.id)?.n ?? 0,
      questions: qBy.get(m.id)?.n ?? 0,
      runs: r?.total ?? 0,
      failed_runs: r?.problems ?? 0,
      last_active: seenBy.get(m.id)?.at ?? null,
    };
  });
  const routinesOut = routines.map((r) => ({
    routine: r.routine,
    author_id: r.author_id,
    posts: r.n,
    last_at: r.last_at,
    days: routineDays.filter((d) => d.routine === r.routine && d.author_id === r.author_id).map((d) => d.day),
  }));
  return { days, since, people, routines: routinesOut };
}

// ---------- HTTP (signed-in people) ----------

type Vars = { me: MemberRow; ws: WorkspaceRow; actor: Actor };
export const feedRoutes = new Hono<{ Bindings: AppEnv; Variables: Vars }>();

feedRoutes.get("/api/posts", async (c) => {
  const q = c.req.query();
  return c.json(
    await listPosts(c.env, c.get("ws"), c.get("me"), {
      author: q.author,
      kind: q.kind,
      routine: q.routine,
      memberKind: q.member_kind,
      before: q.before,
      limit: q.limit ? Number(q.limit) : undefined,
    }),
  );
});

feedRoutes.post("/api/posts", async (c) => {
  const b = await c.req.json<{ body?: string; kind?: PostKind; task?: string | null; link?: string | null; routine?: string | null }>();
  const post = await createPost(c.env, c.get("ws"), c.get("actor"), {
    body: b.body ?? "",
    kind: b.kind,
    taskRef: b.task,
    link: b.link,
    routine: b.routine,
  });
  return c.json(post, 201);
});

feedRoutes.delete("/api/posts/:id", async (c) => {
  const me = c.get("me");
  const ws = c.get("ws");
  const post = await c.env.DB.prepare("SELECT * FROM posts WHERE id = ? AND workspace_id = ?").bind(c.req.param("id"), ws.id).first<PostRow>();
  if (!post) throw notFound("Post");
  if (me.role !== "admin" && post.author_id !== me.id) throw forbidden("Only admins or the author can delete this update");
  await c.env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(post.id).run();
  await logActivity(c.env, ws.id, c.get("actor"), "post", post.id, "deleted", { body: post.body, kind: post.kind, author_id: post.author_id });
  await notify(c.env, ws.id, { type: "feed" });
  return c.json({ ok: true });
});

feedRoutes.post("/api/posts/:id/reactions", async (c) => {
  const me = c.get("me");
  const ws = c.get("ws");
  const { emoji } = await c.req.json<{ emoji: string }>();
  if (!(REACTIONS as readonly string[]).includes(emoji)) throw badRequest("Unknown reaction");
  const post = await c.env.DB.prepare("SELECT id FROM posts WHERE id = ? AND workspace_id = ?").bind(c.req.param("id"), ws.id).first();
  if (!post) throw notFound("Post");
  const had = await c.env.DB.prepare("SELECT 1 FROM post_reactions WHERE post_id = ? AND member_id = ? AND emoji = ?").bind(post.id, me.id, emoji).first();
  if (had) await c.env.DB.prepare("DELETE FROM post_reactions WHERE post_id = ? AND member_id = ? AND emoji = ?").bind(post.id, me.id, emoji).run();
  else await c.env.DB.prepare("INSERT INTO post_reactions (post_id, member_id, emoji, created_at) VALUES (?,?,?,?)").bind(post.id, me.id, emoji, nowIso()).run();
  await notify(c.env, ws.id, { type: "feed" });
  return c.json({ reacted: !had });
});

feedRoutes.get("/api/reports", async (c) => {
  const days = Number(c.req.query("days") || 30);
  if (![7, 30, 90].includes(days)) throw new HttpError(400, "days must be 7, 30 or 90");
  return c.json(await buildReport(c.env, c.get("ws"), days));
});
