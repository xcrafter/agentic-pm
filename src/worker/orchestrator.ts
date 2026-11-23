/**
 * Orchestrator: decides when to wake agents, dispatches webhook calls through a queue,
 * tracks agent runs, and flags runs that fail or go quiet.
 */
import type { MemberRow, TaskRow } from "./domain";
import { addSystemEntry, getMember, getWorkspace, notify, taskKey } from "./domain";
import { policiesFor } from "./policies";
import { type AppEnv, decryptSecret, newId, nowIso } from "./util";

export type TriggerKind = "assigned" | "answered" | "mentioned" | "manual" | "followup" | "triage";

/**
 * Where to send an agent's wake-up: its own webhook if it has one (an override), otherwise the
 * workspace PM agent's webhook, with the PM told which agent the work is for.
 */
export interface WakeRoute {
  url: string;
  keyEncrypted: string;
  via: MemberRow | null;
}
export async function resolveWake(env: AppEnv, agent: MemberRow): Promise<WakeRoute | null> {
  if (agent.webhook_url && agent.webhook_key_encrypted) return { url: agent.webhook_url, keyEncrypted: agent.webhook_key_encrypted, via: null };
  const ws = await getWorkspace(env, agent.workspace_id);
  if (!ws.pm_agent_id || ws.pm_agent_id === agent.id) return null;
  const pm = await env.DB.prepare("SELECT * FROM members WHERE id = ? AND kind = 'agent' AND active = 1").bind(ws.pm_agent_id).first<MemberRow>();
  if (!pm?.webhook_url || !pm.webhook_key_encrypted) return null;
  return { url: pm.webhook_url, keyEncrypted: pm.webhook_key_encrypted, via: pm };
}

export interface RunRow {
  id: string;
  task_id: string;
  agent_id: string;
  trigger: TriggerKind;
  trigger_entry_id: string | null;
  triggered_by: string | null;
  status: "queued" | "dispatched" | "active" | "ended" | "failed" | "stale";
  pending_trigger: number;
  attempts: number;
  last_error: string | null;
  dismissed: number;
  created_at: string;
  dispatched_at: string | null;
  last_activity_at: string | null;
  ended_at: string | null;
}

export interface DispatchMessage {
  runId: string;
}

const OPEN_STATUSES = "('queued','dispatched','active')";
const MAX_ATTEMPTS = 3;
export const STALE_DISPATCHED_MINUTES = 15;
export const STALE_ACTIVE_MINUTES = 60;

export async function onAgentTrigger(
  env: AppEnv,
  opts: { task: TaskRow; agent: MemberRow; trigger: TriggerKind; triggerEntryId?: string; triggeredBy?: string | null },
): Promise<RunRow | null> {
  const { task, agent } = opts;
  if (agent.kind !== "agent" || !agent.active) return null;
  // Archived with its project: nobody works on it until the project is restored.
  const archived = await env.DB.prepare("SELECT archived_at FROM tasks WHERE id = ?").bind(task.id).first<{ archived_at: string | null }>();
  if (archived?.archived_at) return null;
  if (!(await resolveWake(env, agent))) {
    await addSystemEntry(env, task, agent, "agent_not_configured", { agent_name: agent.name });
    return null;
  }

  // Coalesce: one open run per (task, agent). Further triggers are flagged for a follow-up run.
  const open = await env.DB.prepare(
    `SELECT * FROM agent_runs WHERE task_id = ? AND agent_id = ? AND status IN ${OPEN_STATUSES} LIMIT 1`,
  )
    .bind(task.id, agent.id)
    .first<RunRow>();
  if (open) {
    // An answer to the agent's question, or a person pressing Wake, must reach the agent now: it may be
    // waiting on exactly this, and an open run (e.g. an idle follow-up) would otherwise hold it back.
    if (opts.trigger === "answered" || opts.trigger === "manual") {
      await env.DB.prepare("UPDATE agent_runs SET status = 'ended', ended_at = ?, last_error = ? WHERE id = ? AND status IN " + OPEN_STATUSES)
        .bind(nowIso(), `superseded by ${opts.trigger}`, open.id)
        .run();
    } else {
      await env.DB.prepare("UPDATE agent_runs SET pending_trigger = 1 WHERE id = ?").bind(open.id).run();
      return open;
    }
  }

  const run: RunRow = {
    id: newId(),
    task_id: task.id,
    agent_id: agent.id,
    trigger: opts.trigger,
    trigger_entry_id: opts.triggerEntryId ?? null,
    triggered_by: opts.triggeredBy ?? null,
    status: "queued",
    pending_trigger: 0,
    attempts: 0,
    last_error: null,
    dismissed: 0,
    created_at: nowIso(),
    dispatched_at: null,
    last_activity_at: null,
    ended_at: null,
  };
  await env.DB.prepare(
    `INSERT INTO agent_runs (id, task_id, agent_id, trigger, trigger_entry_id, triggered_by, status, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  )
    .bind(run.id, run.task_id, run.agent_id, run.trigger, run.trigger_entry_id, run.triggered_by, run.status, run.created_at)
    .run();
  await addSystemEntry(env, task, agent, "agent_woken", { trigger: opts.trigger, run_id: run.id });
  await env.DISPATCH_QUEUE.send({ runId: run.id } satisfies DispatchMessage);
  await notify(env, task.workspace_id, { type: "thread", task_id: task.id });
  return run;
}

export function buildPayload(
  publicUrl: string,
  run: RunRow,
  task: TaskRow,
  key: string,
  asAgent?: { handle: string; name: string; description?: string | null },
  via?: { handle: string; name: string },
) {
  const event = run.trigger === "followup" ? "followup" : run.trigger;
  const why: Record<string, string> = {
    assigned: "This task was assigned to you.",
    answered: "A human answered your question on this task.",
    mentioned: "A human mentioned you on this task.",
    manual: "A human asked you to pick this task up.",
    followup: "There is new activity on this task since your last run.",
    triage: "A new task was created without an assignee, and you are the workspace PM.",
  };
  if (event === "triage") {
    return {
      event,
      run_id: run.id,
      task: { id: task.id, key, title: task.title, url: `${publicUrl.replace(/\/$/, "")}/t/${key}` },
      instruction:
        `${why.triage} Read it with get_task("${key}"), then pick who should do it: call list_members and compare agents' descriptions. ` +
        `Assign it with update_task (assignee = their handle); assigning an agent wakes it. ` +
        `If the task is unclear, use ask_question. If no agent fits, assign a person or leave a comment explaining why, then end_run.`,
    };
  }
  return {
    event,
    run_id: run.id,
    task: { id: task.id, key, title: task.title, url: `${publicUrl.replace(/\/$/, "")}/t/${key}` },
    trigger_entry_id: run.trigger_entry_id,
    ...(asAgent ? { as_agent: asAgent.handle, agent: { handle: asAgent.handle, name: asAgent.name, description: asAgent.description ?? "" } } : {}),
    ...(via ? { routed_via: via.handle } : {}),
    instruction:
      (via
        ? `This wake-up is for the agent ${asAgent!.name} (@${asAgent!.handle}), routed to you (@${via.handle}) as the workspace PM because it has no webhook of its own. ` +
          `Hand it to that agent, or do the work as it. Either way pass as_agent: "${asAgent!.handle}" on EVERY Agentic PM tool call for this task. `
        : asAgent
          ? `You are acting as the agent ${asAgent.name} (@${asAgent.handle}). Pass as_agent: "${asAgent.handle}" on EVERY Agentic PM tool call for this task. `
          : "") +
      `${why[event]} You are working task ${key} in Agentic PM. Use the Agentic PM MCP tools: ` +
      `call get_task("${key}") first to read the task and its thread (new activity is listed under "unread"). ` +
      `Post progress with post_update as you work. If you need a decision or information from a human, ` +
      `use ask_question and stop: you will be woken again when they answer. ` +
      `When the work is finished, call complete_task with a short summary. ` +
      `If you stop without finishing, call end_run with the reason (outcome "failed" or "blocked" if something went wrong).`,
  };
}

async function postWebhook(env: AppEnv, route: WakeRoute, payload: unknown) {
  const key = await decryptSecret(env, route.keyEncrypted);
  const res = await fetch(route.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "User-Agent": "AgenticPM/1.0" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text().catch(() => "");
  return { ok: res.status === 200, status: res.status, body: text.slice(0, 500) };
}

export async function handleDispatch(env: AppEnv, msg: Message<DispatchMessage>) {
  const run = await env.DB.prepare("SELECT * FROM agent_runs WHERE id = ?").bind(msg.body.runId).first<RunRow>();
  if (!run || run.status !== "queued") {
    msg.ack();
    return;
  }
  const agent = await getMember(env, run.agent_id);
  const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(run.task_id).first<TaskRow>();
  const route = agent.active ? await resolveWake(env, agent) : null;
  if (!task || !agent.active || !route) {
    await env.DB.prepare("UPDATE agent_runs SET status = 'ended', ended_at = ?, last_error = ? WHERE id = ?")
      .bind(nowIso(), "agent or task no longer available", run.id)
      .run();
    msg.ack();
    return;
  }

  // Rate limit per agent.
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM agent_runs WHERE agent_id = ? AND dispatched_at IS NOT NULL AND dispatched_at > ?",
  )
    .bind(agent.id, hourAgo)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= agent.max_runs_per_hour) {
    msg.retry({ delaySeconds: 300 });
    return;
  }

  const ws = await getWorkspace(env, task.workspace_id);
  const parent = agent.created_by
    ? await env.DB.prepare("SELECT id FROM members WHERE id = ? AND kind = 'agent'").bind(agent.created_by).first()
    : null;
  const payload = buildPayload(
    env.PUBLIC_URL,
    run,
    task,
    taskKey(ws, task),
    parent || route.via ? { handle: agent.handle, name: agent.name, description: agent.description } : undefined,
    route.via ? { handle: route.via.handle, name: route.via.name } : undefined,
  );
  // Tell the agent which workspace policies govern this work.
  const pols = await policiesFor(env, ws.id, agent, task);
  if (pols.length) {
    const required = pols.filter((p) => p.required && !p.read_latest);
    Object.assign(payload, { policies: pols });
    payload.instruction +=
      ` Workspace policies apply to this work (listed in "policies"): read them with get_policy and follow them.` +
      (required.length ? ` You must read ${required.map((p) => `"${p.title}"`).join(", ")} before you can change anything.` : "");
  }
  const attempts = run.attempts + 1;
  let result: { ok: boolean; status: number; body: string };
  try {
    result = await postWebhook(env, route, payload);
  } catch (err) {
    result = { ok: false, status: 0, body: err instanceof Error ? err.message : String(err) };
  }

  if (result.ok) {
    await env.DB.prepare("UPDATE agent_runs SET status = 'dispatched', dispatched_at = ?, attempts = ?, last_error = NULL WHERE id = ?")
      .bind(nowIso(), attempts, run.id)
      .run();
    msg.ack();
    await notify(env, ws.id, { type: "thread", task_id: task.id });
    return;
  }

  const error = result.status ? `HTTP ${result.status}: ${result.body}` : result.body;
  if (attempts >= MAX_ATTEMPTS) {
    await env.DB.prepare("UPDATE agent_runs SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?")
      .bind(attempts, error, run.id)
      .run();
    await addSystemEntry(env, task, agent, "run_failed", { run_id: run.id, agent_name: agent.name, error });
    await notify(env, ws.id, { type: "thread", task_id: task.id });
    msg.ack();
  } else {
    await env.DB.prepare("UPDATE agent_runs SET attempts = ?, last_error = ? WHERE id = ?").bind(attempts, error, run.id).run();
    const base = Math.min(Math.max(Number(env.WEBHOOK_RETRY_SECONDS) || 30, 1), 300);
    msg.retry({ delaySeconds: base * attempts });
  }
}

/** Record agent activity on a task: marks its open (or stale) run active. */
export async function touchRun(env: AppEnv, taskId: string, agentId: string) {
  const run = await env.DB.prepare(
    `SELECT * FROM agent_runs WHERE task_id = ? AND agent_id = ? AND status IN ('queued','dispatched','active','stale')
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(taskId, agentId)
    .first<RunRow>();
  if (!run) return null;
  const now = nowIso();
  await env.DB.prepare("UPDATE agent_runs SET status = 'active', last_activity_at = ?, dismissed = 0 WHERE id = ?")
    .bind(now, run.id)
    .run();
  if (run.status !== "active") {
    const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(taskId).first<TaskRow>();
    if (task && task.assignee_id === agentId && (task.status === "backlog" || task.status === "todo")) {
      await env.DB.prepare("UPDATE tasks SET status = 'in_progress', updated_at = ? WHERE id = ?").bind(now, taskId).run();
      const agent = await getMember(env, agentId);
      await addSystemEntry(env, task, agent, "status_changed", { from: task.status, to: "in_progress" });
      await notify(env, task.workspace_id, { type: "task", task_id: taskId });
    }
  }
  return run;
}

/** End the agent's open runs on a task; dispatch a follow-up if triggers arrived mid-run. */
export async function endRunsFor(env: AppEnv, taskId: string, agentId: string, reason: string) {
  const runs = await env.DB.prepare(
    `SELECT * FROM agent_runs WHERE task_id = ? AND agent_id = ? AND status IN ('queued','dispatched','active','stale')`,
  )
    .bind(taskId, agentId)
    .all<RunRow>();
  if (!runs.results.length) return;
  const now = nowIso();
  await env.DB.prepare(
    `UPDATE agent_runs SET status = 'ended', ended_at = ?
     WHERE task_id = ? AND agent_id = ? AND status IN ('queued','dispatched','active','stale')`,
  )
    .bind(now, taskId, agentId)
    .run();
  const hadPending = runs.results.some((r) => r.pending_trigger);
  // No follow-up after a question: the agent is waiting on the answer, and the answer wakes it.
  if (hadPending && reason !== "unassigned" && reason !== "completed" && reason !== "asked_question") {
    const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(taskId).first<TaskRow>();
    const agent = await getMember(env, agentId);
    const last = runs.results[0];
    if (task) await onAgentTrigger(env, { task, agent, trigger: "followup", triggeredBy: last.triggered_by });
  }
}

/** The agent reports its run went wrong (failed or blocked): flag it for humans like a failed dispatch. */
export async function failRunsFor(env: AppEnv, taskId: string, agentId: string, error: string) {
  const runs = await env.DB.prepare(
    `SELECT * FROM agent_runs WHERE task_id = ? AND agent_id = ? AND status IN ('queued','dispatched','active','stale')`,
  )
    .bind(taskId, agentId)
    .all<RunRow>();
  const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(taskId).first<TaskRow>();
  const agent = await getMember(env, agentId);
  const now = nowIso();
  let runId: string;
  if (runs.results.length) {
    runId = runs.results[0].id;
    await env.DB.prepare(
      `UPDATE agent_runs SET status = 'failed', last_error = ?, ended_at = ?, dismissed = 0
       WHERE task_id = ? AND agent_id = ? AND status IN ('queued','dispatched','active','stale')`,
    )
      .bind(error.slice(0, 500), now, taskId, agentId)
      .run();
  } else {
    // No open run (e.g. the agent picked the task up on its own): record one so the problem is visible.
    runId = newId();
    await env.DB.prepare(
      `INSERT INTO agent_runs (id, task_id, agent_id, trigger, status, last_error, created_at, ended_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
      .bind(runId, taskId, agentId, "manual", "failed", error.slice(0, 500), now, now)
      .run();
  }
  if (task) {
    await addSystemEntry(env, task, agent, "run_failed", { run_id: runId, agent_name: agent.name, error, reported_by_agent: true });
    await notify(env, task.workspace_id, { type: "task", task_id: taskId });
  }
}

/** Cron: flag runs that never started working or went quiet. */
export async function sweepStaleRuns(env: AppEnv) {
  const dispatchedCutoff = new Date(Date.now() - STALE_DISPATCHED_MINUTES * 60_000).toISOString();
  const activeCutoff = new Date(Date.now() - STALE_ACTIVE_MINUTES * 60_000).toISOString();
  const stale = await env.DB.prepare(
    `SELECT * FROM agent_runs WHERE
       (status = 'dispatched' AND last_activity_at IS NULL AND dispatched_at < ?)
       OR (status = 'active' AND last_activity_at < ?)`,
  )
    .bind(dispatchedCutoff, activeCutoff)
    .all<RunRow>();
  for (const run of stale.results) {
    await env.DB.prepare("UPDATE agent_runs SET status = 'stale' WHERE id = ?").bind(run.id).run();
    const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(run.task_id).first<TaskRow>();
    const agent = await getMember(env, run.agent_id);
    if (task) {
      await addSystemEntry(env, task, agent, "run_stale", {
        run_id: run.id,
        agent_name: agent.name,
        reason: run.last_activity_at ? "no activity for 60 minutes" : "agent never started after being woken",
      });
      await notify(env, task.workspace_id, { type: "thread", task_id: task.id });
    }
  }
  return stale.results.length;
}

export async function retryRun(env: AppEnv, runId: string, triggeredBy: string) {
  const run = await env.DB.prepare("SELECT * FROM agent_runs WHERE id = ?").bind(runId).first<RunRow>();
  if (!run) return null;
  await env.DB.prepare("UPDATE agent_runs SET dismissed = 1, status = CASE WHEN status IN ('failed','stale') THEN 'ended' ELSE status END WHERE id = ?")
    .bind(runId)
    .run();
  const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(run.task_id).first<TaskRow>();
  const agent = await getMember(env, run.agent_id);
  if (!task) return null;
  return onAgentTrigger(env, { task, agent, trigger: "manual", triggeredBy });
}

export async function testPing(env: AppEnv, agent: MemberRow) {
  const route = await resolveWake(env, agent);
  if (!route) return { ok: false, status: 0, body: "No webhook configured" };
  try {
    return await postWebhook(env, route, {
      event: "test",
      instruction:
        "This is a connection test from Agentic PM. If you have the Agentic PM MCP tools, call list_my_tasks to confirm access. No other action is needed.",
    });
  } catch (err) {
    return { ok: false, status: 0, body: err instanceof Error ? err.message : String(err) };
  }
}
