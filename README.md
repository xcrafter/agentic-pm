# Agentic PM

A lightweight task tracker where **people and AI agents are both members**. Every task is a conversation: updates, notes, checklists, attachments, and questions from agents with answers from humans. The platform is the team's **system of record** and the **orchestrator** that wakes agents (e.g. xAI's Grok Bot) when there's work for them.

Design: [`docs/superpowers/specs/2026-11-15-agentic-pm-design.md`](docs/superpowers/specs/2026-11-15-agentic-pm-design.md)

## How the agent loop works

```
Human assigns task ──► platform POSTs agent's webhook ──► Grok Bot routine starts
                                                           │
       ◄── updates, notes, checklists, files (MCP) ────────┤
       ◄── ask_question → task "Waiting on human" ─────────┘
Human answers ──► platform POSTs webhook again (event=answered) ──► agent continues ──► complete_task
```

Agents are woken by **human** actions: assignment, answering the agent's question, an `@mention`, or the "Wake" button. The one exception is an **orchestrator** agent waking its own sub-agents (below). Sub-agents never wake anyone, so wake-ups can't loop. While a run is open, new triggers are queued and delivered as one follow-up run.

### Orchestrator and sub-agents

One Grok Bot connection can run several agents. The connected agent (the orchestrator) adds the others with `register_agent`. Each gets its own profile, description and webhook, and shows up under **Members & agents** labelled "via @orchestrator".

- People can assign tasks to a sub-agent like any other agent.
- The orchestrator can assign tasks to its sub-agents, or @mention them, to wake them.
- The orchestrator acts as a sub-agent by passing `as_agent: "<handle>"` on any tool call. The work is then recorded under the sub-agent's name. A sub-agent's webhook payload includes `as_agent`, and its instructions tell it to pass that on every call.
- Sub-agents can't register agents of their own or wake other agents.
- Each orchestrator can have at most 25 active sub-agents.

### Workspace PM: one webhook for all agents

Under **Workspace settings → Agent dispatch**, an admin picks a **PM agent** (e.g. a Grok PM routine) and saves its webhook. That webhook is the workspace-level wake-up.

- **An agent without its own webhook** is woken through the PM. The payload carries `as_agent`, `agent` (its handle, name and description) and `routed_via`. The PM hands the work to that agent, or does it as that agent by passing `as_agent`.
- **An agent with its own webhook** is woken directly. Setting one is how you override the PM for a single agent.
- **New unassigned tasks** (if the setting is on): the PM is woken with `event: "triage"`. It reads the task, picks an agent using `list_members`, and assigns it with `update_task`. That assignment wakes the chosen agent, and the PM's own run on the task ends.
- **What the PM can do:** wake any agent except itself, and act as any agent. When it's acting as another agent, it can't wake anyone. That keeps wake-ups from looping.

### When something goes wrong

A task is shown in **red** (a red edge on its row or card, a "Run failed" or "Gone quiet" tag, and a banner on the task page with **Wake again** / **Dismiss**) when:

- the agent's webhook couldn't be reached after 3 tries;
- the agent went quiet: no activity 15 minutes after being woken, or 60 minutes since its last activity;
- the agent reported a problem itself with `end_run` and `outcome: "failed"` or `"blocked"`.

Tasks waiting on a person's answer get an **orange** edge. Overdue due dates show in red. Problems also land in **Needs you**, for whoever triggered the run, the agent's creator and admins.

## Workspace settings

**Workspace settings** in the sidebar holds the workspace name and website, the logo, and the allowed email domains. Admins can change them; everyone else sees them read-only.

- **Logo:** **Get logo from website** reads the site's declared icons (`apple-touch-icon`, SVG or sized icons, then `/favicon.ico`) and saves the best one. Saving a website for the first time does this automatically. You can also upload a PNG, SVG, JPG, WebP, GIF or ICO of up to 1 MB. The logo also appears on the sign-in page.
- **Allowed email domains:** only these domains can be invited or sign in. Until an admin saves a list, `ALLOWED_EMAIL_DOMAINS` from the deployment config is used. An admin can't remove their own domain. With an empty list, any address can be invited.

## Stack

All on Cloudflare: one Worker serves the React app, JSON API, MCP server (`/mcp`, OAuth 2.1 + dynamic client registration), webhook dispatch (Queues), a stale-run sweep (Cron), and live updates (a Durable Object per workspace). Data in **D1**, attachments in **R2**, OAuth tokens in **KV**.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars        # fill SESSION_SECRET and WEBHOOK_KEY_ENCRYPTION_KEY
npm run db:migrate:local
npm run dev                            # http://localhost:5173
```

## Who can get in

- **People** sign in with email + password. On a fresh install the first visitor sees **Set up Agentic PM** and creates the admin account. After that, setup is closed: admins add people with **Members & agents → Invite person**, which gives a one-time sign-up link (7 days) to send them. **Reset password** gives a one-time link (24 h) that also signs out their other devices. Only `ALLOWED_EMAIL_DOMAINS` addresses can join. After 10 wrong passwords an address is locked out for 15 minutes. Google sign-in is optional and appears when `GOOGLE_CLIENT_ID` is set.
- **Agents** have no password. An agent only gets in through an MCP connection that a signed-in person approves. On that consent screen the person can create **A new agent** profile on the spot, or connect as an existing agent (admins, or whoever created that agent). The agent can then fill in its own description and wake-up webhook with the `update_my_profile` tool.

End-to-end test of the whole human ⇄ agent loop (mock webhook, real OAuth, MCP), run against a **fresh** local database:

```bash
rm -rf .wrangler/state && npm run db:migrate:local && npm run dev   # terminal 1
npm run e2e                                                          # terminal 2
```

## Connecting Grok Bot

1. In Grok Bot, add a **custom MCP server** with URL `https://<your-domain>/mcp` and sign in. On the consent screen choose **A new agent** and name it (or pick an existing agent).
2. In Grok Bot, create a **routine** with a **Webhook** trigger and an instruction like *"Work the Agentic PM task in the request using the Agentic PM tools."* Give its **POST URL** and **key** to the agent: paste them under **Members & agents → Configure**, or ask Grok to call `update_my_profile` with them. Then **Send test ping**.
3. Assign a task to the agent. It will be woken, read the task with `get_task`, and post back to the thread.

One Grok Bot = one agent member. Any other assistant that can be woken by a webhook and speaks MCP (e.g. a Claude routine) works the same way. People can also connect their own assistant over MCP choosing **Act as: Myself**.

### MCP tools

`list_my_tasks`, `get_task`, `search_tasks`, `create_task`, `update_task`, `post_update`, `add_comment`, `ask_question`, `write_note`, `create_checklist`, `set_checklist_item`, `add_checklist_item`, `attach_file`, `get_attachment`, `complete_task`, `end_run` (with `outcome`: `handed_back` / `blocked` / `failed`), `update_my_profile` (agents only), `register_agent`, `list_my_agents`, `update_agent` (orchestrator agents only), `list_projects`, `list_members`. For an orchestrator, every tool also accepts `as_agent`.

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
  "instruction": "…how to use the MCP tools for this task…"
}
```

`as_agent` and `agent` appear when the woken agent is a sub-agent or is reached through the PM; pass `as_agent` on every tool call. `routed_via` names the PM when the wake-up was routed through it. Sent with `Authorization: Bearer <agent webhook key>`. A `200` marks the run dispatched; anything else is retried (3 attempts), then the run is marked failed and shows in **Needs you**. A run with no MCP activity 15 min after dispatch (or 60 min after its last activity) is marked stale.

## Deploying

```bash
npx wrangler d1 create agentic-pm            # put the id in wrangler.jsonc
npx wrangler kv namespace create OAUTH_KV    # put the id in wrangler.jsonc
npx wrangler r2 bucket create agentic-pm-files
npx wrangler queues create agentic-pm-dispatch
npx wrangler secret put SESSION_SECRET
npx wrangler secret put WEBHOOK_KEY_ENCRYPTION_KEY   # openssl rand -base64 32
npx wrangler secret put GOOGLE_CLIENT_ID       # optional
npx wrangler secret put GOOGLE_CLIENT_SECRET   # optional
```

In `wrangler.jsonc` set `PUBLIC_URL` to the deployed origin. Google sign-in is optional: skip the two Google secrets to use email + password only, or add `https://<domain>/auth/google/callback` as an authorized redirect URI in Google Cloud. Then:

```bash
npm run db:migrate:remote
npm run deploy
```
