# Agentic PM — Design

Date: 2026-11-15
Status: Draft for review

## 1. Intent

Impulze's work is done by a mix of people and AI agents (starting with xAI's Grok Bot). Today there is no single place that records what work exists, who (or what) is doing it, what was decided along the way, and what got done.

Agentic PM is a lightweight, Linear/Trello-style task tracker where **people and agents are equal members**. It is the **system of record** for jobs to be done and done by the team, and the **orchestrator** that hands work to agents and wakes them when a human responds.

The core idea: **every task is a conversation**. A task's thread holds updates, notes, attachments, checklists, and questions from agents with answers from humans. An agent working a task can ask a question, park, and be woken when someone answers.

## 2. Goals

1. Members are humans or agents, in one list. Anything taking an assignee or author accepts either.
2. Tasks with title, description, status, priority, assignee, optional project.
3. A task thread supporting: comments, progress updates, rich (Notion-like) notes, attachments, checklists, agent questions and human answers, plus system events (status/assignee changes).
4. Board (Kanban by status) and list views, filterable by assignee, project, member kind (human/agent).
5. An **orchestrator** that wakes agents via webhook when (a) a task is assigned to them, (b) a human answers their question, (c) a human @mentions them on a task.
6. A public **MCP server** (OAuth-protected) through which agents read and act on tasks.
7. Live updates: people watching a task see agent posts appear without refreshing.
8. A complete, attributable history: every change records which member (human or agent) made it.

## 3. Non-goals (v1)

- Multiple workspaces in the UI (data model is workspace-scoped so it can come later).
- Running agent models inside the platform (no built-in LLM loop). Agents live elsewhere and are reached by webhook.
- Email/Slack notifications (in-app "Needs you" inbox only).
- Sprints/cycles, estimates, time tracking, labels, subtasks, custom fields, roadmaps.
- Fine-grained permissions. v1 has two roles: admin and member.
- Mobile apps (responsive web is enough).

## 4. Anti-goals (failure even if it "works")

- **Agent work that leaves no trace.** If an agent did something, the thread must show it.
- **Silently stuck agents.** A dispatched run with no activity must become visible to humans.
- **Runaway loops.** Agents must not be able to wake themselves or each other into endless runs.
- **Jira creep.** If creating and working a task takes more than a few clicks, it has failed.

## 5. Constraints

- **Grok Bot integration (verified against xAI docs, 2026-11-15):**
  - Inbound: a Grok Bot *routine* can have a **webhook trigger**: `POST <url>` with `Authorization: Bearer <key>` and an optional JSON body, which the bot receives together with the routine's instruction. `200` means a run started, not finished; any other status means no run started.
  - Outbound: Grok Bot can add a **custom MCP server** by public HTTPS URL plus sign-in (OAuth).
  - Therefore: our MCP server must be publicly reachable and implement OAuth 2.1 as MCP clients expect (dynamic client registration, PKCE).
- One Grok Bot = one agent member. Each agent member has its own webhook URL + key.
- Hosting on Cloudflare (Impulze has an account).
- Single workspace for Impulze; humans sign in with Google (restricted to allowed domains, e.g. `impulze.ai`).

## 6. Approaches considered

| | Approach | Trade-off |
|---|---|---|
| **A (chosen)** | All on Cloudflare: Workers (web app, API, MCP), D1, R2, Durable Objects, Queues | Ready-made remote-MCP + OAuth support; live updates built in; one deploy; low cost. D1 is SQLite (fine at team scale, weaker for heavy analytics). |
| B | Next.js on Vercel + PlanetScale Postgres + Vercel Blob | Familiar, Postgres. Needs a third-party realtime service and hand-built MCP OAuth. More moving parts. |
| C | Supabase + Next.js | Fast data/auth/realtime, but MCP server and webhook dispatch still need another host: two platforms. |

Rejected: layering on Linear/Trello. The platform must own the data model to be the system of record and orchestrator.

The user chose **A**.

## 7. Concepts and data model

All records carry `workspace_id`. IDs are ULIDs. Timestamps are UTC.

**Workspace** — `id, name, key_prefix` (e.g. `IMP`, used in task keys like `IMP-42`), `allowed_email_domains`.

**Member** — `id, workspace_id, kind (human|agent), name, handle (unique, for @mentions), avatar_url, role (admin|member), active, created_at`.
- Human extra: `email, google_sub`.
- Agent extra: `description` (what this agent is good at), `webhook_url`, `webhook_key_encrypted`, `wake_on_mention (bool, default true)`, `max_runs_per_hour (default 10)`.

**Project** — `id, name, description (markdown), lead_member_id?, status (active|archived), created_by`.

**Task** — `id, number` (per-workspace sequence → key `IMP-<number>`), `title, description (markdown), status, priority (none|low|medium|high|urgent), assignee_id?, project_id?, due_date?, created_by, created_at, updated_at, completed_at?`.

Statuses (fixed in v1): `backlog, todo, in_progress, waiting_on_human, done, canceled`.

**Thread entry** (append-only timeline per task) — `id, task_id, author_id, type, body (markdown), data (JSON), reply_to_id?, created_at, edited_at?`. Types:
- `comment` — normal message.
- `update` — progress update (visually distinct; agents use it for "here's what I did").
- `question` — agent asks something. `data: { addressed_to_member_id?, state: open|answered }`. Posting a question sets task status to `waiting_on_human`.
- `answer` — reply to a question (`reply_to_id` = question). Marks the question `answered`; if no other open questions remain, task returns to `in_progress`.
- `note_created`, `checklist_created`, `attachment_added` — timeline markers pointing to the living objects below.
- `system` — status change, assignee change, project change, run failure, etc. `data` holds before/after.

Thread entries are immutable except `body` edits by their author; edits are kept in `thread_entry_revisions`.

**Note** — a living rich document attached to a task: `id, task_id, title, content (markdown), created_by, updated_by, updated_at`. Revisions stored in `note_revisions`. A task can have several notes.

**Checklist** — `id, task_id, title, created_by`; **ChecklistItem** — `id, checklist_id, text, done, done_by?, done_at?, position`.

**Attachment** — `id, task_id, thread_entry_id?, filename, content_type, size, r2_key, uploaded_by`. Max 25 MB per file in v1.

**Agent run** — `id, task_id, agent_id, trigger (assigned|answered|mentioned|manual), trigger_entry_id?, status (queued|dispatched|failed|active|ended|stale), attempts, last_error?, dispatched_at, last_activity_at, ended_at`.

**Activity log** — every mutation (from UI, API, or MCP) writes `activity(id, actor_id, via (web|mcp|system), entity_type, entity_id, action, before, after, created_at)`. This is the audit trail; thread `system` entries are the human-readable subset.

### Content format

Canonical format for task descriptions, notes, and entry bodies is **Markdown** (GFM). Agents read and write Markdown naturally; the web editor gives a Notion-like block editing experience that round-trips Markdown (headings, lists, to-dos, code, tables, links, images). Mentions are encoded as `@handle`.

## 8. Orchestration (waking agents)

### When the platform wakes an agent

1. **Assigned** — task assignee changes to an agent.
2. **Answered** — a human posts an `answer` to that agent's `question` on a task it is assigned to.
3. **Mentioned** — a human posts an entry containing `@agent-handle` (if `wake_on_mention`). The task need not be assigned to the agent.
4. **Manual** — a human clicks "Wake agent" on a task.

Agents never trigger wakes (an agent's posts, mentions or assignments never dispatch a run). This prevents loops. Agent-to-agent handoff is out of scope for v1.

### Dispatch

- The trigger creates an `agent_run (queued)` and enqueues a message on a Cloudflare Queue.
- The consumer POSTs to the agent's webhook:

```json
{
  "event": "assigned | answered | mentioned | manual",
  "run_id": "01J...",
  "task": { "id": "01J...", "key": "IMP-42", "title": "...", "url": "https://.../t/IMP-42" },
  "trigger_entry_id": "01J...",
  "instruction": "You are working task IMP-42 in Agentic PM. Use the Agentic PM MCP tools: call get_task('IMP-42') first, post updates as you work, use ask_question if you need a human, and complete_task when done."
}
```

- `200` → run `dispatched`. Non-200/timeout → retry with backoff (3 attempts over ~5 min), then `failed` and a `system` entry on the task ("Couldn't reach Grok Bot: <reason>") visible to humans with a "Retry" button.
- **Coalescing:** if a run for the same (task, agent) is `dispatched` or `active`, new triggers do not dispatch again. They are recorded and the agent sees them via `get_task` (which returns unread events since its last call). If the run ends and unread triggers remain, a new run is dispatched.
- **Rate limit:** at most `max_runs_per_hour` dispatches per agent; excess queue up.

### Run lifecycle

- First MCP call by that agent touching that task → `active`, `last_activity_at` updated on every call.
- Ends when the agent calls `ask_question` or `complete_task`, or calls `end_run` explicitly.
- **Stale detection:** a scheduled job (Cron Trigger, every 5 min) marks runs `stale` if dispatched with no MCP activity for 15 min, or active with no activity for 60 min. Stale runs post a `system` entry and appear in the "Needs you" inbox.

## 9. MCP server

Public HTTPS endpoint (Streamable HTTP transport) at `/mcp`.

### Auth

OAuth 2.1 with dynamic client registration and PKCE (Cloudflare's `workers-oauth-provider`). When an MCP client (e.g. Grok Bot) starts sign-in, the consent page:
1. Requires the person connecting to sign in with Google (must be a workspace admin to connect an agent).
2. Asks **who this connection acts as**: "Myself" or one of the agent members.
3. Issues a token bound to `(workspace_id, member_id)`.

So an admin connects Grok Bot once and picks "Act as: Grok Bot – Research". Humans can also connect their own assistants (e.g. Claude) acting as themselves. Tokens can be revoked from the member's settings page.

### Tools (v1)

| Tool | Purpose |
|---|---|
| `list_my_tasks(status?)` | Tasks assigned to the calling member. |
| `get_task(key_or_id)` | Task fields, project, description, open questions, notes (titles + content), checklists, attachments list, and thread entries (latest 50 + all unread since this member's last read). Marks events read. |
| `search_tasks(query?, status?, assignee?, project?)` | Find tasks. |
| `create_task(title, description?, project?, assignee?, priority?)` | Create a task. |
| `update_task(key, fields)` | Title, description, status, priority, assignee, project, due date. |
| `post_update(key, body)` | Progress update. |
| `add_comment(key, body, reply_to?)` | Comment. |
| `ask_question(key, body, addressed_to?)` | Ask a human; sets `waiting_on_human`; ends the run. |
| `write_note(key, title, content, note_id?)` | Create or replace a note. |
| `create_checklist(key, title, items[])` / `set_checklist_item(item_id, done)` / `add_checklist_item(checklist_id, text)` | Checklists. |
| `attach_file(key, filename, content_type, content_base64 \| source_url)` | Upload an attachment (≤25 MB). |
| `get_attachment(attachment_id)` | Short-lived download URL. |
| `complete_task(key, summary)` | Posts `summary` as an update, sets `done`, ends the run. |
| `end_run(key, reason?)` | End the run without completing (e.g. handed back). |
| `list_projects()`, `list_members()` | Lookups (members include kind and agent descriptions). |

All tool calls are attributed to the token's member and written to the activity log with `via=mcp`.

## 10. Web app (humans)

- **Sign-in:** Google OAuth; first user becomes admin; later users from allowed domains join as members.
- **Board:** Kanban columns by status; cards show key, title, assignee avatar (with an agent badge), project, priority. Drag to change status. Filters: assignee, project, humans/agents, "mine".
- **List view:** same filters, sortable table.
- **Task page:** title, description editor, side panel (status, assignee, project, priority, due, open runs and their state), and the **thread** below, with a composer that can post a comment, start a note, add a checklist, or attach files. Open questions are pinned above the composer with an "Answer" action. "Wake agent" button when assignee is an agent.
- **Needs you inbox:** open questions addressed to me (or unaddressed questions on tasks I created), failed/stale runs, @mentions.
- **Projects:** list + project page (its tasks as board/list).
- **Members:** humans and agents. Admins add agents (name, handle, avatar, description, webhook URL, webhook key, "Send test ping"), and see connected MCP tokens.
- **Live updates:** each task page subscribes to the task's channel; the board subscribes to a workspace channel.

Look and feel: clean and dense like Linear; keyboard shortcut `C` to create task, `/` to search.

## 11. Architecture

- **One Cloudflare Worker** serving: the React SPA (static assets), the JSON API (`/api/*`), the MCP endpoint (`/mcp`) and OAuth endpoints, the Queue consumer (webhook dispatch), and a Cron Trigger (stale-run sweep).
- **D1** for all relational data. **R2** for attachments. **KV** for OAuth token storage (as required by `workers-oauth-provider`).
- **Durable Objects:** one per task (WebSocket fan-out of thread/task changes, using hibernation) and one per workspace (board-level changes). Writes go to D1 first, then the Worker notifies the relevant DO to broadcast.
- **Secrets:** `GOOGLE_CLIENT_ID/SECRET`, `SESSION_SECRET`, `WEBHOOK_KEY_ENCRYPTION_KEY` (AES-GCM for agent webhook keys).
- Environments: `staging` and `production` via Wrangler environments.

## 12. Success criteria

1. An Impulze admin adds a Grok Bot as an agent member, connects it to the MCP server, and the test ping starts a run.
2. Assigning a task to the bot results in it reading the task, posting updates, and either completing it or asking a question, all visible live in the thread.
3. Answering the question wakes the bot, which continues and completes the task.
4. Any task's full history (who did what, human or agent, and when) can be read from the task page.
5. A failed or stale agent run shows up in "Needs you" within 15 minutes.

## 13. Left to the builder

- Frontend framework details (React + Vite expected), UI component library, styling.
- API framework within the Worker (e.g. Hono), ORM/migrations (e.g. Drizzle).
- Choice of Markdown-round-tripping editor (e.g. Tiptap or BlockNote with Markdown conversion).
- Exact table schemas and indexes, pagination, error shapes.
- Testing strategy and CI.

## 14. Decisions made during the build (builder's calls, for review)

The builder review raised five open points. The user asked to build without waiting, so these were settled as follows:

1. **One MCP connection per agent.** The OAuth consent screen asks "act as: Myself / <agent>"; the token is bound to that member, so every call is attributed to it. If Grok Bot turns out to share one connector across several bots, the fix is to add an optional `run_id` argument to tools that resolves the agent from the run. Not built yet.
2. **Concurrent runs are allowed per agent** (one open run per task+agent). MCP activity on a task marks that agent's open run on *that task* active; touching other tasks doesn't open or affect runs.
3. **Answers wake the agent that asked the question**, whether or not it's the assignee. Any agent (mentioned or assigned) may ask questions, post, and complete.
4. **Failed/stale runs go to the "Needs you" inbox of the human who triggered the run**; if no human triggered it (e.g. a follow-up), to all admins. Stored as `agent_runs.triggered_by`.
5. **No deadline given → built as one release** with every v1 goal.

Other calls:
- Triggers that arrive while a run is open set `pending_trigger`; when the run ends (question, `end_run`) a single `followup` run is dispatched. Completing a task discards pending triggers.
- Webhook dispatch: 3 attempts (30s, 60s backoff), 15s timeout; rate limit defers to 5 minutes.
- A dev-only email sign-in (`DEV_LOGIN=true`) exists for local testing; must be `false` in production.
- Realtime: one Durable Object per workspace (not per task) broadcasting small change events; clients refetch.
- MCP server is stateless Streamable HTTP with JSON responses (no SSE stream).
