/**
 * Orchestrator agents and their sub-agents.
 *
 * An agent connected over MCP (e.g. the Grok Bot orchestrator) can register the other agents it runs
 * as sub-agents (members with created_by = the orchestrator). It can act as any of them by passing
 * `as_agent` on a tool call, and assigning or @mentioning one of its own sub-agents wakes it.
 *
 * Loop guard: humans can wake any agent; an orchestrator can wake only its own sub-agents;
 * sub-agents can't wake anyone and can't register agents of their own (depth is 1).
 */
import type { Actor, MemberRow } from "./domain";
import { logActivity, notify, publicMember } from "./domain";
import { uniqueHandle } from "./auth";
import { type AppEnv, HttpError, encryptSecret, newId, nowIso } from "./util";

export const MAX_SUB_AGENTS = 25;

/** May this actor's action wake `agent`? */
export function canWake(actor: Actor, agent: MemberRow) {
  if (agent.kind !== "agent") return false;
  if (actor.member.kind === "human") return true;
  return agent.created_by === actor.member.id;
}

/** Is `m` a sub-agent (created by another agent)? Returns the parent when it is. */
export async function parentAgentOf(env: AppEnv, m: MemberRow): Promise<MemberRow | null> {
  if (m.kind !== "agent" || !m.created_by) return null;
  const parent = await env.DB.prepare("SELECT * FROM members WHERE id = ? AND kind = 'agent'").bind(m.created_by).first<MemberRow>();
  return parent ?? null;
}

/** Can a top-level agent register sub-agents? (Sub-agents can't.) */
export async function canOrchestrate(env: AppEnv, m: MemberRow) {
  return m.kind === "agent" && !(await parentAgentOf(env, m));
}

/** Humans who can manage an agent: admins, its creator, and (for a sub-agent) whoever created its orchestrator. */
export async function canManageAgent(env: AppEnv, me: MemberRow, target: MemberRow) {
  if (me.role === "admin" || target.created_by === me.id) return true;
  const parent = await parentAgentOf(env, target);
  return !!parent && parent.created_by === me.id;
}

export async function listSubAgents(env: AppEnv, parentId: string) {
  const rows = await env.DB.prepare("SELECT * FROM members WHERE created_by = ? AND kind = 'agent' ORDER BY name")
    .bind(parentId)
    .all<MemberRow>();
  return rows.results;
}

export async function getSubAgent(env: AppEnv, parent: MemberRow, ref: string) {
  const handle = ref.replace(/^@/, "").toLowerCase();
  const m = await env.DB.prepare(
    "SELECT * FROM members WHERE workspace_id = ? AND kind = 'agent' AND created_by = ? AND (id = ? OR handle = ?)",
  )
    .bind(parent.workspace_id, parent.id, ref, handle)
    .first<MemberRow>();
  if (!m) throw new HttpError(404, `"${ref}" isn't one of your agents. Use list_my_agents to see them.`);
  return m;
}

export interface AgentProfileInput {
  name?: string;
  description?: string;
  webhook_url?: string;
  webhook_key?: string;
  wake_on_mention?: boolean;
  active?: boolean;
}

export async function applyAgentProfile(env: AppEnv, actor: Actor, target: MemberRow, input: AgentProfileInput) {
  const sets: string[] = [];
  const binds: unknown[] = [];
  const set = (col: string, v: unknown) => (sets.push(`${col} = ?`), binds.push(v));
  if (input.name?.trim()) set("name", input.name.trim().slice(0, 60));
  if (input.description !== undefined) set("description", input.description.slice(0, 500));
  if (input.webhook_url !== undefined) {
    if (input.webhook_url && !/^https?:\/\//.test(input.webhook_url)) throw new HttpError(400, "Webhook URL must be http(s)");
    set("webhook_url", input.webhook_url || null);
  }
  if (input.webhook_key) set("webhook_key_encrypted", await encryptSecret(env, input.webhook_key));
  if (input.wake_on_mention !== undefined) set("wake_on_mention", input.wake_on_mention ? 1 : 0);
  if (input.active !== undefined) set("active", input.active ? 1 : 0);
  if (sets.length) {
    await env.DB.prepare(`UPDATE members SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, target.id).run();
    await logActivity(env, target.workspace_id, actor, "member", target.id, "updated", undefined, {
      ...input,
      webhook_key: input.webhook_key ? "***" : undefined,
    });
    await notify(env, target.workspace_id, { type: "members" });
  }
  return (await env.DB.prepare("SELECT * FROM members WHERE id = ?").bind(target.id).first<MemberRow>())!;
}

export async function registerSubAgent(env: AppEnv, parent: MemberRow, input: AgentProfileInput & { name: string; handle?: string }) {
  if (!(await canOrchestrate(env, parent))) throw new HttpError(403, "Sub-agents can't register agents of their own");
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE created_by = ? AND kind = 'agent' AND active = 1")
    .bind(parent.id)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_SUB_AGENTS) throw new HttpError(400, `You already have ${MAX_SUB_AGENTS} active agents; deactivate one first`);
  const name = input.name.trim().slice(0, 60);
  if (!name) throw new HttpError(400, "Name is required");
  const handle = await uniqueHandle(env, parent.workspace_id, input.handle || name);
  const id = newId();
  await env.DB.prepare(
    `INSERT INTO members (id, workspace_id, kind, name, handle, role, description, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  )
    .bind(id, parent.workspace_id, "agent", name, handle, "member", "", parent.id, nowIso())
    .run();
  const actor: Actor = { member: parent, via: "mcp" };
  await logActivity(env, parent.workspace_id, actor, "member", id, "agent_created", undefined, { name, handle, orchestrator: parent.handle });
  const fresh = (await env.DB.prepare("SELECT * FROM members WHERE id = ?").bind(id).first<MemberRow>())!;
  const { name: _n, ...rest } = input;
  return applyAgentProfile(env, actor, fresh, rest);
}

export function agentSummary(m: MemberRow) {
  const p = publicMember(m);
  return {
    handle: p.handle,
    name: p.name,
    description: p.description,
    active: p.active,
    webhook_set: p.has_webhook,
    wake_on_mention: p.wake_on_mention,
  };
}
