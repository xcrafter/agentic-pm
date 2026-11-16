/**
 * MCP server (Streamable HTTP, stateless). Every call acts as the member bound to the
 * OAuth token: an agent member (e.g. Grok Bot) or a human using their own assistant.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import {
  type Actor,
  type EntryRow,
  type MemberRow,
  PRIORITIES,
  TASK_STATUSES,
  addAttachment,
  addChecklistItem,
  createChecklist,
  createTask,
  findMemberByRef,
  getTaskByRef,
  getTaskDetail,
  getWorkspace,
  listProjects,
  listTasks,
  logActivity,
  notify,
  markRead,
  postEntry,
  publicMember,
  serializeTasks,
  setChecklistItem,
  updateTask,
  writeNote,
  MAX_ATTACHMENT_BYTES,
} from "./domain";
import { endRunsFor, failRunsFor, touchRun } from "./orchestrator";
import { POST_KINDS, createPost, listPosts } from "./feed";
import { agentSummary, applyAgentProfile, canOrchestrate, getActableAgent, getSubAgent, isWorkspacePm, listSubAgents, registerSubAgent } from "./agents";
import type { McpProps } from "./authorize";
import { type AppEnv, HttpError, encryptSecret, signValue } from "./util";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

async function guard(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    const message = err instanceof HttpError ? err.message : err instanceof Error ? err.message : String(err);
    if (!(err instanceof HttpError)) console.error("MCP tool error", err);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
}

const AS_AGENT_HELP =
  "Optional. Handle of one of your registered agents (see list_my_agents) to act as for this call. " +
  "When a webhook wakes one of your agents, its payload includes as_agent: pass that value on every call for that task.";

function buildServer(env: AppEnv, props: McpProps, me: MemberRow, orchestrate: boolean, connectedAs: MemberRow, isPm = false) {
  const actor: Actor = { member: me, via: "mcp" };
  const ws = () => getWorkspace(env, props.workspaceId);
  const acting = connectedAs.id !== me.id;
  const server = new McpServer(
    { name: "agentic-pm", version: "1.0.0" },
    {
      instructions:
        `Agentic PM is the team's task tracker and system of record. You are connected as ${connectedAs.name} (@${connectedAs.handle}, ${connectedAs.kind}). ` +
        `Tasks are referenced by key, e.g. IMP-42. Typical loop: get_task → work → post_update as you go → ` +
        `ask_question if you need a human (then stop; you'll be woken when they answer) → complete_task with a summary. ` +
        `If something goes wrong and you can't continue, call end_run with outcome "failed" (or "blocked") and the reason, so humans see it. ` +
        `When you finish recurring work outside a task (e.g. a daily blog), post one line with share_update (set routine, e.g. "daily-blog", and link the result).` +
        (isPm
          ? ` You are the workspace PM: you're woken for new unassigned tasks (assign each to the best agent; check list_members) ` +
            `and for any agent without its own webhook (the payload's as_agent says which). You can act as any agent by passing as_agent, ` +
            `and assigning a task to an agent wakes it.`
          : "") +
        (orchestrate || acting
          ? ` You are an orchestrator: register the other agents you run with register_agent (each gets its own webhook), ` +
            `assign tasks to them or @mention them to wake them, and act as one of them by passing as_agent on any tool call.`
          : ""),
    },
  );

  // Orchestrators may act as one of their sub-agents on any call: add `as_agent` to every tool's input.
  // (The identity switch itself happens in mcpHandler before this server is built.)
  if (orchestrate || acting) {
    const register = server.registerTool.bind(server) as (...args: any[]) => unknown;
    (server as any).registerTool = (name: string, config: any, cb: any) =>
      register(name, { ...config, inputSchema: { ...(config.inputSchema ?? {}), as_agent: z.string().optional().describe(AS_AGENT_HELP) } }, cb);
  }

  const memberNames = async () => {
    const rows = await env.DB.prepare("SELECT id, name, handle, kind FROM members WHERE workspace_id = ?")
      .bind(props.workspaceId)
      .all<{ id: string; name: string; handle: string; kind: string }>();
    return new Map(rows.results.map((m) => [m.id, m]));
  };

  const compactEntry = (e: EntryRow & { data: any }, names: Map<string, { name: string; handle: string; kind: string }>) => {
    const a = names.get(e.author_id);
    const base: Record<string, unknown> = {
      id: e.id,
      type: e.type,
      author: a ? `${a.name} (@${a.handle}, ${a.kind})` : e.author_id,
      at: e.created_at,
    };
    if (e.data?.deleted) return { ...base, deleted: true };
    if (e.body) base.body = e.body;
    if (e.reply_to_id) base.reply_to = e.reply_to_id;
    if (e.type === "system" || e.type.endsWith("_created") || e.type === "attachment_added" || e.type === "question") {
      const { actor_known, ...rest } = e.data ?? {};
      if (Object.keys(rest).length) base.data = rest;
    }
    return base;
  };

  server.registerTool(
    "list_my_tasks",
    {
      description: "List tasks assigned to you. Defaults to tasks that are not done or canceled.",
      inputSchema: { status: z.array(z.enum(TASK_STATUSES)).optional().describe("Filter by status") },
      annotations: { readOnlyHint: true },
    },
    ({ status }) =>
      guard(async () => {
        const w = await ws();
        const rows = await listTasks(env, w.id, {
          assigneeId: me.id,
          status: status?.length ? status : ["backlog", "todo", "in_progress", "waiting_on_human"],
        });
        return (await serializeTasks(env, w, rows)).map(({ description, ...t }) => t);
      }),
  );

  server.registerTool(
    "get_task",
    {
      description:
        "Read a task: fields, description, notes, checklists, attachments, open questions, recent thread, and 'unread' activity since you last read it. Call this first when woken.",
      inputSchema: { task: z.string().describe("Task key (e.g. IMP-42) or id") },
    },
    ({ task }) =>
      guard(async () => {
        const w = await ws();
        const t = await getTaskByRef(env, w.id, task);
        const cursor = await env.DB.prepare("SELECT last_read_at FROM read_cursors WHERE member_id = ? AND task_id = ?")
          .bind(me.id, t.id)
          .first<{ last_read_at: string }>();
        const detail = await getTaskDetail(env, w, t);
        const names = await memberNames();
        const entries = detail.entries as (EntryRow & { data: any })[];
        const unread = entries.filter((e) => e.author_id !== me.id && (!cursor || e.created_at > cursor.last_read_at));
        const recent = entries.slice(-50);
        await markRead(env, me.id, t.id);
        if (me.kind === "agent") await touchRun(env, t.id, me.id);
        return {
          task: detail.task,
          open_questions: entries
            .filter((e) => e.type === "question" && e.data?.state === "open")
            .map((e) => compactEntry(e, names)),
          notes: detail.notes,
          checklists: detail.checklists,
          attachments: detail.attachments,
          unread: unread.slice(-200).map((e) => compactEntry(e, names)),
          thread: recent.map((e) => compactEntry(e, names)),
          thread_total: entries.length,
        };
      }),
  );

  server.registerTool(
    "search_tasks",
    {
      description: "Search tasks by text and filters.",
      inputSchema: {
        query: z.string().optional(),
        status: z.array(z.enum(TASK_STATUSES)).optional(),
        assignee: z.string().optional().describe("Member handle, id, or 'none'"),
        project: z.string().optional().describe("Project id or 'none'"),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    (a) =>
      guard(async () => {
        const w = await ws();
        const assigneeId = a.assignee ? (a.assignee === "none" ? "none" : (await findMemberByRef(env, w.id, a.assignee)).id) : undefined;
        const rows = await listTasks(env, w.id, {
          query: a.query,
          status: a.status,
          assigneeId,
          projectId: a.project,
          limit: a.limit ?? 25,
        });
        return (await serializeTasks(env, w, rows)).map(({ description, ...t }) => t);
      }),
  );

  server.registerTool(
    "create_task",
    {
      description: "Create a new task. Assigning it to a human does not wake anyone; agents you assign are not woken by you.",
      inputSchema: {
        title: z.string(),
        description: z.string().optional().describe("Markdown"),
        project: z.string().optional().describe("Project id"),
        assignee: z.string().optional().describe("Member handle or id"),
        priority: z.enum(PRIORITIES).optional(),
        status: z.enum(TASK_STATUSES).optional(),
      },
    },
    (a) =>
      guard(async () => {
        const w = await ws();
        const assigneeId = a.assignee ? (await findMemberByRef(env, w.id, a.assignee)).id : null;
        const t = await createTask(env, w, actor, {
          title: a.title,
          description: a.description,
          projectId: a.project ?? null,
          assigneeId,
          priority: a.priority,
          status: a.status,
        });
        return (await serializeTasks(env, w, [t]))[0];
      }),
  );

  server.registerTool(
    "update_task",
    {
      description: "Update task fields. Use complete_task to finish a task with a summary.",
      inputSchema: {
        task: z.string(),
        title: z.string().optional(),
        description: z.string().optional().describe("Markdown; replaces the description"),
        status: z.enum(TASK_STATUSES).optional(),
        priority: z.enum(PRIORITIES).optional(),
        assignee: z.string().nullable().optional().describe("Member handle/id, or null to unassign"),
        project: z.string().nullable().optional().describe("Project id, or null"),
        due_date: z.string().nullable().optional().describe("YYYY-MM-DD or null"),
      },
    },
    (a) =>
      guard(async () => {
        const w = await ws();
        const t = await getTaskByRef(env, w.id, a.task);
        const assigneeId =
          a.assignee === undefined ? undefined : a.assignee === null ? null : (await findMemberByRef(env, w.id, a.assignee)).id;
        const next = await updateTask(env, w, actor, t, {
          title: a.title,
          description: a.description,
          status: a.status,
          priority: a.priority,
          assigneeId,
          projectId: a.project,
          dueDate: a.due_date,
        });
        return (await serializeTasks(env, w, [next]))[0];
      }),
  );

  server.registerTool(
    "post_update",
    {
      description: "Post a progress update to the task thread (what you did, what's next). Markdown supported.",
      inputSchema: { task: z.string(), body: z.string() },
    },
    ({ task, body }) =>
      guard(async () => {
        const w = await ws();
        const e = await postEntry(env, w, actor, await getTaskByRef(env, w.id, task), { type: "update", body });
        return { id: e.id, posted: true };
      }),
  );

  server.registerTool(
    "add_comment",
    {
      description: "Post a comment on the task thread. Use reply_to with a question's id to answer it.",
      inputSchema: { task: z.string(), body: z.string(), reply_to: z.string().optional() },
    },
    ({ task, body, reply_to }) =>
      guard(async () => {
        const w = await ws();
        const e = await postEntry(env, w, actor, await getTaskByRef(env, w.id, task), {
          type: "comment",
          body,
          replyToId: reply_to,
        });
        return { id: e.id, type: e.type, posted: true };
      }),
  );

  server.registerTool(
    "ask_question",
    {
      description:
        "Ask a human a question on the task. The task moves to 'waiting_on_human' and your run ends. You will be woken (via your webhook) when someone answers. Stop working on this task after calling this.",
      inputSchema: {
        task: z.string(),
        body: z.string().describe("The question, with enough context for a human to answer quickly"),
        addressed_to: z.string().optional().describe("Handle or id of the human who should answer (default: task creator)"),
      },
    },
    ({ task, body, addressed_to }) =>
      guard(async () => {
        if (me.kind !== "agent") throw new HttpError(400, "ask_question is for agent members; humans can use add_comment");
        const w = await ws();
        const e = await postEntry(env, w, actor, await getTaskByRef(env, w.id, task), {
          type: "question",
          body,
          addressedTo: addressed_to,
        });
        return { id: e.id, status: "waiting_on_human", note: "Question posted. Stop now; you will be woken when it is answered." };
      }),
  );

  server.registerTool(
    "write_note",
    {
      description: "Create a note (rich Markdown document) on a task, or replace an existing note's content by note_id.",
      inputSchema: {
        task: z.string(),
        title: z.string().optional(),
        content: z.string().describe("Markdown"),
        note_id: z.string().optional(),
      },
    },
    (a) =>
      guard(async () => {
        const w = await ws();
        return writeNote(env, w, actor, await getTaskByRef(env, w.id, a.task), {
          noteId: a.note_id,
          title: a.title,
          content: a.content,
        });
      }),
  );

  server.registerTool(
    "create_checklist",
    {
      description: "Create a checklist on a task.",
      inputSchema: { task: z.string(), title: z.string(), items: z.array(z.string()) },
    },
    (a) =>
      guard(async () => {
        const w = await ws();
        return createChecklist(env, w, actor, await getTaskByRef(env, w.id, a.task), a.title, a.items);
      }),
  );

  server.registerTool(
    "set_checklist_item",
    {
      description: "Tick or untick a checklist item (ids come from get_task).",
      inputSchema: { item_id: z.string(), done: z.boolean() },
    },
    (a) => guard(async () => setChecklistItem(env, await ws(), actor, a.item_id, { done: a.done })),
  );

  server.registerTool(
    "add_checklist_item",
    {
      description: "Add an item to an existing checklist.",
      inputSchema: { checklist_id: z.string(), text: z.string() },
    },
    (a) => guard(async () => addChecklistItem(env, await ws(), actor, a.checklist_id, a.text)),
  );

  server.registerTool(
    "attach_file",
    {
      description: "Attach a file to a task (max 25 MB). Provide content_base64 or a public source_url.",
      inputSchema: {
        task: z.string(),
        filename: z.string(),
        content_type: z.string().optional(),
        content_base64: z.string().optional(),
        source_url: z.string().url().optional(),
      },
    },
    (a) =>
      guard(async () => {
        const w = await ws();
        const t = await getTaskByRef(env, w.id, a.task);
        let data: ArrayBuffer;
        let contentType = a.content_type;
        if (a.content_base64) {
          const bin = atob(a.content_base64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          data = bytes.buffer;
        } else if (a.source_url) {
          if (!/^https:\/\//.test(a.source_url)) throw new HttpError(400, "source_url must be https");
          const res = await fetch(a.source_url, { signal: AbortSignal.timeout(30_000) });
          if (!res.ok) throw new HttpError(400, `Could not fetch source_url (HTTP ${res.status})`);
          const len = Number(res.headers.get("content-length") ?? 0);
          if (len > MAX_ATTACHMENT_BYTES) throw new HttpError(413, "File is larger than 25 MB");
          data = await res.arrayBuffer();
          contentType ??= res.headers.get("content-type") ?? undefined;
        } else {
          throw new HttpError(400, "Provide content_base64 or source_url");
        }
        return addAttachment(env, w, actor, t, {
          filename: a.filename,
          contentType: contentType || "application/octet-stream",
          data,
          size: data.byteLength,
        });
      }),
  );

  server.registerTool(
    "get_attachment",
    {
      description: "Get a short-lived (15 min) download URL for an attachment.",
      inputSchema: { attachment_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    ({ attachment_id }) =>
      guard(async () => {
        const a = await env.DB.prepare(
          "SELECT a.id, a.filename, a.content_type, a.size FROM attachments a JOIN tasks t ON t.id = a.task_id WHERE a.id = ? AND t.workspace_id = ?",
        )
          .bind(attachment_id, props.workspaceId)
          .first<{ id: string; filename: string; content_type: string; size: number }>();
        if (!a) throw new HttpError(404, "Attachment not found");
        const exp = Math.floor(Date.now() / 1000) + 900;
        const sig = await signValue(env, `${a.id}.${exp}`);
        return { ...a, url: `${env.PUBLIC_URL.replace(/\/$/, "")}/files/${a.id}?exp=${exp}&sig=${sig}` };
      }),
  );

  server.registerTool(
    "complete_task",
    {
      description: "Finish a task: posts your summary as an update, sets status to done, and ends your run.",
      inputSchema: { task: z.string(), summary: z.string().describe("What was done, results, links") },
    },
    ({ task, summary }) =>
      guard(async () => {
        const w = await ws();
        const t = await getTaskByRef(env, w.id, task);
        await postEntry(env, w, actor, t, { type: "update", body: summary });
        const fresh = await getTaskByRef(env, w.id, t.id);
        await updateTask(env, w, actor, fresh, { status: "done", summary });
        if (me.kind === "agent") await endRunsFor(env, t.id, me.id, "completed");
        return { status: "done" };
      }),
  );

  server.registerTool(
    "end_run",
    {
      description:
        "End your current run on a task without completing it. Posts the reason. Use outcome \"failed\" when something went wrong " +
        "(error, missing access, a tool broke) or \"blocked\" when you can't proceed: both flag the task in red for humans. " +
        "Use \"handed_back\" (default) for a normal stop.",
      inputSchema: {
        task: z.string(),
        reason: z.string(),
        outcome: z.enum(["handed_back", "blocked", "failed"]).optional(),
      },
    },
    ({ task, reason, outcome }) =>
      guard(async () => {
        const w = await ws();
        const t = await getTaskByRef(env, w.id, task);
        await postEntry(env, w, actor, t, { type: "update", body: reason });
        if (me.kind === "agent") {
          if (outcome === "failed" || outcome === "blocked") await failRunsFor(env, t.id, me.id, `${outcome === "failed" ? "Failed" : "Blocked"}: ${reason}`);
          else await endRunsFor(env, t.id, me.id, "ended_by_agent");
        }
        return { ended: true, flagged: outcome === "failed" || outcome === "blocked" };
      }),
  );

  if (me.kind === "agent") {
    server.registerTool(
      "update_my_profile",
      {
        description:
          "Set up your own agent profile: display name, a description of what you're good at (shown to humans when they pick an assignee), " +
          "and the webhook the platform should POST to when it needs to wake you (e.g. your Grok Bot routine's webhook URL and key). " +
          "Only the fields you pass are changed.",
        inputSchema: {
          name: z.string().min(1).max(60).optional(),
          description: z.string().max(500).optional(),
          webhook_url: z.string().url().optional().describe("https URL to wake you; empty string clears it"),
          webhook_key: z.string().min(8).optional().describe("Sent as Authorization: Bearer <key>"),
          wake_on_mention: z.boolean().optional(),
        },
      },
      (input) =>
        guard(async () => {
          const fresh = await applyAgentProfile(env, actor, me, input);
          return agentSummary(fresh);
        }),
    );
  }

  if (orchestrate && !acting) {
    const profileFields = {
      description: z.string().max(500).optional().describe("What this agent is good at; shown to humans picking an assignee"),
      webhook_url: z.string().optional().describe("https URL that wakes this agent (e.g. its Grok Bot routine webhook)"),
      webhook_key: z.string().min(8).optional().describe("Sent as Authorization: Bearer <key>"),
      wake_on_mention: z.boolean().optional(),
    };
    server.registerTool(
      "register_agent",
      {
        description:
          "Add one of the agents you run (e.g. another Grok Bot agent or routine) as a member of this workspace, managed by you. " +
          "Humans can then assign it tasks; you can assign it tasks or @mention it to wake it, and act as it with as_agent. " +
          "Give it its own webhook so the platform can wake it directly.",
        inputSchema: {
          name: z.string().min(1).max(60),
          handle: z.string().max(40).optional().describe("Preferred @handle; made unique if taken"),
          ...profileFields,
        },
      },
      (input) =>
        guard(async () => {
          const agent = await registerSubAgent(env, me, input);
          return agentSummary(agent);
        }),
    );
    server.registerTool(
      "list_my_agents",
      { description: "List the agents you've registered (your sub-agents).", annotations: { readOnlyHint: true } },
      () => guard(async () => (await listSubAgents(env, me.id)).map(agentSummary)),
    );
    server.registerTool(
      "update_agent",
      {
        description: "Change one of your registered agents: name, description, webhook, wake on mention, or deactivate it (active: false).",
        inputSchema: {
          agent: z.string().describe("Handle of one of your agents"),
          name: z.string().min(1).max(60).optional(),
          active: z.boolean().optional(),
          ...profileFields,
        },
      },
      ({ agent, ...input }) =>
        guard(async () => {
          const target = await getSubAgent(env, me, agent);
          return agentSummary(await applyAgentProfile(env, actor, target, input));
        }),
    );
  }

  server.registerTool(
    "share_update",
    {
      description:
        "Post a short update to the workspace feed, visible to the whole team. Use it when you finish something worth knowing " +
        "(\"Published today's blog: <title>\"), ship work outside a task, or hit a blocker. For recurring work, set routine " +
        "(e.g. \"daily-blog\") so people can see how consistently it happens. Completing a task already posts automatically.",
      inputSchema: {
        body: z.string().min(1).max(4000).describe("What happened, in a sentence or two. Markdown is fine."),
        kind: z.enum(POST_KINDS).optional().describe("update (default), done (finished something) or blocker (stuck)"),
        task: z.string().optional().describe("Related task key, e.g. IMP-42"),
        link: z.string().optional().describe("URL of the result, e.g. the published blog post"),
        routine: z.string().max(40).optional().describe("Name of the recurring job this belongs to, e.g. daily-blog"),
      },
    },
    (input) =>
      guard(async () => {
        const w = await ws();
        const p = await createPost(env, w, actor, { body: input.body, kind: input.kind, taskRef: input.task, link: input.link, routine: input.routine });
        return { id: p.id, kind: p.kind, routine: p.routine, posted: true };
      }),
  );

  server.registerTool(
    "read_feed",
    {
      description: "Read recent workspace feed updates from people and agents (newest first).",
      inputSchema: {
        author: z.string().optional().describe("Only this member's updates (handle)"),
        routine: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    (input) =>
      guard(async () => {
        const w = await ws();
        const names = await memberNames();
        const posts = await listPosts(env, w, me, { author: input.author, routine: input.routine, limit: input.limit ?? 20 });
        return posts.map((p) => {
          const a = names.get(p.author_id);
          return {
            author: a ? `${a.name} (@${a.handle}, ${a.kind})` : p.author_id,
            kind: p.kind,
            body: p.body,
            at: p.created_at,
            ...(p.task ? { task: p.task.key } : {}),
            ...(p.link_url ? { link: p.link_url } : {}),
            ...(p.routine ? { routine: p.routine } : {}),
            ...(p.reactions.length ? { reactions: p.reactions.map((r) => `${r.emoji}${r.count}`).join(" ") } : {}),
          };
        });
      }),
  );

  server.registerTool(
    "list_projects",
    { description: "List projects.", annotations: { readOnlyHint: true } },
    () => guard(async () => listProjects(env, props.workspaceId)),
  );

  server.registerTool(
    "list_members",
    { description: "List members (humans and agents) with handles and descriptions.", annotations: { readOnlyHint: true } },
    () =>
      guard(async () => {
        const rows = await env.DB.prepare("SELECT * FROM members WHERE workspace_id = ? AND active = 1 ORDER BY kind, name")
          .bind(props.workspaceId)
          .all<MemberRow>();
        return rows.results.map((m) => {
          const p = publicMember(m);
          return { id: p.id, kind: p.kind, name: p.name, handle: p.handle, role: p.role, description: p.description };
        });
      }),
  );

  return server;
}

export const mcpHandler = {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext & { props?: McpProps }): Promise<Response> {
    const props = ctx.props;
    if (!props?.memberId) return new Response("Unauthorized", { status: 401 });
    const me = await env.DB.prepare("SELECT * FROM members WHERE id = ? AND workspace_id = ? AND active = 1")
      .bind(props.memberId, props.workspaceId)
      .first<MemberRow>();
    if (!me) return new Response("Member is inactive or removed", { status: 403 });
    if (request.method === "GET") {
      // Stateless server: no standalone SSE stream.
      return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
    }
    // An orchestrator agent can act as one of its sub-agents: `as_agent` on a tools/call.
    let actingAs = me;
    let forward: Request = request;
    if (me.kind === "agent" && request.method === "POST") {
      const text = await request.text();
      forward = new Request(request, { body: text });
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      const msgs = (Array.isArray(parsed) ? parsed : [parsed]) as { method?: string; params?: { arguments?: Record<string, unknown> } }[];
      const refs = new Set(
        msgs
          .filter((m) => m?.method === "tools/call" && typeof m.params?.arguments?.as_agent === "string" && m.params.arguments.as_agent)
          .map((m) => String(m.params!.arguments!.as_agent).replace(/^@/, "").toLowerCase()),
      );
      refs.delete(me.handle);
      if (refs.size > 1) return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32602, message: "One as_agent per request" } }, { status: 400 });
      if (refs.size === 1) {
        const ref = [...refs][0];
        try {
          actingAs = await getActableAgent(env, me, ref);
        } catch (err) {
          return Response.json(
            { jsonrpc: "2.0", id: (msgs[0] as any)?.id ?? null, result: { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true } },
          );
        }
        if (!actingAs.active) {
          return Response.json(
            { jsonrpc: "2.0", id: (msgs[0] as any)?.id ?? null, result: { content: [{ type: "text", text: `Error: @${actingAs.handle} is deactivated` }], isError: true } },
          );
        }
      }
    }
    const isPm = await isWorkspacePm(env, me);
    const orchestrate = isPm || (await canOrchestrate(env, me));
    const server = buildServer(env, props, actingAs, orchestrate, me, isPm);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(forward);
  },
};
