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
  const ws = me ? await ensureWorkspace(c.env) : null;
  return c.json({
    member: me ? publicMember(me) : null,
    workspace: ws ? { id: ws.id, name: ws.name, key_prefix: ws.key_prefix } : null,
    auth: { google: !!c.env.GOOGLE_CLIENT_ID, setup: me ? false : await needsSetup(c.env) },
  });
});

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
  if (me.role !== "admin" && target.id !== me.id && target.created_by !== me.id) throw forbidden();
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
  if (c.get("me").role !== "admin" && agent.created_by !== c.get("me").id) throw forbidden();
  return c.json(await testPing(c.env, agent));
});

api.get("/api/members/:id/connections", async (c) => {
  const me = c.get("me");
  const target = await getMember(c.env, c.req.param("id"));
  if (target.workspace_id !== c.get("ws").id) throw notFound("Member");
  if (me.role !== "admin" && me.id !== target.id && target.created_by !== me.id) throw forbidden();
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
  if (me.role !== "admin" && me.id !== target.id && target.created_by !== me.id) throw forbidden();
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
  }>();
  const ws = c.get("ws");
  const task = await createTask(c.env, ws, c.get("actor"), {
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
api.get("/api/inbox", async (c) => c.json(await getInbox(c.env, c.get("ws"), c.get("me"))));
