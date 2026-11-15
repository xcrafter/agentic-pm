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

Agents are woken only by **human** actions: assignment, answering the agent's question, an `@mention`, or the "Wake" button. Agent actions never wake agents (loop guard). While a run is open, new triggers are queued and delivered as one follow-up run.

## Stack

All on Cloudflare: one Worker serves the React app, JSON API, MCP server (`/mcp`, OAuth 2.1 + dynamic client registration), webhook dispatch (Queues), a stale-run sweep (Cron), and live updates (a Durable Object per workspace). Data in **D1**, attachments in **R2**, OAuth tokens in **KV**.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars        # fill SESSION_SECRET and WEBHOOK_KEY_ENCRYPTION_KEY
npm run db:migrate:local
npm run dev                            # http://localhost:5173
```

With `DEV_LOGIN=true` (the default in `wrangler.jsonc`) you can sign in at `/auth/dev` with any `@impulze.ai` address. The first person to sign in becomes admin.

End-to-end test of the whole human ⇄ agent loop (mock webhook, real OAuth, MCP), run against a **fresh** local database:

```bash
rm -rf .wrangler/state && npm run db:migrate:local && npm run dev   # terminal 1
npm run e2e                                                          # terminal 2
```

## Connecting Grok Bot

1. **Members & agents → Add agent.** Give it a name, handle and description.
2. In Grok Bot, create a **routine** with a **Webhook** trigger and an instruction like *"Work the Agentic PM task in the request using the Agentic PM tools."* Copy its **POST URL** and **key** into the agent's webhook settings, then **Send test ping**.
3. In Grok Bot, add a **custom MCP server** with URL `https://<your-domain>/mcp` and sign in. On the consent screen choose **Act as: <the agent>** (admins only).
4. Assign a task to the agent. It will be woken, read the task with `get_task`, and post back to the thread.

One Grok Bot = one agent member. Any other assistant that can be woken by a webhook and speaks MCP (e.g. a Claude routine) works the same way. People can also connect their own assistant over MCP choosing **Act as: Myself**.

### MCP tools

`list_my_tasks`, `get_task`, `search_tasks`, `create_task`, `update_task`, `post_update`, `add_comment`, `ask_question`, `write_note`, `create_checklist`, `set_checklist_item`, `add_checklist_item`, `attach_file`, `get_attachment`, `complete_task`, `end_run`, `list_projects`, `list_members`.

### Webhook payload

```json
{
  "event": "assigned | answered | mentioned | manual | followup | test",
  "run_id": "01J…",
  "task": { "id": "01J…", "key": "IMP-42", "title": "…", "url": "https://…/t/IMP-42" },
  "trigger_entry_id": "01J…",
  "instruction": "…how to use the MCP tools for this task…"
}
```

Sent with `Authorization: Bearer <agent webhook key>`. A `200` marks the run dispatched; anything else is retried (3 attempts), then the run is marked failed and shows in **Needs you**. A run with no MCP activity 15 min after dispatch (or 60 min after its last activity) is marked stale.

## Deploying

```bash
npx wrangler d1 create agentic-pm            # put the id in wrangler.jsonc
npx wrangler kv namespace create OAUTH_KV    # put the id in wrangler.jsonc
npx wrangler r2 bucket create agentic-pm-files
npx wrangler queues create agentic-pm-dispatch
npx wrangler secret put SESSION_SECRET
npx wrangler secret put WEBHOOK_KEY_ENCRYPTION_KEY   # openssl rand -base64 32
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

In `wrangler.jsonc` set `PUBLIC_URL` to the deployed origin and `DEV_LOGIN` to `"false"`. In Google Cloud, add `https://<domain>/auth/google/callback` as an authorized redirect URI. Then:

```bash
npm run db:migrate:remote
npm run deploy
```
