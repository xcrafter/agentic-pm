import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import {
  type Actor,
  type MemberRow,
  type WorkspaceRow,
  addAttachment,
  addChecklistItem,
  createChecklist,
  createProject,
  createTask,
  deleteChecklistItem,
  editEntry,
  ensureWorkspace,
  getInbox,
  getMember,
  getTaskByRef,
  getTaskDetail,
  listProjects,
  listTasks,
  logActivity,
  markRead,
  notify,
  postEntry,
  publicMember,
  serializeTasks,
  setChecklistItem,
  updateProject,
  updateTask,
  writeNote,
} from "./domain";
import { onAgentTrigger, retryRun, testPing } from "./orchestrator";
import { type InviteRow, SESSION_COOKIE, createInvite, getSessionMember, needsSetup, uniqueHandle } from "./auth";
import { canManageAgent, listSubAgents } from "./agents";
import { deleteAttachment, deleteChecklist, deleteEntry, deleteNote, deleteTask } from "./deletes";
import { serveLogo, workspaceInfo, workspaceRoutes } from "./workspace";
import { feedRoutes } from "./feed";
import { ideaRoutes } from "./ideas";
import { type AppEnv, HttpError, badRequest, encryptSecret, forbidden, newId, notFound, nowIso, verifySignedValue } from "./util";

type Vars = { me: MemberRow; ws: WorkspaceRow; actor: Actor };
export const api = new Hono<{ Bindings: AppEnv; Variables: Vars }>();

api.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
  console.error(err);
  return c.json({ error: "Internal error" }, 500);
});

// Public: who am I (null when signed out) + which sign-in methods exist.
api.get("/api/me", async (c) => {
  const me = await getSessionMember(c.env, getCookie(c, SESSION_COOKIE));
  const w = await ensureWorkspace(c.env);
  const ws = me ? w : null;
  return c.json({
    member: me ? publicMember(me) : null,
    workspace: ws ? workspaceInfo(c.env, ws) : null,
    brand: { name: w.name, logo_url: workspaceInfo(c.env, w).logo_url },
    auth: { google: !!c.env.GOOGLE_CLIENT_ID, setup: me ? false : await needsSetup(c.env) },
  });
});

// Public: workspace logo (also shown on the sign-in page).
api.get("/api/logo", (c) => serveLogo(c.env));

// Signed attachment download for agents (link from MCP get_attachment).
api.get("/files/:id", async (c) => {
  const id = c.req.param("id");
  const exp = c.req.query("exp") ?? "";
  const sig = c.req.query("sig") ?? "";
  if (!exp || Number(exp) < Date.now() / 1000 || !(await verifySignedValue(c.env, `${id}.${exp}`, sig))) {
    return c.text("Link expired or invalid", 403);
  }
  return streamAttachment(c.env, id);
});

async function streamAttachment(env: AppEnv, id: string, workspaceId?: string) {
  const a = await env.DB.prepare(
    `SELECT a.* FROM attachments a JOIN tasks t ON t.id = a.task_id WHERE a.id = ? ${workspaceId ? "AND t.workspace_id = ?" : ""}`,
  )
    .bind(...(workspaceId ? [id, workspaceId] : [id]))
    .first<{ r2_key: string; filename: string; content_type: string }>();
  if (!a) return new Response("Not found", { status: 404 });
  const obj = await env.FILES.get(a.r2_key);
  if (!obj) return new Response("Not found", { status: 404 });
  const inline = /^(image\/|application\/pdf|text\/plain)/.test(a.content_type);
  return new Response(obj.body, {
    headers: {
      "Content-Type": a.content_type,
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${a.filename.replace(/"/g, "")}"`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
    },
  });
}

// Everything below requires a signed-in human.
api.use("/api/*", async (c, next) => {
  const me = await getSessionMember(c.env, getCookie(c, SESSION_COOKIE));
  if (!me) return c.json({ error: "Not signed in" }, 401);
  const ws = await ensureWorkspace(c.env);
  c.set("me", me);
  c.set("ws", ws);
  c.set("actor", { member: me, via: "web" });
  await next();
});

api.route("/", workspaceRoutes);
api.route("/", feedRoutes);
api.route("/", ideaRoutes);

const requireAdmin = (me: MemberRow) => {
  if (me.role !== "admin") throw forbidden("Admins only");
};

// ----- Realtime -----
api.get("/ws", async (c) => {
  const me = await getSessionMember(c.env, getCookie(c, SESSION_COOKIE));
  if (!me) return c.text("Not signed in", 401);
  const stub = c.env.REALTIME.get(c.env.REALTIME.idFromName(me.workspace_id));
  return stub.fetch(c.req.raw);
});

// ----- Members -----
api.get("/api/members", async (c) => {
  const rows = await c.env.DB.prepare("SELECT * FROM members WHERE workspace_id = ? ORDER BY kind DESC, name")
    .bind(c.get("ws").id)
    .all<MemberRow>();
  return c.json(rows.results.map(publicMember));
});

api.post("/api/members/agents", async (c) => {
  const me = c.get("me");
  requireAdmin(me);
  const ws = c.get("ws");
  const body = await c.req.json<{
    name: string;
    handle?: string;
    description?: string;
    avatar_url?: string;
    webhook_url?: string;
    webhook_key?: string;
  }>();
  if (!body.name?.trim()) throw badRequest("Name is required");
  if (body.webhook_url && !/^https?:\/\//.test(body.webhook_url)) throw badRequest("Webhook URL must be http(s)");
  const handle = await uniqueHandle(c.env, ws.id, body.handle || body.name);
  const id = newId();
  await c.env.DB.prepare(
    `INSERT INTO members (id, workspace_id, kind, name, handle, avatar_url, role, description, webhook_url, webhook_key_encrypted, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      id,
      ws.id,
      "agent",
      body.name.trim(),
      handle,
      body.avatar_url ?? null,
      "member",
      body.description ?? "",
      body.webhook_url || null,
      body.webhook_key ? await encryptSecret(c.env, body.webhook_key) : null,
      me.id,
      nowIso(),
    )
    .run();
  await logActivity(c.env, ws.id, c.get("actor"), "member", id, "agent_created", undefined, { name: body.name, handle });
  await notify(c.env, ws.id, { type: "members" });
  return c.json(publicMember(await getMember(c.env, id)), 201);
});

api.patch("/api/members/:id", async (c) => {
  const me = c.get("me");
  const ws = c.get("ws");
  const target = await getMember(c.env, c.req.param("id"));
  if (target.workspace_id !== ws.id) throw notFound("Member");
  if (target.id !== me.id && !(await canManageAgent(c.env, me, target))) throw forbidden();
  const body = await c.req.json<{
    name?: string;
    description?: string;
    avatar_url?: string | null;
    webhook_url?: string | null;
    webhook_key?: string;
    wake_on_mention?: boolean;
    max_runs_per_hour?: number;
    role?: "admin" | "member";
    active?: boolean;
  }>();
  const sets: string[] = [];
  const binds: unknown[] = [];
  const set = (col: string, v: unknown) => {
    sets.push(`${col} = ?`);
    binds.push(v);
  };
  if (body.name?.trim()) set("name", body.name.trim());
  if (body.avatar_url !== undefined) set("avatar_url", body.avatar_url);
  if (target.kind === "agent") {
    if (body.description !== undefined) set("description", body.description);
    if (body.webhook_url !== undefined) {
      if (body.webhook_url && !/^https?:\/\//.test(body.webhook_url)) throw badRequest("Webhook URL must be http(s)");
      set("webhook_url", body.webhook_url || null);
    }
    if (body.webhook_key) set("webhook_key_encrypted", await encryptSecret(c.env, body.webhook_key));
    if (body.wake_on_mention !== undefined) set("wake_on_mention", body.wake_on_mention ? 1 : 0);
    if (body.max_runs_per_hour !== undefined) set("max_runs_per_hour", Math.max(1, Math.min(1000, body.max_runs_per_hour)));
  }
  if (me.role === "admin") {
    if (body.role && target.kind === "human" && target.id !== me.id) set("role", body.role);
    if (body.active !== undefined && target.id !== me.id) set("active", body.active ? 1 : 0);
  }
  if (sets.length) {
    await c.env.DB.prepare(`UPDATE members SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, target.id).run();
    await logActivity(c.env, ws.id, c.get("actor"), "member", target.id, "updated", undefined, {
      ...body,
      webhook_key: body.webhook_key ? "***" : undefined,
    });
    await notify(c.env, ws.id, { type: "members" });
  }
  return c.json(publicMember(await getMember(c.env, target.id)));
});

// ----- Invites & password resets (admins) -----
api.get("/api/invites", async (c) => {
  requireAdmin(c.get("me"));
  const rows = await c.env.DB.prepare(
    "SELECT * FROM invites WHERE workspace_id = ? AND used_at IS NULL AND member_id IS NULL AND expires_at > ? ORDER BY created_at DESC",
  )
    .bind(c.get("ws").id, nowIso())
    .all<InviteRow>();
  return c.json(rows.results.map(({ id, email, name, role, created_at, expires_at }) => ({ id, email, name, role, created_at, expires_at })));
});

api.post("/api/invites", async (c) => {
  const me = c.get("me");
  requireAdmin(me);
  const body = await c.req.json<{ email: string; name?: string; role?: "admin" | "member" }>();
  const invite = await createInvite(c.env, me, { email: body.email, name: body.name, role: body.role === "admin" ? "admin" : "member" });
  await logActivity(c.env, c.get("ws").id, c.get("actor"), "member", invite.id, "invited", undefined, { email: body.email });
  return c.json(invite, 201);
});

api.delete("/api/invites/:id", async (c) => {
  requireAdmin(c.get("me"));
  await c.env.DB.prepare("DELETE FROM invites WHERE id = ? AND workspace_id = ? AND used_at IS NULL").bind(c.req.param("id"), c.get("ws").id).run();
  return c.json({ ok: true });
});

api.post("/api/members/:id/reset-link", async (c) => {
  const me = c.get("me");
  requireAdmin(me);
  const target = await getMember(c.env, c.req.param("id"));
  if (target.workspace_id !== c.get("ws").id || target.kind !== "human" || !target.email) throw notFound("Person");
  const link = await createInvite(c.env, me, { email: target.email, memberId: target.id });
  await logActivity(c.env, c.get("ws").id, c.get("actor"), "member", target.id, "reset_link_created");
  return c.json(link, 201);
});

api.post("/api/members/:id/test-ping", async (c) => {
  const agent = await getMember(c.env, c.req.param("id"));
  if (agent.kind !== "agent" || agent.workspace_id !== c.get("ws").id) throw notFound("Agent");
  if (!(await canManageAgent(c.env, c.get("me"), agent))) throw forbidden();
  return c.json(await testPing(c.env, agent));
});

api.get("/api/members/:id/connections", async (c) => {
  const me = c.get("me");
  const target = await getMember(c.env, c.req.param("id"));
  if (target.workspace_id !== c.get("ws").id) throw notFound("Member");
  if (me.id !== target.id && !(await canManageAgent(c.env, me, target))) throw forbidden();
  const grants = await c.env.OAUTH_PROVIDER.listUserGrants(target.id);
  const out = [];
  for (const g of grants.items) {
    const client = await c.env.OAUTH_PROVIDER.lookupClient(g.clientId);
    out.push({
      id: g.id,
      client_name: client?.clientName ?? g.clientId,
      scope: g.scope,
      created_at: g.createdAt ? new Date(g.createdAt * 1000).toISOString() : null,
      connected_by: g.metadata?.connectedByName ?? null,
    });
  }
  return c.json(out);
});

api.delete("/api/members/:id/connections/:grantId", async (c) => {
  const me = c.get("me");
  const target = await getMember(c.env, c.req.param("id"));
  if (target.workspace_id !== c.get("ws").id) throw notFound("Member");
  if (me.id !== target.id && !(await canManageAgent(c.env, me, target))) throw forbidden();
  await c.env.OAUTH_PROVIDER.revokeGrant(c.req.param("grantId"), target.id);
  await logActivity(c.env, c.get("ws").id, c.get("actor"), "member", target.id, "connection_revoked", undefined, {
    grant: c.req.param("grantId"),
  });
  return c.json({ ok: true });
});

// ----- Projects -----
api.get("/api/projects", async (c) => c.json(await listProjects(c.env, c.get("ws").id)));
api.post("/api/projects", async (c) => {
  const b = await c.req.json<{ name: string; description?: string; lead_member_id?: string | null }>();
  const p = await createProject(c.env, c.get("ws"), c.get("actor"), {
    name: b.name,
    description: b.description,
    leadMemberId: b.lead_member_id,
  });
  return c.json(p, 201);
});
api.patch("/api/projects/:id", async (c) => {
  const b = await c.req.json<{ name?: string; description?: string; lead_member_id?: string | null; status?: "active" | "archived" }>();
  return c.json(
    await updateProject(c.env, c.get("ws"), c.get("actor"), c.req.param("id"), {
      name: b.name,
      description: b.description,
      leadMemberId: b.lead_member_id,
      status: b.status,
    }),
  );
});

// ----- Tasks -----
api.get("/api/tasks", async (c) => {
  const q = c.req.query();
  const ws = c.get("ws");
  const tasks = await listTasks(c.env, ws.id, {
    status: q.status ? q.status.split(",") : undefined,
    assigneeId: q.assignee === "me" ? c.get("me").id : q.assignee || undefined,
    projectId: q.project || undefined,
    memberKind: q.kind === "agent" || q.kind === "human" ? q.kind : undefined,
    query: q.q || undefined,
  });
  return c.json(await serializeTasks(c.env, ws, tasks));
});

api.post("/api/tasks", async (c) => {
  const b = await c.req.json<{
    title: string;
    description?: string;
    status?: any;
    priority?: any;
    assignee_id?: string | null;
    project_id?: string | null;
    due_date?: string | null;
    triage?: boolean;
  }>();
  const ws = c.get("ws");
  const task = await createTask(c.env, ws, c.get("actor"), {
    triage: typeof b.triage === "boolean" ? b.triage : undefined,
    title: b.title,
    description: b.description,
    status: b.status,
    priority: b.priority,
    assigneeId: b.assignee_id,
    projectId: b.project_id,
    dueDate: b.due_date,
  });
  const [s] = await serializeTasks(c.env, ws, [task]);
  return c.json(s, 201);
});

api.get("/api/tasks/:ref", async (c) => {
  const ws = c.get("ws");
  const task = await getTaskByRef(c.env, ws.id, c.req.param("ref"));
  const detail = await getTaskDetail(c.env, ws, task);
  await markRead(c.env, c.get("me").id, task.id);
  return c.json(detail);
});

api.patch("/api/tasks/:ref", async (c) => {
  const ws = c.get("ws");
  const task = await getTaskByRef(c.env, ws.id, c.req.param("ref"));
  const b = await c.req.json<Record<string, any>>();
  const next = await updateTask(c.env, ws, c.get("actor"), task, {
    title: b.title,
    description: b.description,
    status: b.status,
    priority: b.priority,
    assigneeId: b.assignee_id,
    projectId: b.project_id,
    dueDate: b.due_date,
    position: b.position,
  });
  const [s] = await serializeTasks(c.env, ws, [next]);
  return c.json(s);
});

api.post("/api/tasks/:ref/entries", async (c) => {
  const ws = c.get("ws");
  const task = await getTaskByRef(c.env, ws.id, c.req.param("ref"));
  const b = await c.req.json<{ type?: "comment" | "update" | "answer"; body: string; reply_to_id?: string }>();
  const entry = await postEntry(c.env, ws, c.get("actor"), task, {
    type: b.type ?? "comment",
    body: b.body,
    replyToId: b.reply_to_id,
  });
  await markRead(c.env, c.get("me").id, task.id);
  return c.json(entry, 201);
});

api.patch("/api/entries/:id", async (c) => {
  const b = await c.req.json<{ body: string }>();
  await editEntry(c.env, c.get("ws"), c.get("actor"), c.req.param("id"), b.body);
  return c.json({ ok: true });
});

api.post("/api/tasks/:ref/notes", async (c) => {
  const ws = c.get("ws");
  const task = await getTaskByRef(c.env, ws.id, c.req.param("ref"));
  const b = await c.req.json<{ title?: string; content?: string }>();
  return c.json(await writeNote(c.env, ws, c.get("actor"), task, { title: b.title, content: b.content }), 201);
});

api.patch("/api/notes/:id", async (c) => {
  const ws = c.get("ws");
  const note = await c.env.DB.prepare(
    "SELECT n.task_id FROM notes n JOIN tasks t ON t.id = n.task_id WHERE n.id = ? AND t.workspace_id = ?",
  )
    .bind(c.req.param("id"), ws.id)
    .first<{ task_id: string }>();
  if (!note) throw notFound("Note");
  const task = await getTaskByRef(c.env, ws.id, note.task_id);
  const b = await c.req.json<{ title?: string; content?: string }>();
  return c.json(await writeNote(c.env, ws, c.get("actor"), task, { noteId: c.req.param("id"), title: b.title, content: b.content }));
});

api.post("/api/tasks/:ref/checklists", async (c) => {
  const ws = c.get("ws");
  const task = await getTaskByRef(c.env, ws.id, c.req.param("ref"));
  const b = await c.req.json<{ title?: string; items?: string[] }>();
  return c.json(await createChecklist(c.env, ws, c.get("actor"), task, b.title ?? "Checklist", b.items ?? []), 201);
});
api.post("/api/checklists/:id/items", async (c) => {
  const b = await c.req.json<{ text: string }>();
  return c.json(await addChecklistItem(c.env, c.get("ws"), c.get("actor"), c.req.param("id"), b.text), 201);
});
api.patch("/api/checklist-items/:id", async (c) => {
  const b = await c.req.json<{ done?: boolean; text?: string }>();
  return c.json(await setChecklistItem(c.env, c.get("ws"), c.get("actor"), c.req.param("id"), b));
});
api.delete("/api/tasks/:ref", async (c) => {
  const ws = c.get("ws");
  const task = await getTaskByRef(c.env, ws.id, c.req.param("ref"));
  await deleteTask(c.env, ws, c.get("actor"), task);
  return c.json({ ok: true });
});
api.delete("/api/notes/:id", async (c) => (await deleteNote(c.env, c.get("ws"), c.get("actor"), c.req.param("id")), c.json({ ok: true })));
api.delete("/api/checklists/:id", async (c) => (await deleteChecklist(c.env, c.get("ws"), c.get("actor"), c.req.param("id")), c.json({ ok: true })));
api.delete("/api/attachments/:id", async (c) => (await deleteAttachment(c.env, c.get("ws"), c.get("actor"), c.req.param("id")), c.json({ ok: true })));
api.delete("/api/entries/:id", async (c) => (await deleteEntry(c.env, c.get("ws"), c.get("actor"), c.req.param("id")), c.json({ ok: true })));

api.delete("/api/checklist-items/:id", async (c) => {
  await deleteChecklistItem(c.env, c.get("ws"), c.get("actor"), c.req.param("id"));
  return c.json({ ok: true });
});

api.post("/api/tasks/:ref/attachments", async (c) => {
  const ws = c.get("ws");
  const task = await getTaskByRef(c.env, ws.id, c.req.param("ref"));
  const form = await c.req.formData();
  const files = form.getAll("file").filter((f): f is File => typeof f !== "string");
  if (!files.length) throw badRequest("No file uploaded");
  const out = [];
  for (const f of files) {
    out.push(
      await addAttachment(c.env, ws, c.get("actor"), task, {
        filename: f.name,
        contentType: f.type || "application/octet-stream",
        data: await f.arrayBuffer(),
        size: f.size,
      }),
    );
  }
  return c.json(out, 201);
});

api.get("/api/attachments/:id", async (c) => streamAttachment(c.env, c.req.param("id"), c.get("ws").id));

// ----- Agent runs -----
api.post("/api/tasks/:ref/wake", async (c) => {
  const ws = c.get("ws");
  const task = await getTaskByRef(c.env, ws.id, c.req.param("ref"));
  const b = await c.req.json<{ agent_id?: string }>().catch(() => ({}) as { agent_id?: string });
  const agentId = b.agent_id ?? task.assignee_id;
  if (!agentId) throw badRequest("No agent to wake");
  const agent = await getMember(c.env, agentId);
  if (agent.kind !== "agent" || agent.workspace_id !== ws.id) throw badRequest("Not an agent");
  const run = await onAgentTrigger(c.env, { task, agent, trigger: "manual", triggeredBy: c.get("me").id });
  return c.json({ run });
});

// Ask the workspace PM agent to pick an assignee for this task.
api.post("/api/tasks/:ref/triage", async (c) => {
  const ws = c.get("ws");
  const task = await getTaskByRef(c.env, ws.id, c.req.param("ref"));
  if (!ws.pm_agent_id) throw badRequest("Choose a PM agent in Workspace settings first");
  const pm = await c.env.DB.prepare("SELECT * FROM members WHERE id = ? AND kind = 'agent' AND active = 1").bind(ws.pm_agent_id).first<MemberRow>();
  if (!pm) throw badRequest("The PM agent is deactivated");
  const run = await onAgentTrigger(c.env, { task, agent: pm, trigger: "triage", triggeredBy: c.get("me").id });
  return c.json({ run });
});

api.post("/api/runs/:id/retry", async (c) => c.json({ run: await retryRun(c.env, c.req.param("id"), c.get("me").id) }));
api.post("/api/runs/:id/dismiss", async (c) => {
  await c.env.DB.prepare(
    `UPDATE agent_runs SET dismissed = 1, status = CASE WHEN status = 'failed' OR status = 'stale' THEN 'ended' ELSE status END
     WHERE id = ? AND task_id IN (SELECT id FROM tasks WHERE workspace_id = ?)`,
  )
    .bind(c.req.param("id"), c.get("ws").id)
    .run();
  await notify(c.env, c.get("ws").id, { type: "runs" });
  return c.json({ ok: true });
});

// ----- Inbox -----
// ----- Record pages: the workspace ("company") and one member ("person") -----

const ENTRY_FEED_SQL = `SELECT e.id, e.task_id, e.author_id, e.type, e.body, e.data, e.created_at, t.number, t.title AS task_title
  FROM thread_entries e JOIN tasks t ON t.id = e.task_id
  WHERE t.workspace_id = ? AND e.type IN ('comment','update','question','answer','note_created','checklist_created','attachment_added')`;

type FeedRow = { id: string; task_id: string; author_id: string; type: string; body: string; data: string; created_at: string; number: number; task_title: string };
const feed = (ws: WorkspaceRow, rows: FeedRow[]) =>
  rows.map((r) => ({ ...r, data: JSON.parse(r.data || "{}"), task_key: `${ws.key_prefix}-${r.number}` }));

api.get("/api/overview", async (c) => {
  const ws = c.get("ws");
  const db = c.env.DB;
  const [byStatus, byMember, recent, runs, weekDone, questions] = await Promise.all([
    db.prepare("SELECT status, COUNT(*) AS n FROM tasks WHERE workspace_id = ? GROUP BY status").bind(ws.id).all<{ status: string; n: number }>(),
    db
      .prepare(
        `SELECT assignee_id AS member_id,
           SUM(CASE WHEN status IN ('backlog','todo','in_progress','waiting_on_human') THEN 1 ELSE 0 END) AS open,
           SUM(CASE WHEN status = 'waiting_on_human' THEN 1 ELSE 0 END) AS waiting,
           SUM(CASE WHEN status = 'done' AND completed_at > ? THEN 1 ELSE 0 END) AS done_7d
         FROM tasks WHERE workspace_id = ? AND assignee_id IS NOT NULL GROUP BY assignee_id`,
      )
      .bind(new Date(Date.now() - 7 * 86400_000).toISOString(), ws.id)
      .all<{ member_id: string; open: number; waiting: number; done_7d: number }>(),
    db.prepare(`${ENTRY_FEED_SQL} ORDER BY e.created_at DESC LIMIT 25`).bind(ws.id).all<FeedRow>(),
    db
      .prepare(
        `SELECT r.id, r.agent_id, r.status, r.trigger, r.created_at, r.last_activity_at, t.number, t.title AS task_title
         FROM agent_runs r JOIN tasks t ON t.id = r.task_id
         WHERE t.workspace_id = ? AND r.status IN ('queued','dispatched','active') ORDER BY r.created_at DESC LIMIT 20`,
      )
      .bind(ws.id)
      .all<{ id: string; agent_id: string; status: string; trigger: string; created_at: string; last_activity_at: string | null; number: number; task_title: string }>(),
    db
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE workspace_id = ? AND status = 'done' AND completed_at > ?")
      .bind(ws.id, new Date(Date.now() - 7 * 86400_000).toISOString())
      .first<{ n: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM thread_entries e JOIN tasks t ON t.id = e.task_id
         WHERE t.workspace_id = ? AND e.type = 'question' AND json_extract(e.data, '$.state') = 'open'`,
      )
      .bind(ws.id)
      .first<{ n: number }>(),
  ]);
  return c.json({
    workspace: { id: ws.id, name: ws.name, key_prefix: ws.key_prefix, created_at: ws.created_at },
    by_status: Object.fromEntries(byStatus.results.map((r) => [r.status, r.n])),
    by_member: byMember.results,
    done_7d: weekDone?.n ?? 0,
    open_questions: questions?.n ?? 0,
    active_runs: runs.results.map((r) => ({ ...r, task_key: `${ws.key_prefix}-${r.number}` })),
    recent: feed(ws, recent.results),
  });
});

api.get("/api/members/:id/record", async (c) => {
  const ws = c.get("ws");
  const ref = c.req.param("id");
  const m = await c.env.DB.prepare("SELECT * FROM members WHERE workspace_id = ? AND (id = ? OR handle = ?)").bind(ws.id, ref, ref).first<MemberRow>();
  if (!m) throw notFound("Member");
  const db = c.env.DB;
  const [counts, recent, runs, created] = await Promise.all([
    db
      .prepare(
        `SELECT
           SUM(CASE WHEN status IN ('backlog','todo','in_progress','waiting_on_human') THEN 1 ELSE 0 END) AS open,
           SUM(CASE WHEN status = 'waiting_on_human' THEN 1 ELSE 0 END) AS waiting,
           SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
           SUM(CASE WHEN status = 'done' AND completed_at > ? THEN 1 ELSE 0 END) AS done_7d
         FROM tasks WHERE workspace_id = ? AND assignee_id = ?`,
      )
      .bind(new Date(Date.now() - 7 * 86400_000).toISOString(), ws.id, m.id)
      .first<{ open: number; waiting: number; done: number; done_7d: number }>(),
    db.prepare(`${ENTRY_FEED_SQL} AND e.author_id = ? ORDER BY e.created_at DESC LIMIT 40`).bind(ws.id, m.id).all<FeedRow>(),
    m.kind === "agent"
      ? db
          .prepare(
            `SELECT r.id, r.status, r.trigger, r.attempts, r.last_error, r.created_at, r.dispatched_at, r.last_activity_at, r.ended_at, t.number, t.title AS task_title
             FROM agent_runs r JOIN tasks t ON t.id = r.task_id WHERE r.agent_id = ? ORDER BY r.created_at DESC LIMIT 30`,
          )
          .bind(m.id)
          .all<Record<string, unknown> & { number: number }>()
      : Promise.resolve({ results: [] as (Record<string, unknown> & { number: number })[] }),
    db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE workspace_id = ? AND created_by = ?").bind(ws.id, m.id).first<{ n: number }>(),
  ]);
  const creator = m.created_by ? await c.env.DB.prepare("SELECT id, name, handle, kind, avatar_url FROM members WHERE id = ?").bind(m.created_by).first() : null;
  const subAgents = m.kind === "agent" ? (await listSubAgents(c.env, m.id)).map(publicMember) : [];
  return c.json({
    member: { ...publicMember(m), created_at: m.created_at },
    created_by: creator,
    sub_agents: subAgents,
    can_manage: m.kind === "agent" && (await canManageAgent(c.env, c.get("me"), m)),
    stats: { open: counts?.open ?? 0, waiting: counts?.waiting ?? 0, done: counts?.done ?? 0, done_7d: counts?.done_7d ?? 0, created: created?.n ?? 0 },
    recent: feed(ws, recent.results),
    runs: runs.results.map((r) => ({ ...r, task_key: `${ws.key_prefix}-${r.number}` })),
  });
});

// ----- Saved views (shared across the workspace) -----
type ViewRow = { id: string; workspace_id: string; name: string; config: string; created_by: string; position: number; created_at: string; updated_at: string };
const viewOut = (v: ViewRow) => ({ ...v, config: JSON.parse(v.config || "{}") });
const viewConfig = (raw: unknown) => {
  const text = JSON.stringify(raw ?? {});
  if (text.length > 4000) throw badRequest("View is too large");
  return text;
};
async function getView(c: { env: AppEnv; get: (k: "ws") => WorkspaceRow }, id: string) {
  const v = await c.env.DB.prepare("SELECT * FROM views WHERE id = ? AND workspace_id = ?").bind(id, c.get("ws").id).first<ViewRow>();
  if (!v) throw notFound("View");
  return v;
}

api.get("/api/views", async (c) => {
  const rows = await c.env.DB.prepare("SELECT * FROM views WHERE workspace_id = ? ORDER BY position, created_at").bind(c.get("ws").id).all<ViewRow>();
  return c.json(rows.results.map(viewOut));
});

api.post("/api/views", async (c) => {
  const body = await c.req.json<{ name?: string; config?: unknown }>();
  const name = body.name?.trim();
  if (!name || name.length > 60) throw badRequest("Give the view a name (up to 60 characters)");
  const ws = c.get("ws");
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM views WHERE workspace_id = ?").bind(ws.id).first<{ n: number }>();
  if ((count?.n ?? 0) >= 100) throw badRequest("This workspace already has 100 views");
  const now = nowIso();
  const id = newId();
  await c.env.DB.prepare("INSERT INTO views (id, workspace_id, name, config, created_by, position, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .bind(id, ws.id, name, viewConfig(body.config), c.get("me").id, Date.now(), now, now)
    .run();
  await notify(c.env, ws.id, { type: "views" });
  return c.json(viewOut((await getView(c, id))), 201);
});

api.patch("/api/views/:id", async (c) => {
  const v = await getView(c, c.req.param("id"));
  const body = await c.req.json<{ name?: string; config?: unknown }>();
  const name = body.name === undefined ? v.name : body.name.trim();
  if (!name || name.length > 60) throw badRequest("Give the view a name (up to 60 characters)");
  const config = body.config === undefined ? v.config : viewConfig(body.config);
  await c.env.DB.prepare("UPDATE views SET name = ?, config = ?, updated_at = ? WHERE id = ?").bind(name, config, nowIso(), v.id).run();
  await notify(c.env, c.get("ws").id, { type: "views" });
  return c.json(viewOut(await getView(c, v.id)));
});

api.delete("/api/views/:id", async (c) => {
  const v = await getView(c, c.req.param("id"));
  const me = c.get("me");
  if (me.role !== "admin" && v.created_by !== me.id) throw forbidden("Only admins or whoever made this view can delete it");
  await c.env.DB.prepare("DELETE FROM views WHERE id = ?").bind(v.id).run();
  await notify(c.env, c.get("ws").id, { type: "views" });
  return c.json({ ok: true });
});

api.get("/api/inbox", async (c) => c.json(await getInbox(c.env, c.get("ws"), c.get("me"))));
