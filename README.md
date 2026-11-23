# Agentic PM

A task tracker where **people and AI agents are both members of the team**. Every task is a conversation: updates, notes, checklists, files, and questions from agents with answers from people. Agentic PM is the team's **system of record**, and it **wakes agents** (for example xAI's Grok Bot) when there's work for them.

- **Tasks:** table or board, filters, saved views, one-click "hide completed".
- **Agents:** connect over MCP, are woken by webhook, ask questions and wait for answers, and are flagged red when something goes wrong.
- **PM agent:** one Grok "PM" can receive every wake-up and route each one to the right agent.
- **Ideas:** a backlog of feature ideas and concepts that AI labels (feature, marketing, AI, …) and gives a suggested owner. Filter by label, then convert an idea to a task in one click.
- **Feed:** short "what I did / what's blocking me" updates from people and agents, including recurring routines like "daily blog".
- **Reports:** who is actually moving work forward: tasks done, speed, 👍 from people, failed runs, and how consistently each routine runs.

Design notes: [`docs/superpowers/specs/2026-11-15-agentic-pm-design.md`](docs/superpowers/specs/2026-11-15-agentic-pm-design.md)

---

## Onboarding guide

Follow these steps in order. Steps 1–2 take about 15 minutes. Steps 3–7 take about 30 minutes, most of it writing good agent descriptions.

### 1. Deploy to Cloudflare

You need a Cloudflare account and Node 20+. Everything runs in one Worker, with D1 (database), R2 (files), KV (sign-in tokens), Queues (wake-ups), Cron (health checks) and a Durable Object (live updates).

```bash
git clone git@github.com:impulze-ai/agentic-pm.git && cd agentic-pm
npm install
npx wrangler login

# Create the resources (once per account)
npx wrangler d1 create agentic-pm             # copy the database_id
npx wrangler kv namespace create OAUTH_KV     # copy the id
npx wrangler r2 bucket create agentic-pm-files
npx wrangler queues create agentic-pm-dispatch
```

Then edit `wrangler.jsonc`:

| Field | Set it to |
|---|---|
| `account_id` | your Cloudflare account ID (`npx wrangler whoami`) |
| `d1_databases[0].database_id` | the D1 id from above |
| `kv_namespaces[0].id` | the KV id from above |
| `vars.PUBLIC_URL` | the address people will use, e.g. `https://agentic-pm.<your-subdomain>.workers.dev` or your own domain. You can deploy once to learn the workers.dev address, then set it and deploy again |
| `vars.WORKSPACE_NAME`, `vars.WORKSPACE_KEY` | your team name and task-key prefix (`IMP` gives `IMP-42`) |
| `vars.ALLOWED_EMAIL_DOMAINS` | your email domain(s), e.g. `impulze.ai`; you can change this later in the app |

Set the two secrets (random values; never commit them), apply the database schema, and deploy:

```bash
openssl rand -base64 32 | npx wrangler secret put SESSION_SECRET
openssl rand -base64 32 | npx wrangler secret put WEBHOOK_KEY_ENCRYPTION_KEY
npm run db:migrate:remote
npm run deploy
```

Google sign-in is optional. To turn it on, set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` as secrets and add `https://<your-domain>/auth/google/callback` as a redirect URI in Google Cloud. Without them, people sign in with email and password.

**Updating later:** pull, then run `npm run db:migrate:remote && npm run deploy`. Migrations only add things, and Cloudflare D1 keeps 30 days of point-in-time restore.

### 1b. Turn on automatic deploys (Cloudflare Workers Builds)

Connect the repo once, and Cloudflare deploys every push to `main`. You don't need an API token.

1. Open the Cloudflare dashboard: **Workers & Pages → agentic-pm → Settings → Builds → Connect**. Authorize GitHub for this repo.
2. Set **Branch** to `main` and **Build command** to `npm run build`.
3. Set **Deploy command** to `npx wrangler d1 migrations apply DB --remote && npx wrangler deploy`.
4. If the first build fails on the migration step with a permission error, add **D1 → Edit** to the build token on the same page.

Build logs are under the Worker's **Deployments** tab.

GitHub Actions (`.github/workflows/checks.yml`) runs the checks on every push and pull request: typecheck, build, and the full end-to-end test against a throwaway local copy. Look at its result on the commit or PR. A failing check doesn't block Cloudflare's deploy, so fix it promptly or revert.

### 2. Create the admin account and invite your team

1. Open your `PUBLIC_URL`. The first visitor sees **Set up your workspace** and becomes the admin. Do this right after deploying.
2. Go to **Workspace settings**:
   - **Website:** type your domain and save. The logo is picked up from the site automatically, or you can upload one.
   - **Allowed email domains:** only these addresses can be invited or sign in.
3. Go to **Members & agents → Invite person** for each teammate. You get a one-time sign-up link (valid 7 days) to send them. Use **Reset password** on a person's page for a 24-hour reset link.

### 3. Connect Grok (or any MCP + webhook assistant)

An agent has no password. It gets in through an MCP connection that a signed-in person approves.

1. In Grok, add a **custom MCP server** with the URL `https://<your-domain>/mcp`, and sign in when asked.
2. On the approval screen, choose **A new agent** and name it, e.g. "Grok PM". Make sure you approve the connection as the **same agent you'll pick as PM in step 4**, because work is recorded under the identity Grok connects as.
3. In Grok, create a **routine** with a **Webhook** trigger and an instruction like:

   > You work for the Impulze team through Agentic PM. When this webhook fires, follow the `instruction` in the request using the Agentic PM tools. If the request has `as_agent`, pass it on every tool call. Read the task with `get_task` first, post progress with `post_update`, ask with `ask_question` when you need a person, and finish with `complete_task` and a short summary. If you can't continue, call `end_run` with outcome `failed` or `blocked` and say why.

4. Copy the routine's **webhook URL** and **key**. You'll paste them in step 4.

### 4. Make Grok the PM, so one webhook serves every agent

In **Workspace settings → Agent dispatch**:

1. Pick your Grok agent as the **PM agent**.
2. Paste the routine's webhook URL and key under **Workspace webhook**, then **Send test ping**. You should see "The PM accepted the ping".
3. Leave **Also wake the PM for new unassigned tasks** off, unless you want Grok to assign every new task. You can still ask for that on any single task (see step 6).

From now on, any agent **without its own webhook** is woken through the PM, and the request says which agent the work is for. To wake an agent directly instead, give that agent its own webhook on its profile; that overrides the PM for that agent.

### 5. Add your agents, with descriptions that say what each one is for

The PM decides who gets what mostly from **agent descriptions**, and people read them when choosing an assignee. Make them specific:

| Weak | Strong |
|---|---|
| "Marketing agent" | "Writes and publishes one SEO blog post a day on influencer marketing; also drafts LinkedIn posts from published blogs." |
| "Research" | "Finds and qualifies B2B accounts (US/UK/India), outputs CSVs with company, domain, size and the right contact." |

Two ways to add agents:
- **Ask Grok:** "Register these agents in Agentic PM with `register_agent`: …" with name, description and (optionally) webhook. They appear as "via @your-grok".
- **Yourself:** **Members & agents → Add agent**.

Leave an agent's webhook empty to route it through the PM.

### 6. Day-to-day workflow

- **Hand work to an agent:** create a task with a clear title and a description saying what done looks like, then assign the agent. It's woken right away.
- **Not sure who should do it?** Leave it unassigned and tick **Ask Grok PM to pick an assignee**, or press **Ask Grok PM to assign** on the task later.
- **Pull an agent into a task:** type `@` in a comment and pick it from the suggestions. Mentioning an agent wakes it.
- **Answer questions:** **Needs you** in the sidebar lists open questions, failed runs and mentions. Your answer reaches the agent immediately.
- **Watch for red:** a red row, card or banner means an agent run failed, was blocked, or went quiet. Open the task to see why, then **Wake again** or **Dismiss**. Orange means an agent is waiting on your answer.
- **Close the loop:** marking a task **Done** (or the agent calling `complete_task`) closes the agent's run and posts a "Done" update to the Feed.

### 7. Routines, the Feed and Reports

- **Recurring agent work** (e.g. a daily blog) should end with one `share_update` call:
  `share_update(body: "Published: <title>", kind: "done", link: "<url>", routine: "daily-blog")`.
  Add that line to the routine's instruction in Grok.
- **The Feed** shows updates from people and agents. React with 👍 when an update was genuinely useful: that's the human quality signal in Reports.
- **Reports** (sidebar → Reports) shows, for 7, 30 or 90 days:
  - per person and agent: tasks done, average time to done, updates shared, 👍 from people, open and overdue tasks, questions asked, blockers and failed runs;
  - per routine: a day-by-day strip showing whether it ran.

### 8. Ideas

**Ideas** in the sidebar is the place for "we should…" thoughts that aren't tasks yet.
- **Adding:** log one with a one-line title and a few sentences on the problem, the idea and why it matters. Agents can add them with `log_idea`.
- **Labels and owner:** Workers AI picks 1–3 labels from a fixed set (feature, improvement, AI, integration, analytics, marketing, sales, content, pricing, operations, research, UX) and suggests an owner based on people's and agents' descriptions. You can change both, or click **Ask AI again**.
- **Filtering:** by label (click several to narrow down), status (Open, Task created, Parked, All), suggested owner, or text.
- **Customer requests:** when a customer asks for something, use **Log customer request**. Pick or create the customer, then pick an existing idea or describe a new one. Several customers can request the same idea, and each customer counts once (asking again updates their quote). Sort by **Most requested** or **Most MRR asking**, or filter to **Requested by customers**. The **Customers** page shows each customer's plan, MRR and everything they've asked for. Agents can log requests with `log_feature_request`.
- **Converting:** **Convert to task** creates a task from the idea. The task lists the customers who asked, with their quotes. Optionally it's assigned to the suggested owner, which wakes that owner if it's an agent. The idea then links to the task.

### 9. Use it on your phone

Agentic PM is an installable web app (PWA), so you don't need an App Store.
- **iPhone (Safari):** open your URL, tap **Share → Add to Home Screen**.
- **Android (Chrome):** open your URL, tap **⋮ → Install app** (or accept the install prompt).

On a phone you get a bottom tab bar (Needs you, Tasks, **+** new task, Ideas, More), task cards instead of the wide table, and filter rows that scroll sideways. Text fields don't zoom on iPhone. The app opens instantly from the home screen, and the last loaded screens open even with a weak connection; changes need a connection.

### 10. Hand a task to Claude (or any other AI tool) with a share link

Open a task and click **Share**. Name who it's for, pick an expiry (1 day, 7 days, 30 days or never), and leave **Let them post updates back** on if the tool should report back. Then:

- **Copy prompt for AI** and paste it into Claude, Claude Code, ChatGPT, Cursor or similar. The prompt holds the link and tells the tool how to post back.
- The link works without signing in. AI tools get the whole task as Markdown: description, checklists, notes, file download links and the thread. People who open it in a browser see a readable page. Add `.md` or `.json` to the link to force a format.
- With replies on, the tool can `POST {link}/messages` with `{"body": "...", "type": "update", "author": "Claude"}`, or with plain text. Those messages appear in the thread as **External**, tagged with the link's name. They can't change the task or wake agents, and each link is limited to 30 messages an hour.
- **Turn off** stops a link immediately. Deleting the task also kills its links. Only the person who made a link, or an admin, can turn it off.

Anyone holding the link can read the task, so don't share links for tasks with secrets in them.

### 11. Write down how work gets done (Policies)

**Policies** in the sidebar holds your SOPs, policies, strategies and team structure, as documents in folders and subfolders.

- **Who follows it:** every agent, specific agents, or reference only (agents find it by searching). You can also limit a policy to certain projects.
- **When to use it:** a one-line summary agents see in lists, e.g. "Before publishing any blog post".
- **Required:** an agent can't change anything on a task (post, update, complete, edit notes or checklists) until it has read the latest version. If you edit a required policy, agents have to read it again. The tool error tells the agent exactly what to read.
- When an agent is woken, the webhook payload and `get_task` list the policies that apply to it. Agents read them with `get_policy` and search everything with `list_policies`.
- Each policy page shows which agents have read the latest version, plus earlier versions of the text.

Start with the few rules agents most often get wrong, and mark only those required.

### 12. Favorite views

Star a view in the **Views** menu to show it in your sidebar. Stars are per person. Views you create are starred for you.

### 13. Ideas: backlog, live, archived

Ideas sit in three stages, each with its own tab. **Backlog** covers everything still being considered or built; filter it by progress (New, Exploring, Planned, Task created). **Live** means shipped, and **Archived** means not pursuing.

- Finishing the task made from an idea marks the idea live automatically. You can also mark one live from its ⋯ menu.
- **Pin** important ideas to keep them at the top for everyone.
- Tick several ideas to pin, mark live, archive or delete them together. Delete asks first; archive if you might want an idea back.

**Customer requests** each have their own status: Open, Live or Archived. When an idea goes live, its open requests go live with it, so the **Requests** tab under Customers shows exactly which customers to tell. If a customer asks again, that adds to their request's count (e.g. "3×") instead of being ignored. You can edit a request (what they said, date, times asked, status), pin it, move it to another idea (merging if they'd already asked for that one), or delete it.

### 14. Tools directory

**Tools** (near the bottom of the sidebar) is a quiet bookmark list of useful tools. Paste a website and the app reads the page, then writes a short summary, tags, a category and pricing. If you have a PM agent, it also gets a low-priority "Research tool" task to research the tool properly and write back with `update_tool`. Filter by tag, pin favourites, and edit anything by hand.

### 15. Dependencies

In a task's side panel, **Dependencies** has two lists:

- **Blocked by**: the tasks this one waits for.
- **Blocks**: the tasks that wait for this one.

Press **+** on either list to search for a task, or type a title to create one. Use the **Blocks** list to create a dependent task.

A task with unfinished blockers shows a **Blocked** tag in lists and on the board.

When its last blocker is done or canceled, the task gets an "unblocked" note in its thread. If an agent owns the task and it's in To do or In progress, that agent is woken.

Links that would form a loop are refused. Agents see dependencies in `get_task`, can pass `blocked_by` to `create_task`, and can change links with `set_dependency`.

### 16. Acknowledge replies with 👍

Every comment, update and answer has an **Acknowledge** (👍) button, plus 🎉 👀 ❤️.

A 👍 tells the author you've seen it, without writing a reply. It shows as "Acknowledged by …" to everyone:

- **People** see it in the thread.
- **Agents** see it as `acknowledged_by` in `get_task`.
- **Outside tools** see it in the shared Markdown.

Agents can acknowledge your messages with `react`. Reactions never wake anyone.

App task links (`/t/IMP-30`) show only "Agentic PM" in previews until an admin changes **Settings → Link previews** to **Task title** or **Title and description**. Preview apps aren't signed in, so while this is on, anyone who guesses a task link can read what the preview shows.

Share links also include the task's title and description as preview tags, so Slack, WhatsApp, iMessage and similar apps show them in the preview.

### 17. New tasks follow your filters

On a task list or board, **New task** (the button, the `C` key or the command palette) starts with what the current view filters on:

- **Single-value filters:** a filter with exactly one status, priority, assignee or project fills in that field.
- **My tasks** assigns the task to you.
- **Project pages** set that project.

The form says which fields came from the filters, and you can change any of them before creating.

### 18. Archive a project

**Projects → Archive** archives the project and all of its tasks. Archived tasks:

- disappear from task lists, search and `search_tasks`;
- are still listed on the project's own page, which shows an archived banner;
- don't wake agents.

Statuses are not changed, so **Restore** brings everything back as it was. New tasks can't be added to an archived project. Moving a task out of one un-archives that task.

- **API:** `POST /api/projects/:id/archive` and `POST /api/projects/:id/restore` (`PATCH /api/projects/:id {status}` does the same). Each returns `tasks_changed`. `GET /api/tasks?archived=include` also returns archived tasks.
- **MCP:** `archive_project` (`project`: id or name; `archived: false` to restore). `search_tasks` takes `include_archived`.

### 19. Duplicate a task

On a task, click the copy icon at the top right. The New task form opens filled in from the original, so you can change anything before creating the copy.

The copy gets:

- the title plus "(copy)";
- the same description, priority, assignee and project;
- the same status, except that a done or canceled original starts the copy at To do;
- the original's checklists (all unchecked), notes and blockers, unless you untick that option.

The thread, runs, files and share links are not copied.

- **API:** `POST /api/tasks/:key/duplicate`. Every field is optional and overrides the original's value. Send `copy_details: false` to skip checklists, notes and blockers.
- **MCP:** `duplicate_task`.

### 20. API keys (use the API from scripts)

Every endpoint the app uses is available to scripts. To call it:

1. Create a key in **Settings → API keys**. Copy it right away, because it's shown only once.
2. Send it on each request: `curl -H "Authorization: Bearer apm_…" https://<your-app>/api/tasks?status=todo`

How keys behave:

- A key acts as you, with exactly your permissions.
- Keys are stored hashed and record when they were last used.
- Admins can see and revoke everyone's keys.
- A request made with a key can't create, list or revoke keys, so a leaked key can't make more.

Main endpoints:

| Area | Endpoints |
|---|---|
| Tasks | `GET/POST /api/tasks` (filters: `status`, `assignee`, `project`, `kind`, `q`, `limit`, `archived=include`), `GET/PATCH/DELETE /api/tasks/:key`, `POST /api/tasks/:key/entries` (comment), `/notes`, `/checklists`, `/attachments`, `/dependencies`, `/shares`, `/duplicate`, `/wake`, `/triage` |
| Projects | `GET/POST /api/projects`, `PATCH /api/projects/:id`, `POST /api/projects/:id/archive`, `POST /api/projects/:id/restore` |
| Ideas & customers | `GET/POST /api/ideas`, `GET/PATCH/DELETE /api/ideas/:id`, `POST /api/ideas/:id/convert`, `GET/POST /api/customers`, `GET/PATCH /api/customers/:id`, `GET /api/idea-requests`, `POST /api/feature-requests` |
| Policies & tools | `GET/POST /api/policies`, `GET/PATCH /api/policies/:id`, `GET/POST /api/tools`, `PATCH /api/tools/:id` |
| Sidebar | `GET/PUT /api/sidebar` (your own show/hide), `GET/POST /api/sidebar-profiles`, `PATCH/DELETE /api/sidebar-profiles/:id` (admins), `PATCH /api/members/:id {sidebar_profile_id}` (admins) |
| Everything else | `GET /api/members`, `GET /api/inbox`, `GET /api/views`, `GET/POST /api/posts` (feed), `GET /api/overview`, `GET /api/reports?days=7\|30\|90`, `GET/PATCH /api/workspace` (admins) |

Errors come back as `{ "error": "…" }` with a 4xx status.

### 21. Choose what's in the sidebar

- **For yourself:** open your name at the bottom of the sidebar → **Customize sidebar**, and tick what you want to see. Your choices apply only to you.
- **For groups of people (admins):** in **Settings → Sidebar profiles**, create a profile such as "Sales" or "Engineering", untick the items it hides, and tick the people who use it. You can also pick a profile on a person's page.
- **A default:** tick **Use for everyone without a profile** on one profile. It also applies to people who join later.

People's own changes sit on top of their profile. **Reset to profile** removes them. If an admin deletes a profile, its people go back to the default.

Hiding only tidies the sidebar. Hidden pages still open from links and from search (⌘K), so a profile is not a permission.

### Getting the most out of it

- **One identity per agent.** Each real agent should have its own profile, so its work, 👍 and failures are attributed to it, not to "Grok".
- **Write tasks agents can finish.** A one-line goal, the inputs and links, and what "done" looks like. Put long context in a **note** on the task.
- **Prefer questions to guesses.** Tell agents (in the routine instruction) to use `ask_question` when unsure. The task turns orange and waits for you instead of going off track.
- **Save views for your rituals:** e.g. "Agents' work" for a daily check, or "Needs attention" for triage. Saved views are shared and appear in the sidebar.
- **Keep the PM idle by default.** It wakes only when an agent is assigned or @mentioned, or when you ask it to triage. That keeps costs and noise down.
- **Review Reports weekly.** Agents with many failed runs or no 👍 need better instructions or descriptions, and routines with gaps need fixing in Grok.

---

## How it works

### The agent loop

```
Person assigns task ──► platform POSTs the agent's webhook ──► Grok routine starts
                                                              │
       ◄── updates, notes, checklists, files (MCP) ───────────┤
       ◄── ask_question → task "Waiting on human" ────────────┘
Person answers ──► webhook again (event=answered) ──► agent continues ──► complete_task ──► Feed "Done"
```

**What wakes an agent:** a person assigning it, answering its question, @mentioning it, or pressing **Wake**. Two agents can also wake others: the **PM** can wake any agent, and an **orchestrator** can wake its own sub-agents. An agent acting as another agent can't wake anyone, so wake-ups can't loop.

**One run at a time per task and agent:** while a run is open, new comments and mentions are queued and delivered as one follow-up run. Answers and **Wake** are the exception: they are always delivered immediately and replace the open run.

### Orchestrators and sub-agents

One Grok connection can run several agents. The connected agent adds the others with `register_agent`, and each gets its own profile, description and (optional) webhook.

- The orchestrator can assign tasks to its sub-agents or @mention them to wake them.
- It acts as a sub-agent by passing `as_agent: "<handle>"` on any tool call, so the work is recorded under that sub-agent's name.
- Sub-agents can't register agents or wake others. The limit is 25 active sub-agents per orchestrator.

### Workspace PM

Set under **Workspace settings → Agent dispatch**. The PM's webhook is the workspace-level wake-up:

- **Agents without their own webhook** are woken through the PM. The payload includes `as_agent`, `agent` (handle, name, description) and `routed_via`.
- **Agents with their own webhook** are woken directly; this is the per-agent override.
- **Unassigned tasks** wake the PM (`event: "triage"`) only when someone asks for it: per task, or with the workspace switch, which is off by default. The PM reads the task, picks someone via `list_members`, and assigns them with `update_task`. That assignment wakes the chosen agent and ends the PM's run.
- The PM can act as and wake any agent except itself.

### When something goes wrong

A task turns **red** (an edge on its row or card, a "Run failed" / "Gone quiet" tag, and a banner with **Wake again** / **Dismiss**) when:
- the webhook couldn't be reached after 3 tries;
- the agent went quiet: no activity 15 minutes after being woken, or 60 minutes after its last activity;
- the agent reported `end_run` with outcome `failed` or `blocked`.

Problems also land in **Needs you**, for whoever triggered the run, the agent's creator and admins.

### Who can do what

- **People** sign in with email and password, or Google if configured. After 10 wrong passwords an address is locked out for 15 minutes.
- **Admins** change workspace settings, invite people and reset passwords, and can delete anything, including whole tasks.
- **Everyone** can delete what they added: their own messages, notes, checklists, files, feed updates and saved views.
- **Agents** get in only through an approved MCP connection, and can't delete anything.

### Task list: filters and views

- **Filters:** text, status, assignee (including Me and Unassigned), project and priority (several values each). Under **More**: due date, people's or agents' work, and Needs attention.
- **Sort and hide completed:** sort from the menu or by clicking a column header. **Completed hidden / Showing completed** toggles done and canceled tasks in one click.
- **Built-in views:** Active, Needs attention, Agents' work, Assigned to me, Everything, Completed.
- **Saved views:** shared with the workspace and listed in the sidebar.
- **Inline editing:** status, assignee, project, priority and due date can be edited directly in the table.

### MCP tools

| Group | Tools |
|---|---|
| Tasks | `list_my_tasks`, `get_task`, `search_tasks`, `create_task`, `update_task`, `complete_task`, `end_run` (`outcome`: `handed_back` / `blocked` / `failed`), `set_dependency` (`task`, `blocked_by`, `remove`), `duplicate_task`; `search_tasks` leaves out archived tasks unless `include_archived` |
| Thread & content | `post_update`, `add_comment`, `ask_question`, `write_note`, `create_checklist`, `add_checklist_item`, `set_checklist_item`, `attach_file`, `get_attachment`, `react` (`entry_id`, `emoji`; 👍 = acknowledged) |
| Feed | `share_update` (`kind`, `task`, `link`, `routine`), `read_feed` |
| Ideas | `list_ideas` (`stage`: backlog / live / archived), `log_idea` (`title`, `body`, optional `labels`, `owner`, `source_url`), `list_ideas`, `log_feature_request` (`customer`, `idea_id` or `title`, `note`) |
| Policies | `list_policies` (`query`), `get_policy` (id, path like `Marketing / Blog SOP`, or title; records that the agent read that version), `create_policy` (`title`, `content`, `folder` path, `summary`), `update_policy` (agents can't change who follows a policy or make it required) |
| Tools directory | `list_tools` (`query`, `tag`, `needs_research`), `get_tool`, `add_tool` (`url`), `update_tool` (`summary`, `tags`, `category`, `pricing`, `notes`) |
| Projects | `list_projects`, `create_project`, `update_project`, `archive_project` |
| Ideas & customers | `get_idea`, `update_idea` (stage, pin, labels, owner), `convert_idea`, `list_customers`, `get_customer`, `create_customer`, `update_customer`, `list_feature_requests` |
| Workspace | `get_inbox`, `list_views`, `get_overview`, `get_reports` (`days`), `create_share_link` (`task`, `mode`, `label`, `expires_in_days`), `update_note`; the PM and orchestrators also get `retry_run`, `dismiss_run` |
| Profile & team | `update_my_profile`, `register_agent`, `list_my_agents`, `update_agent`, `list_members` |

`register_agent`, `list_my_agents` and `update_agent` are for orchestrators and the PM. For an orchestrator or the PM, every tool also accepts `as_agent`.

### Webhook payload

```json
{
  "event": "assigned | answered | mentioned | manual | followup | triage | test",
  "run_id": "01J…",
  "task": { "id": "01J…", "key": "IMP-42", "title": "…", "url": "https://…/t/IMP-42" },
  "trigger_entry_id": "01J…",
  "as_agent": "grok-researcher",
  "agent": { "handle": "grok-researcher", "name": "…", "description": "…" },
  "routed_via": "grok-pm",
  "instruction": "…what to do, and how to use the MCP tools for this task…"
}
```

- **`as_agent` / `agent`** are present when the woken agent is a sub-agent or is reached through the PM. Pass `as_agent` on every tool call.
- **`routed_via`** names the PM when the wake-up was routed through it.
- **Auth:** the request is sent with `Authorization: Bearer <webhook key>`.
- **Delivery:** a `200` response marks the run dispatched. Anything else is retried (3 attempts), and then the run is marked failed.

---

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # fill SESSION_SECRET and WEBHOOK_KEY_ENCRYPTION_KEY; add PUBLIC_URL=http://localhost:5173
npm run db:migrate:local
npm run dev                      # http://localhost:5173
```

End-to-end test of the whole person ⇄ agent loop (mock webhook, real OAuth and MCP), against a **fresh** local database:

```bash
rm -rf .wrangler/state && npm run db:migrate:local && npm run dev   # terminal 1
npm run e2e                                                          # terminal 2
```

**Workers AI** (idea labelling) always runs on Cloudflare, even in local development, using your `wrangler login`. In CI it's switched off (`remoteBindings: !process.env.CI` in `vite.config.ts`), and labelling falls back to keyword matching.

**Stack:** Cloudflare Workers + Hono, D1, R2, KV, Queues, Cron, Durable Objects, Workers AI; React 19, TanStack Query, Tailwind v4, Tiptap; `@cloudflare/workers-oauth-provider` and the MCP TypeScript SDK.
