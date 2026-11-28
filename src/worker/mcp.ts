/**
 * MCP server (Streamable HTTP, stateless). Every call acts as the member bound to the
 * OAuth token: an agent member (e.g. Grok Bot) or a human using their own assistant.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { addDependency, dependenciesOf, reactToEntry, removeDependency } from "./links";
import {
  type Actor,
  type EntryRow,
  type MemberRow,
  PRIORITIES,
  addAttachment,
  addChecklistItem,
  createChecklist,
  createTask,
  findMemberByRef,
  getTaskByRef,
  getTaskDetail,
  getWorkspace,
  listProjects,
  updateProject,
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
import { IDEA_LABELS, IDEA_STAGES, IDEA_STATUSES, createIdea, listIdeas } from "./ideas";
import { logFeatureRequest } from "./customers";
import { callApi } from "./api";
import { addTool, getTool, listTools, toolOut, updateTool } from "./tools";
import { listLabels, listStatuses } from "./taxonomy";
import { assertPoliciesRead, createPolicy, ensureFolderPath, findPolicy, listPoliciesForAgent, markPolicyRead, policiesFor, policyForAgent, updatePolicy } from "./policies";
import { agentSummary, applyAgentProfile, canOrchestrate, getActableAgent, getSubAgent, isWorkspacePm, listSubAgents, registerSubAgent } from "./agents";
import type { McpProps } from "./authorize";
import { type AppEnv, HttpError, encryptSecret, signValue } from "./util";

const STATUS_HELP =
  "Status key or name: backlog, todo, in_progress, waiting_on_human, done, canceled, or one of the workspace's custom statuses (see list_statuses)";
const STATUS = z.string().describe(STATUS_HELP);
const LABELS = z.array(z.string()).describe("Label names (or ids). Unknown names create new labels.");

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
        ` The workspace keeps policies (SOPs, guidelines, strategies) that tell you how work must be done. get_task lists the ones that apply to you; ` +
        `read them with get_policy before acting and follow them. Required ones must be read in their latest version before you can change anything; ` +
        `if a tool says so, read what it names and retry. Use list_policies to search the rest when unsure how something should be done; ` +
        `write or improve policies with create_policy / update_policy when asked to.` +
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

  // Tools that change work are gated on the agent having read its required policies (latest version).
  const GATED = new Set([
    "create_task", "update_task", "post_update", "add_comment", "write_note", "create_checklist",
    "set_checklist_item", "add_checklist_item", "attach_file", "complete_task", "share_update",
    "create_project", "update_project", "convert_idea", "create_share_link", "update_note", "duplicate_task",
  ]);
  {
    const registerGated = server.registerTool.bind(server) as (...args: any[]) => unknown;
    (server as any).registerTool = (name: string, config: any, cb: any) =>
      registerGated(name, config, !GATED.has(name)
        ? cb
        : async (args: any, extra: any) => {
            try {
              const w = await ws();
              const t = typeof args?.task === "string" ? await getTaskByRef(env, w.id, args.task).catch(() => null) : null;
              await assertPoliciesRead(env, w, actor, t ?? (typeof args?.project === "string" ? { project_id: args.project } : null));
            } catch (err) {
              return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
            }
            return cb(args, extra);
          });
  }

  const memberNames = async () => {
    const rows = await env.DB.prepare("SELECT id, name, handle, kind FROM members WHERE workspace_id = ?")
      .bind(props.workspaceId)
      .all<{ id: string; name: string; handle: string; kind: string }>();
    return new Map(rows.results.map((m) => [m.id, m]));
  };

  const compactEntry = (e: EntryRow & { data: any; reactions?: { emoji: string; by: string[] }[] }, names: Map<string, { name: string; handle: string; kind: string }>) => {
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
    if (e.reactions?.length) {
      base.reactions = e.reactions.map((r) => `${r.emoji} ${r.by.map((id) => names.get(id)?.name ?? "someone").join(", ")}`);
      const ack = e.reactions.find((r) => r.emoji === "👍");
      if (ack) base.acknowledged_by = ack.by.map((id) => names.get(id)?.name ?? "someone");
    }
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
      inputSchema: {
        status: z.array(z.string()).optional().describe("Filter by status keys. A built-in status also matches the custom statuses that behave like it."),
      },
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
        const entries = detail.entries as unknown as (EntryRow & { data: any; reactions: { emoji: string; by: string[] }[] })[];
        const unread = entries.filter((e) => e.author_id !== me.id && (!cursor || e.created_at > cursor.last_read_at));
        const recent = entries.slice(-50);
        await markRead(env, me.id, t.id);
        if (me.kind === "agent") await touchRun(env, t.id, me.id);
        return {
          task: detail.task,
          dependencies: detail.dependencies.blocked_by.length || detail.dependencies.blocking.length
            ? {
                ...detail.dependencies,
                note: detail.dependencies.open_blockers
                  ? `Blocked: ${detail.dependencies.open_blockers} task(s) in blocked_by aren't done yet. Don't start work that needs their result.`
                  : undefined,
              }
            : undefined,
          open_questions: entries
            .filter((e) => e.type === "question" && e.data?.state === "open")
            .map((e) => compactEntry(e, names)),
          notes: detail.notes,
          checklists: detail.checklists,
          attachments: detail.attachments,
          policies: me.kind === "agent" ? await policiesFor(env, w.id, me, t) : undefined,
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
        status: z.array(z.string()).optional().describe("Status keys. A built-in status also matches the custom statuses that behave like it."),
        labels: z.array(z.string()).optional().describe("Label names or ids; matches tasks with any of them"),
        assignee: z.string().optional().describe("Member handle, id, or 'none'"),
        project: z.string().optional().describe("Project id or 'none'"),
        include_archived: z.boolean().optional().describe("Also return tasks archived with their project (left out by default)"),
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
          labels: a.labels,
          assigneeId,
          projectId: a.project,
          limit: a.limit ?? 25,
          includeArchived: a.include_archived,
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
        status: STATUS.optional(),
        labels: LABELS.optional(),
        blocked_by: z.array(z.string()).optional().describe("Task keys this task depends on (it can't start until they're done)"),
      },
    },
    (a) =>
      guard(async () => {
        const w = await ws();
        const assigneeId = a.assignee ? (await findMemberByRef(env, w.id, a.assignee)).id : null;
        const t = await createTask(env, w, actor, {
          blockedBy: a.blocked_by,
          title: a.title,
          description: a.description,
          projectId: a.project ?? null,
          assigneeId,
          priority: a.priority,
          status: a.status,
          labels: a.labels,
          createMissingLabels: true,
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
        status: STATUS.optional(),
        labels: LABELS.optional().describe("Replaces the task's labels. Label names (or ids); unknown names create new labels."),
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
          labels: a.labels,
          createMissingLabels: true,
        });
        return (await serializeTasks(env, w, [next]))[0];
      }),
  );

  server.registerTool(
    "set_dependency",
    {
      description:
        "Mark that a task is blocked by another (it can't start until the other is done), or remove that link. " +
        "When the last blocker is done, the blocked task's agent is woken.",
      inputSchema: {
        task: z.string().describe("The task that waits"),
        blocked_by: z.string().describe("The task it waits for"),
        remove: z.boolean().optional().describe("true to remove the link"),
      },
    },
    (a) =>
      guard(async () => {
        const w = await ws();
        const t = await getTaskByRef(env, w.id, a.task);
        const b = await getTaskByRef(env, w.id, a.blocked_by);
        if (a.remove) await removeDependency(env, w, actor, t, b);
        else await addDependency(env, w, actor, t, b);
        return await dependenciesOf(env, w, t.id);
      }),
  );

  server.registerTool(
    "react",
    {
      description:
        "React to a message in a task thread. 👍 means acknowledged: use it to confirm you've seen feedback or a reply without posting a comment.",
      inputSchema: {
        entry_id: z.string().describe("Thread message id (from get_task)"),
        emoji: z.enum(["👍", "🎉", "👀", "❤️"]).optional().describe("Defaults to 👍"),
        remove: z.boolean().optional(),
      },
    },
    (a) =>
      guard(async () => {
        const w = await ws();
        return await reactToEntry(env, w, actor, a.entry_id, a.emoji ?? "👍", !a.remove);
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
    "log_idea",
    {
      description:
        "Add a product idea (a feature, concept or strategy worth considering later) to the workspace Ideas board. " +
        "Write a clear, short title and 2–5 sentences: the problem, the idea, and why it matters. " +
        "Labels and a suggested owner are added automatically if you leave them out.",
      inputSchema: {
        title: z.string().min(1).max(200),
        body: z.string().max(10000).optional(),
        labels: z.array(z.enum(IDEA_LABELS)).max(3).optional(),
        owner: z.string().optional().describe("Suggested owner's handle"),
        source_url: z.string().optional().describe("Where the idea came from, e.g. a GitHub issue"),
      },
    },
    (input) =>
      guard(async () => {
        const w = await ws();
        const idea = await createIdea(env, w, actor, { title: input.title, body: input.body, labels: input.labels, ownerRef: input.owner, sourceUrl: input.source_url });
        return { id: idea.id, title: idea.title, labels: idea.labels, status: idea.status };
      }),
  );

  server.registerTool(
    "log_feature_request",
    {
      description:
        "Record that a customer asked for a feature. Links the customer to an existing idea (idea_id from list_ideas) or creates a new idea from title/body. " +
        "Creates the customer if they're new. Asking again for the same feature updates the note instead of double-counting. " +
        "Check list_ideas first so requests for the same feature land on one idea.",
      inputSchema: {
        customer: z.string().min(1).max(120).describe("Customer name, e.g. the brand or store"),
        customer_domain: z.string().optional().describe("Store or company domain, used only when creating a new customer"),
        idea_id: z.string().optional().describe("Existing idea this request belongs to"),
        title: z.string().max(200).optional().describe("New feature in one line (when there's no matching idea)"),
        body: z.string().max(10000).optional(),
        note: z.string().max(2000).optional().describe("What the customer said, ideally in their words"),
        requested_at: z.string().optional().describe("YYYY-MM-DD; defaults to today"),
      },
    },
    (input) =>
      guard(async () => {
        const w = await ws();
        const r = await logFeatureRequest(env, w, actor, {
          customer: { name: input.customer, domain: input.customer_domain },
          ideaId: input.idea_id,
          title: input.title,
          body: input.body,
          note: input.note,
          requestedAt: input.requested_at,
        });
        return {
          idea: { id: r.idea.id, title: r.idea.title, customers_requesting: r.idea.request_count },
          customer: r.customer.name,
          customer_created: r.customer_created,
          idea_created: r.idea_created,
          already_requested: r.already_requested,
        };
      }),
  );

  server.registerTool(
    "list_ideas",
    {
      description: "List product ideas, optionally filtered by label, status or stage (backlog = not shipped yet, live = shipped, archived). Defaults to the backlog; pinned ideas come first.",
      inputSchema: {
        label: z.enum(IDEA_LABELS).optional(),
        status: z.enum(IDEA_STATUSES).optional(),
        stage: z.enum(IDEA_STAGES).optional().describe("Default backlog"),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    (input) =>
      guard(async () => {
        const w = await ws();
        const names = await memberNames();
        return (await listIdeas(env, w))
          .filter((i) => i.stage === (input.stage ?? "backlog"))
          .filter((i) => (!input.label || i.labels.includes(input.label)) && (!input.status || i.status === input.status))
          .sort((a, b) => Number(!!b.pinned_at) - Number(!!a.pinned_at))
          .slice(0, input.limit ?? 30)
          .map((i) => ({
            id: i.id,
            title: i.title,
            summary: i.body.slice(0, 300),
            labels: i.labels,
            status: i.status,
            stage: i.stage,
            ...(i.pinned_at ? { pinned: true } : {}),
            suggested_owner: i.suggested_owner_id ? `@${names.get(i.suggested_owner_id)?.handle}` : null,
            ...(i.request_count ? { customers_requesting: i.request_count, times_requested: i.request_times, requested_by: i.requested_by.map((c) => c.name) } : {}),
            ...(i.task ? { task: i.task.key } : {}),
          }));
      }),
  );

  server.registerTool(
    "list_projects",
    { description: "List projects (active and archived), with task counts.", annotations: { readOnlyHint: true } },
    () => guard(async () => listProjects(env, props.workspaceId)),
  );

  server.registerTool(
    "list_statuses",
    {
      description:
        "The workspace's task statuses in board order. Custom statuses each have a category: the built-in status they behave like " +
        "(e.g. a custom 'In review' with category in_progress). Use the key when setting a task's status.",
      annotations: { readOnlyHint: true },
    },
    () => guard(async () => (await listStatuses(env, props.workspaceId)).map(({ position, ...s }) => s)),
  );

  server.registerTool(
    "list_labels",
    { description: "The workspace's task labels, with how many tasks use each.", annotations: { readOnlyHint: true } },
    () => guard(async () => (await listLabels(env, props.workspaceId)).map(({ id, name, color, task_count }) => ({ id, name, color, task_count }))),
  );

  server.registerTool(
    "archive_project",
    {
      description:
        "Archive a project, or restore it with archived: false. Archiving also archives all of its tasks: they drop out of task " +
        "lists and search, and agents aren't woken on them. Restoring brings the tasks back unchanged. Task statuses are not touched.",
      inputSchema: {
        project: z.string().describe("Project id or exact name"),
        archived: z.boolean().optional().describe("true (default) to archive, false to restore"),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    (a) =>
      guard(async () => {
        const w = await ws();
        const all = (await listProjects(env, w.id)) as { id: string; name: string }[];
        const p =
          all.find((x) => x.id === a.project) ?? all.filter((x) => x.name.toLowerCase() === a.project.trim().toLowerCase())[0];
        if (!p) throw new Error(`No project "${a.project}". Use list_projects to see them.`);
        const r = await updateProject(env, w, actor, p.id, { status: a.archived === false ? "active" : "archived" });
        return {
          project: { id: r.id, name: r.name, status: r.status },
          tasks_changed: r.tasks_changed,
          note: r.status === "archived" ? `${r.tasks_changed} task(s) archived with it.` : `${r.tasks_changed} task(s) restored.`,
        };
      }),
  );


  // ---------- Wider coverage: these call the same /api handlers the app uses, as this agent ----------
  const callAs = <T = any>(method: string, path: string, body?: unknown) => callApi<T>(env, actor, method, path, body);
  const projectId = async (ref: string) => {
    const all = (await listProjects(env, props.workspaceId)) as { id: string; name: string }[];
    const p = all.find((x) => x.id === ref) ?? all.find((x) => x.name.toLowerCase() === ref.trim().toLowerCase());
    if (!p) throw new Error(`No project "${ref}". Use list_projects to see them.`);
    return p.id;
  };
  const memberId = async (ref: string | null | undefined) =>
    ref === undefined ? undefined : ref === null || ref === "none" ? null : (await findMemberByRef(env, props.workspaceId, ref)).id;
  const customerId = async (ref: string) => {
    const all = await callAs<{ id: string; name: string }[]>("GET", "/api/customers");
    const c = all.find((x) => x.id === ref) ?? all.find((x) => x.name.toLowerCase() === ref.trim().toLowerCase());
    if (!c) throw new Error(`No customer "${ref}". Use list_customers to see them.`);
    return c.id;
  };

  server.registerTool(
    "create_project",
    {
      description: "Create a project to group related tasks (a campaign, a launch).",
      inputSchema: {
        name: z.string().min(1).max(120),
        description: z.string().max(2000).optional(),
        lead: z.string().optional().describe("Lead's handle or member id"),
      },
    },
    (a) =>
      guard(async () =>
        callAs("POST", "/api/projects", { name: a.name, description: a.description, lead_member_id: (await memberId(a.lead)) ?? null }),
      ),
  );

  server.registerTool(
    "update_project",
    {
      description: "Rename a project, change its description or lead. To archive or restore it, use archive_project.",
      inputSchema: {
        project: z.string().describe("Project id or exact name"),
        name: z.string().min(1).max(120).optional(),
        description: z.string().max(2000).optional(),
        lead: z.string().nullable().optional().describe("Lead's handle or member id; null to clear"),
      },
    },
    (a) =>
      guard(async () =>
        callAs("PATCH", `/api/projects/${await projectId(a.project)}`, {
          name: a.name,
          description: a.description,
          lead_member_id: await memberId(a.lead),
        }),
      ),
  );

  server.registerTool(
    "get_idea",
    {
      description: "Get one product idea with its customer requests.",
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true },
    },
    (a) => guard(async () => callAs("GET", `/api/ideas/${encodeURIComponent(a.id)}`)),
  );

  server.registerTool(
    "update_idea",
    {
      description:
        "Edit an idea: title, body, labels, suggested owner, stage (backlog = considering or building, live = shipped, archived = not pursuing; " +
        "its customer requests follow the stage), or pin it to the top.",
      inputSchema: {
        id: z.string(),
        title: z.string().min(1).max(200).optional(),
        body: z.string().max(10000).optional(),
        labels: z.array(z.enum(IDEA_LABELS)).optional(),
        owner: z.string().nullable().optional().describe("Suggested owner's handle or member id; null to clear"),
        stage: z.enum(IDEA_STAGES).optional(),
        pinned: z.boolean().optional(),
      },
    },
    (a) =>
      guard(async () =>
        callAs("PATCH", `/api/ideas/${encodeURIComponent(a.id)}`, {
          title: a.title,
          body: a.body,
          labels: a.labels,
          suggested_owner_id: await memberId(a.owner),
          stage: a.stage,
          pinned: a.pinned,
        }),
      ),
  );

  server.registerTool(
    "convert_idea",
    {
      description: "Turn an idea into a task. With assign: true the idea's suggested owner gets the task (and is woken if it's an agent).",
      inputSchema: {
        id: z.string(),
        assign: z.boolean().optional(),
        project: z.string().optional().describe("Project id or exact name for the new task"),
      },
    },
    (a) =>
      guard(async () =>
        callAs("POST", `/api/ideas/${encodeURIComponent(a.id)}/convert`, {
          assign: !!a.assign,
          project_id: a.project ? await projectId(a.project) : null,
        }),
      ),
  );

  server.registerTool(
    "list_customers",
    { description: "List customers with how many open feature requests each has.", annotations: { readOnlyHint: true } },
    () => guard(async () => callAs("GET", "/api/customers")),
  );

  server.registerTool(
    "get_customer",
    {
      description: "Get one customer and everything they've asked for.",
      inputSchema: { customer: z.string().describe("Customer id or exact name") },
      annotations: { readOnlyHint: true },
    },
    (a) => guard(async () => callAs("GET", `/api/customers/${await customerId(a.customer)}`)),
  );

  const customerFields = {
    domain: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    plan: z.string().nullable().optional(),
    mrr: z.number().nullable().optional().describe("Monthly revenue"),
    notes: z.string().max(10000).optional(),
  };

  server.registerTool(
    "create_customer",
    { description: "Add a customer.", inputSchema: { name: z.string().min(1).max(120), ...customerFields } },
    (a) => guard(async () => callAs("POST", "/api/customers", a)),
  );

  server.registerTool(
    "update_customer",
    {
      description: "Edit a customer's name, domain, email, plan, monthly revenue or notes.",
      inputSchema: { customer: z.string().describe("Customer id or exact name"), name: z.string().min(1).max(120).optional(), ...customerFields },
    },
    (a) =>
      guard(async () => {
        const { customer, ...fields } = a;
        return callAs("PATCH", `/api/customers/${await customerId(customer)}`, fields);
      }),
  );

  server.registerTool(
    "list_feature_requests",
    {
      description: "List customer feature requests (who asked for which idea, how often, and whether it's open, live or archived).",
      inputSchema: {
        customer: z.string().optional().describe("Customer id or exact name"),
        idea_id: z.string().optional(),
        status: z.enum(["open", "live", "archived"]).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    (a) =>
      guard(async () => {
        const cid = a.customer ? await customerId(a.customer) : undefined;
        const rows = await callAs<{ customer_id: string; idea_id: string; status: string }[]>("GET", "/api/idea-requests");
        return rows.filter((r) => (!cid || r.customer_id === cid) && (!a.idea_id || r.idea_id === a.idea_id) && (!a.status || r.status === a.status));
      }),
  );

  server.registerTool(
    "list_views",
    { description: "List the workspace's saved task views (shared filters like 'Needs attention').", annotations: { readOnlyHint: true } },
    () => guard(async () => callAs("GET", "/api/views")),
  );

  server.registerTool(
    "get_inbox",
    {
      description: "Your 'Needs you' inbox: open questions, failed or stuck runs, and mentions waiting on you.",
      annotations: { readOnlyHint: true },
    },
    () => guard(async () => callAs("GET", "/api/inbox")),
  );

  server.registerTool(
    "create_share_link",
    {
      description:
        "Create a link that lets someone outside the workspace read a task (mode read) or also reply to it (mode reply), with no sign-in. " +
        "Anyone with the link can use it, so only share it with the intended person.",
      inputSchema: {
        task: z.string().describe("Task key like IMP-12"),
        mode: z.enum(["read", "reply"]).optional(),
        label: z.string().max(60).optional().describe("Who it's for, e.g. 'Acme design team'"),
        expires_in_days: z.number().int().min(0).max(365).optional().describe("Default 7; 0 = never expires"),
      },
    },
    (a) =>
      guard(async () =>
        callAs("POST", `/api/tasks/${encodeURIComponent(a.task)}/shares`, { mode: a.mode, label: a.label, expires_in_days: a.expires_in_days }),
      ),
  );

  server.registerTool(
    "update_note",
    {
      description: "Edit a note on a task (its id is in get_task's notes).",
      inputSchema: { note_id: z.string(), title: z.string().max(200).optional(), content: z.string().optional() },
    },
    (a) => guard(async () => callAs("PATCH", `/api/notes/${encodeURIComponent(a.note_id)}`, { title: a.title, content: a.content })),
  );

  if (orchestrate || isPm) {
    server.registerTool(
      "retry_run",
      {
        description: "Retry a failed or stuck agent run (run ids are in get_task's runs and get_inbox).",
        inputSchema: { run_id: z.string() },
      },
      (a) => guard(async () => callAs("POST", `/api/runs/${encodeURIComponent(a.run_id)}/retry`, {})),
    );
    server.registerTool(
      "dismiss_run",
      {
        description: "Dismiss a failed or stuck run so it leaves the 'Needs you' inbox, without retrying it.",
        inputSchema: { run_id: z.string() },
      },
      (a) => guard(async () => callAs("POST", `/api/runs/${encodeURIComponent(a.run_id)}/dismiss`, {})),
    );
  }

  server.registerTool(
    "duplicate_task",
    {
      description:
        "Create a copy of a task: same description, priority, project, assignee and due date unless you override them, plus its " +
        "checklists (unchecked), notes and blockers. A done/canceled original starts the copy at todo. The thread isn't copied. " +
        "Assigning follows the same wake rules as create_task.",
      inputSchema: {
        task: z.string().describe("Task key like IMP-12"),
        title: z.string().max(300).optional().describe("Defaults to '<title> (copy)'"),
        status: STATUS.optional(),
        priority: z.enum(PRIORITIES).optional(),
        assignee: z.string().nullable().optional().describe("Handle or member id; null for unassigned. Defaults to the original's"),
        project: z.string().nullable().optional().describe("Project id or exact name; null for none"),
        copy_details: z.boolean().optional().describe("false to skip checklists, notes and blockers"),
      },
    },
    (a) =>
      guard(async () =>
        callAs("POST", `/api/tasks/${encodeURIComponent(a.task)}/duplicate`, {
          title: a.title,
          status: a.status,
          priority: a.priority,
          assignee_id: await memberId(a.assignee),
          project_id: a.project === undefined ? undefined : a.project === null ? null : await projectId(a.project),
          copy_details: a.copy_details,
        }),
      ),
  );

  server.registerTool(
    "get_overview",
    {
      description: "Workspace overview: task counts by status and by member, recent activity, runs and open questions.",
      annotations: { readOnlyHint: true },
    },
    () => guard(async () => callAs("GET", "/api/overview")),
  );

  server.registerTool(
    "get_reports",
    {
      description: "Reports for the last 7, 30 or 90 days: throughput, agent run success, acknowledgements and routine gaps.",
      inputSchema: { days: z.union([z.literal(7), z.literal(30), z.literal(90)]).optional() },
      annotations: { readOnlyHint: true },
    },
    (a) => guard(async () => callAs("GET", `/api/reports?days=${a.days ?? 30}`)),
  );

  server.registerTool(
    "list_policies",
    {
      description:
        "List or search the workspace's policies (SOPs, guidelines, strategies, structure). Ones that apply to you come first, " +
        "marked required/read_latest. Read one with get_policy.",
      inputSchema: { query: z.string().optional().describe("Words to search titles, summaries and content") },
      annotations: { readOnlyHint: true },
    },
    ({ query }) => guard(async () => listPoliciesForAgent(env, props.workspaceId, me, query)),
  );

  server.registerTool(
    "get_policy",
    {
      description: "Read a policy in full (by id, or by its path/title). Reading it records that you have the latest version.",
      inputSchema: { policy: z.string().describe("Policy id, path (e.g. 'Marketing / Blog SOP') or title") },
      annotations: { readOnlyHint: true },
    },
    ({ policy }) =>
      guard(async () => {
        const p = await findPolicy(env, props.workspaceId, policy);
        const all = await env.DB.prepare("SELECT * FROM policies WHERE workspace_id = ?").bind(props.workspaceId).all<any>();
        if (p.kind === "folder") {
          const prefix = `${policyForAgent(env, p, all.results).path} / `;
          return { folder: prefix.slice(0, -3), docs: (await listPoliciesForAgent(env, props.workspaceId, me)).filter((d) => d.path.startsWith(prefix)) };
        }
        await markPolicyRead(env, me, p);
        return policyForAgent(env, p, all.results);
      }),
  );

  server.registerTool(
    "create_policy",
    {
      description:
        "Write a new policy (SOP, guideline, strategy, structure) for the workspace. Put it in a folder by path, e.g. 'Product / Roadmap'; " +
        "missing folders are created. People decide who follows it and whether it's required; it starts as a policy for every agent.",
      inputSchema: {
        title: z.string().describe("Policy title"),
        content: z.string().describe("The policy in Markdown: steps, rules, examples"),
        folder: z.string().optional().describe("Folder path, e.g. 'Product' or 'Engineering / Releases'. Omit for top level."),
        summary: z.string().optional().describe("One line on when to use it, e.g. 'Before publishing any blog post'"),
      },
    },
    (a) =>
      guard(async () => {
        const w = await ws();
        const parent = a.folder?.trim() ? await ensureFolderPath(env, w, actor, a.folder) : null;
        const same = await env.DB.prepare(
          `SELECT id FROM policies WHERE workspace_id = ? AND kind = 'doc' AND ${parent ? "parent_id = ?" : "parent_id IS NULL"} AND title = ? COLLATE NOCASE`,
        )
          .bind(...(parent ? [w.id, parent, a.title.trim()] : [w.id, a.title.trim()]))
          .first<{ id: string }>();
        if (same) throw new HttpError(409, `A policy with that title already exists there (id ${same.id}); use update_policy to change it`);
        const p = await createPolicy(env, w, actor, { kind: "doc", title: a.title, content: a.content, summary: a.summary, parent_id: parent });
        const all = await env.DB.prepare("SELECT * FROM policies WHERE workspace_id = ?").bind(w.id).all<any>();
        const { content, ...rest } = policyForAgent(env, p, all.results);
        return { ...rest, created: true };
      }),
  );

  server.registerTool(
    "update_policy",
    {
      description:
        "Change a policy's title, content or summary, or move it to another folder. Every edit is kept as a version; if the policy is required, " +
        "agents must read the new version before working.",
      inputSchema: {
        policy: z.string().describe("Policy id, path or title"),
        title: z.string().optional(),
        content: z.string().optional().describe("Full new Markdown (replaces the old text)"),
        summary: z.string().optional(),
        folder: z.string().optional().describe("Move to this folder path ('' for top level)"),
      },
    },
    (a) =>
      guard(async () => {
        const w = await ws();
        const p = await findPolicy(env, w.id, a.policy);
        const parent_id = a.folder === undefined ? undefined : a.folder.trim() ? await ensureFolderPath(env, w, actor, a.folder) : null;
        const saved = await updatePolicy(env, w, actor, p, { title: a.title, content: a.content, summary: a.summary, parent_id }, false);
        const all = await env.DB.prepare("SELECT * FROM policies WHERE workspace_id = ?").bind(w.id).all<any>();
        const { content, ...rest } = policyForAgent(env, saved, all.results);
        return { ...rest, updated: true };
      }),
  );

  server.registerTool(
    "list_tools",
    {
      description: "Search the team's Tools directory (useful tools found online): name, summary, tags, category, pricing.",
      inputSchema: {
        query: z.string().optional(),
        tag: z.string().optional(),
        needs_research: z.boolean().optional().describe("Only tools not yet researched by an agent or person"),
      },
      annotations: { readOnlyHint: true },
    },
    (a) =>
      guard(async () => {
        const w = await ws();
        const q = a.query?.toLowerCase().trim();
        return (await listTools(env, w))
          .filter((t) => !a.tag || t.tags.includes(a.tag.toLowerCase()))
          .filter((t) => !a.needs_research || !["agent", "human"].includes(t.enriched_by))
          .filter((t) => !q || `${t.name} ${t.domain} ${t.summary} ${t.tags.join(" ")} ${t.category ?? ""}`.toLowerCase().includes(q))
          .slice(0, 100)
          .map(({ notes, created_by, ...t }) => t);
      }),
  );

  server.registerTool(
    "get_tool",
    {
      description: "Read one tool from the Tools directory, by id or URL.",
      inputSchema: { tool: z.string().describe("Tool id or its URL") },
      annotations: { readOnlyHint: true },
    },
    ({ tool }) => guard(async () => toolOut(await ws(), await getTool(env, await ws(), tool))),
  );

  server.registerTool(
    "add_tool",
    {
      description: "Add a tool to the Tools directory by its website. A first summary and tags are filled in automatically; refine them with update_tool.",
      inputSchema: { url: z.string(), notes: z.string().optional() },
    },
    (a) =>
      guard(async () => {
        const w = await ws();
        let first: Promise<unknown> = Promise.resolve();
        const t = await addTool(env, w, actor, { url: a.url, notes: a.notes, research: false }, (p) => void (first = p));
        await first.catch(() => {}); // wait for the first pass so the agent sees the summary and tags
        return toolOut(w, await getTool(env, w, t.id));
      }),
  );

  server.registerTool(
    "update_tool",
    {
      description:
        "Write your research into the Tools directory: a plain 1–2 sentence summary (what it does, who it's for), 3–6 lowercase tags, " +
        "a category, pricing (e.g. Free, Freemium, From $20/mo, Open source) and notes (standout features, alternatives, how we'd use it).",
      inputSchema: {
        tool: z.string().describe("Tool id or URL"),
        name: z.string().optional(),
        summary: z.string().optional(),
        tags: z.array(z.string()).optional(),
        category: z.string().optional(),
        pricing: z.string().optional(),
        notes: z.string().optional().describe("Markdown"),
      },
    },
    ({ tool, ...rest }) =>
      guard(async () => {
        const w = await ws();
        const t = await getTool(env, w, tool);
        return updateTool(env, w, actor, t.id, rest);
      }),
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
