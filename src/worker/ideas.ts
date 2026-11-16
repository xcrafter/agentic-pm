/**
 * Product ideas: a backlog of feature ideas and concepts that can later become tasks.
 *
 * New ideas are labelled from a fixed set (feature, marketing, …) and given a suggested owner by
 * Workers AI, using people's and agents' descriptions. Labels and owner stay editable; when AI isn't
 * available a keyword match fills in labels instead.
 */
import { Hono } from "hono";
import type { Actor, MemberRow, WorkspaceRow } from "./domain";
import { createTask, logActivity, notify, taskKey } from "./domain";
import { type AppEnv, HttpError, badRequest, forbidden, newId, notFound, nowIso } from "./util";

export const IDEA_LABELS = [
  "feature",
  "improvement",
  "ai",
  "integration",
  "analytics",
  "marketing",
  "sales",
  "content",
  "pricing",
  "operations",
  "research",
  "ux",
] as const;
export type IdeaLabel = (typeof IDEA_LABELS)[number];
export const IDEA_STATUSES = ["new", "exploring", "planned", "converted", "parked"] as const;
export type IdeaStatus = (typeof IDEA_STATUSES)[number];

const LABEL_HELP: Record<IdeaLabel, string> = {
  feature: "a new product capability",
  improvement: "makes an existing product capability better",
  ai: "uses AI / machine learning",
  integration: "connects to another tool or platform (Gmail, Shopify, payments, …)",
  analytics: "reporting, insights, metrics, attribution",
  marketing: "marketing strategy, positioning, campaigns, acquisition, SEO",
  sales: "sales, outreach, partnerships, onboarding customers",
  content: "blogs, social posts, videos, UGC, copy",
  pricing: "pricing, plans, billing, monetisation",
  operations: "internal process, support, compliance, ops",
  research: "needs discovery or validation before building",
  ux: "design, usability, onboarding flow",
};

const KEYWORDS: Record<IdeaLabel, RegExp> = {
  feature: /\b(add|new|build|support|allow|let (merchants|users))\b/i,
  improvement: /\b(improve|better|faster|simplif|rework|cut the noise|polish)\b/i,
  ai: /\b(ai|llm|gpt|machine learning|classif|predict|recommend)\b/i,
  integration: /\b(gmail|outlook|shopify|stripe|slack|zapier|integrat|api|oauth|import|migrat)\b/i,
  analytics: /\b(analytic|report|insight|metric|attribution|roi|dashboard|track)\b/i,
  marketing: /\b(marketing|campaign|seo|positioning|acquisition|brand|launch|growth)\b/i,
  sales: /\b(sales|outreach|prospect|lead|partner|demo|onboard customers?)\b/i,
  content: /\b(content|blog|post|video|ugc|reel|copy)\b/i,
  pricing: /\b(pric|plan|billing|payment|pay|monetis|monetiz|coupon)\b/i,
  operations: /\b(compliance|agreement|legal|support|process|ops)\b/i,
  research: /\b(research|explore|validate|survey|interview|discovery)\b/i,
  ux: /\b(ux|ui|design|usability|onboarding|flow|filter|view)\b/i,
};

interface IdeaRow {
  id: string;
  workspace_id: string;
  title: string;
  body: string;
  labels: string;
  labels_by: string;
  suggested_owner_id: string | null;
  owner_reason: string | null;
  status: IdeaStatus;
  source_url: string | null;
  created_by: string;
  converted_task_id: string | null;
  created_at: string;
  updated_at: string;
}

const cleanLabels = (v: unknown): IdeaLabel[] =>
  Array.isArray(v) ? [...new Set(v.map((x) => String(x).toLowerCase().trim()).filter((x): x is IdeaLabel => (IDEA_LABELS as readonly string[]).includes(x)))] : [];

function keywordLabels(text: string): IdeaLabel[] {
  const hits = IDEA_LABELS.filter((l) => KEYWORDS[l].test(text));
  return hits.length ? hits.slice(0, 3) : ["feature"];
}

/** Ask Workers AI for labels and a suggested owner. Falls back to keywords (no owner) on any failure. */
export async function classifyIdea(env: AppEnv, ws: WorkspaceRow, idea: { title: string; body: string }) {
  const members = await env.DB.prepare("SELECT * FROM members WHERE workspace_id = ? AND active = 1").bind(ws.id).all<MemberRow>();
  const roster = members.results.map((m) => ({
    handle: m.handle,
    who: `${m.name} (${m.kind}${m.role === "admin" ? ", admin" : ""})`,
    does: (m.description ?? "").slice(0, 240) || (m.kind === "human" ? "team member" : "agent"),
  }));
  try {
    if (!env.AI) throw new Error("Workers AI not bound");
    const res = (await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages: [
        {
          role: "system",
          content:
            "You triage product ideas for a small team. Pick 1 to 3 labels that describe the nature of the idea, " +
            "and the single best owner from the team list (by what they do), or null if nobody fits. " +
            "Labels: " +
            IDEA_LABELS.map((l) => `${l} = ${LABEL_HELP[l]}`).join("; ") +
            ". Reply only with JSON.",
        },
        {
          role: "user",
          content: JSON.stringify({ idea: { title: idea.title, details: idea.body.slice(0, 3000) }, team: roster }),
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          type: "object",
          properties: {
            labels: { type: "array", items: { type: "string", enum: [...IDEA_LABELS] } },
            owner: { type: ["string", "null"] },
            reason: { type: "string" },
          },
          required: ["labels", "owner", "reason"],
        },
      },
      max_tokens: 300,
      temperature: 0.2,
    } as never)) as { response?: unknown };
    const out = (typeof res.response === "string" ? JSON.parse(res.response) : res.response) as { labels?: unknown; owner?: unknown; reason?: unknown };
    const labels = cleanLabels(out?.labels).slice(0, 3);
    const handle = typeof out?.owner === "string" ? out.owner.replace(/^@/, "").toLowerCase() : null;
    const owner = handle ? members.results.find((m) => m.handle === handle) : undefined;
    return {
      labels: labels.length ? labels : keywordLabels(`${idea.title} ${idea.body}`),
      labelsBy: (labels.length ? "ai" : "fallback") as "ai" | "fallback",
      ownerId: owner?.id ?? null,
      reason: owner && typeof out?.reason === "string" ? out.reason.slice(0, 300) : null,
    };
  } catch (err) {
    console.warn("idea classification fell back to keywords:", err instanceof Error ? err.message : err);
    return { labels: keywordLabels(`${idea.title} ${idea.body}`), labelsBy: "fallback" as const, ownerId: null, reason: null };
  }
}

async function applyClassification(env: AppEnv, ws: WorkspaceRow, ideaId: string) {
  const idea = await env.DB.prepare("SELECT * FROM ideas WHERE id = ?").bind(ideaId).first<IdeaRow>();
  if (!idea) return;
  const c = await classifyIdea(env, ws, idea);
  await env.DB.prepare(
    "UPDATE ideas SET labels = ?, labels_by = ?, suggested_owner_id = COALESCE(suggested_owner_id, ?), owner_reason = COALESCE(owner_reason, ?), updated_at = ? WHERE id = ?",
  )
    .bind(JSON.stringify(c.labels), c.labelsBy, c.ownerId, c.reason, nowIso(), ideaId)
    .run();
  await notify(env, ws.id, { type: "ideas" });
}

export interface NewIdea {
  title: string;
  body?: string;
  labels?: string[];
  ownerRef?: string | null;
  sourceUrl?: string | null;
}

/**
 * Create an idea. With labels given (e.g. by an agent) they're kept; otherwise classification runs in
 * the background (`defer`) or inline.
 */
export async function createIdea(env: AppEnv, ws: WorkspaceRow, actor: Actor, input: NewIdea, defer?: (p: Promise<unknown>) => void) {
  const title = input.title?.trim();
  if (!title) throw badRequest("Give the idea a title");
  if (title.length > 200) throw badRequest("Keep the title under 200 characters");
  const body = (input.body ?? "").trim().slice(0, 10000);
  let source: string | null = null;
  if (input.sourceUrl) {
    try {
      const u = new URL(input.sourceUrl);
      if (!/^https?:$/.test(u.protocol)) throw new Error();
      source = u.toString();
    } catch {
      throw badRequest("Source must be an http(s) URL");
    }
  }
  let ownerId: string | null = null;
  if (input.ownerRef) {
    const h = input.ownerRef.replace(/^@/, "").toLowerCase();
    const m = await env.DB.prepare("SELECT id FROM members WHERE workspace_id = ? AND active = 1 AND (id = ? OR handle = ?)")
      .bind(ws.id, input.ownerRef, h)
      .first<{ id: string }>();
    if (!m) throw badRequest(`No member "${input.ownerRef}"`);
    ownerId = m.id;
  }
  const given = cleanLabels(input.labels);
  const now = nowIso();
  const id = newId();
  await env.DB.prepare(
    `INSERT INTO ideas (id, workspace_id, title, body, labels, labels_by, suggested_owner_id, status, source_url, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(id, ws.id, title, body, JSON.stringify(given), given.length ? (actor.member.kind === "agent" ? "agent" : "human") : "pending", ownerId, "new", source, actor.member.id, now, now)
    .run();
  await logActivity(env, ws.id, actor, "idea", id, "created", undefined, { title });
  if (!given.length || !ownerId) {
    const job = given.length
      ? // Labels given, owner missing: only suggest an owner.
        classifyIdea(env, ws, { title, body }).then(async (c) => {
          if (c.ownerId)
            await env.DB.prepare("UPDATE ideas SET suggested_owner_id = COALESCE(suggested_owner_id, ?), owner_reason = COALESCE(owner_reason, ?) WHERE id = ?")
              .bind(c.ownerId, c.reason, id)
              .run();
          await notify(env, ws.id, { type: "ideas" });
        })
      : applyClassification(env, ws, id);
    if (defer) defer(job.catch((e) => console.error("classify failed", e)));
    else await job;
  }
  await notify(env, ws.id, { type: "ideas" });
  return getIdea(env, ws, id);
}

type RequestRow = { id: string; idea_id: string; customer_id: string; customer_name: string; plan: string | null; mrr: number | null; note: string; requested_at: string; added_by: string };

async function requestsFor(env: AppEnv, ws: WorkspaceRow, ideaId?: string) {
  const rows = await env.DB.prepare(
    `SELECT r.id, r.idea_id, r.customer_id, c.name AS customer_name, c.plan, c.mrr, r.note, r.requested_at, r.added_by
     FROM idea_requests r JOIN customers c ON c.id = r.customer_id
     WHERE c.workspace_id = ? ${ideaId ? "AND r.idea_id = ?" : ""} ORDER BY r.requested_at DESC, r.created_at DESC`,
  )
    .bind(...(ideaId ? [ws.id, ideaId] : [ws.id]))
    .all<RequestRow>();
  const by = new Map<string, RequestRow[]>();
  for (const r of rows.results) by.set(r.idea_id, [...(by.get(r.idea_id) ?? []), r]);
  return by;
}

const requestSummary = (reqs: RequestRow[] = []) => ({
  request_count: reqs.length,
  request_mrr: Math.round(reqs.reduce((n, r) => n + (r.mrr ?? 0), 0) * 100) / 100,
  requested_by: reqs.map((r) => ({ id: r.customer_id, name: r.customer_name })),
  last_requested_at: reqs[0]?.requested_at ?? null,
});

export async function getIdea(env: AppEnv, ws: WorkspaceRow, id: string) {
  const r = await env.DB.prepare(
    `SELECT i.*, t.number AS task_number, t.status AS task_status FROM ideas i LEFT JOIN tasks t ON t.id = i.converted_task_id
     WHERE i.id = ? AND i.workspace_id = ?`,
  )
    .bind(id, ws.id)
    .first<IdeaRow & { task_number: number | null; task_status: string | null }>();
  if (!r) throw notFound("Idea");
  const reqs = (await requestsFor(env, ws, id)).get(id) ?? [];
  return { ...ideaOut(ws, r), ...requestSummary(reqs), requests: reqs };
}

function ideaOut(ws: WorkspaceRow, r: IdeaRow & { task_number: number | null; task_status: string | null }) {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    labels: cleanLabels(JSON.parse(r.labels || "[]")),
    labels_by: r.labels_by,
    suggested_owner_id: r.suggested_owner_id,
    owner_reason: r.owner_reason,
    status: r.status,
    source_url: r.source_url,
    created_by: r.created_by,
    task: r.converted_task_id && r.task_number != null ? { id: r.converted_task_id, key: `${ws.key_prefix}-${r.task_number}`, status: r.task_status } : null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export async function listIdeas(env: AppEnv, ws: WorkspaceRow) {
  const rows = await env.DB.prepare(
    `SELECT i.*, t.number AS task_number, t.status AS task_status FROM ideas i LEFT JOIN tasks t ON t.id = i.converted_task_id
     WHERE i.workspace_id = ? ORDER BY i.created_at DESC LIMIT 1000`,
  )
    .bind(ws.id)
    .all<IdeaRow & { task_number: number | null; task_status: string | null }>();
  const reqs = await requestsFor(env, ws);
  return rows.results.map((r) => ({ ...ideaOut(ws, r), ...requestSummary(reqs.get(r.id)) }));
}

/** Turn an idea into a task (optionally assigned to the suggested owner, which wakes an agent). */
export async function convertIdea(env: AppEnv, ws: WorkspaceRow, actor: Actor, id: string, opts: { assign?: boolean; projectId?: string | null }) {
  const idea = await env.DB.prepare("SELECT * FROM ideas WHERE id = ? AND workspace_id = ?").bind(id, ws.id).first<IdeaRow>();
  if (!idea) throw notFound("Idea");
  if (idea.converted_task_id) throw new HttpError(409, "This idea is already a task");
  const reqs = (await requestsFor(env, ws, id)).get(id) ?? [];
  const asked = reqs.length
    ? `**Requested by ${reqs.length} customer${reqs.length > 1 ? "s" : ""}:**\n` +
      reqs.map((r) => `- ${r.customer_name}${r.plan ? ` (${r.plan})` : ""}${r.note ? `: “${r.note.replace(/\s+/g, " ").slice(0, 200)}”` : ""}`).join("\n")
    : "";
  const description = [idea.body, asked, idea.source_url ? `Source: ${idea.source_url}` : "", "_Created from a product idea._"].filter(Boolean).join("\n\n");
  const task = await createTask(env, ws, actor, {
    title: idea.title,
    description,
    assigneeId: opts.assign ? idea.suggested_owner_id : null,
    projectId: opts.projectId ?? null,
  });
  await env.DB.prepare("UPDATE ideas SET status = 'converted', converted_task_id = ?, updated_at = ? WHERE id = ?").bind(task.id, nowIso(), id).run();
  await logActivity(env, ws.id, actor, "idea", id, "converted", undefined, { task: taskKey(ws, task) });
  await notify(env, ws.id, { type: "ideas" });
  return { task_key: taskKey(ws, task), idea: await getIdea(env, ws, id) };
}

// ---------- HTTP (signed-in people) ----------

type Vars = { me: MemberRow; ws: WorkspaceRow; actor: Actor };
export const ideaRoutes = new Hono<{ Bindings: AppEnv; Variables: Vars }>();

ideaRoutes.get("/api/ideas", async (c) => c.json({ labels: IDEA_LABELS, ideas: await listIdeas(c.env, c.get("ws")) }));

ideaRoutes.get("/api/ideas/:id", async (c) => c.json(await getIdea(c.env, c.get("ws"), c.req.param("id"))));

ideaRoutes.post("/api/ideas", async (c) => {
  const b = await c.req.json<{ title?: string; body?: string; labels?: string[]; owner?: string | null; source_url?: string | null }>();
  const idea = await createIdea(
    c.env,
    c.get("ws"),
    c.get("actor"),
    { title: b.title ?? "", body: b.body, labels: b.labels, ownerRef: b.owner, sourceUrl: b.source_url },
    (p) => c.executionCtx.waitUntil(p),
  );
  return c.json(idea, 201);
});

ideaRoutes.patch("/api/ideas/:id", async (c) => {
  const ws = c.get("ws");
  const id = c.req.param("id");
  await getIdea(c.env, ws, id);
  const b = await c.req.json<{ title?: string; body?: string; labels?: string[]; suggested_owner_id?: string | null; status?: IdeaStatus }>();
  const sets: string[] = [];
  const binds: unknown[] = [];
  const set = (col: string, v: unknown) => (sets.push(`${col} = ?`), binds.push(v));
  if (b.title !== undefined) {
    if (!b.title.trim() || b.title.length > 200) throw badRequest("Title must be 1–200 characters");
    set("title", b.title.trim());
  }
  if (b.body !== undefined) set("body", b.body.slice(0, 10000));
  if (b.labels !== undefined) (set("labels", JSON.stringify(cleanLabels(b.labels))), set("labels_by", "human"));
  if (b.suggested_owner_id !== undefined) {
    if (b.suggested_owner_id) {
      const m = await c.env.DB.prepare("SELECT id FROM members WHERE id = ? AND workspace_id = ?").bind(b.suggested_owner_id, ws.id).first();
      if (!m) throw badRequest("Unknown member");
    }
    set("suggested_owner_id", b.suggested_owner_id || null);
    set("owner_reason", null);
  }
  if (b.status !== undefined) {
    if (!IDEA_STATUSES.includes(b.status) || b.status === "converted") throw badRequest("Use Convert to task to convert an idea");
    set("status", b.status);
  }
  if (sets.length) {
    set("updated_at", nowIso());
    await c.env.DB.prepare(`UPDATE ideas SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id).run();
    await notify(c.env, ws.id, { type: "ideas" });
  }
  return c.json(await getIdea(c.env, ws, id));
});

ideaRoutes.post("/api/ideas/:id/relabel", async (c) => {
  const ws = c.get("ws");
  const id = c.req.param("id");
  await getIdea(c.env, ws, id);
  await c.env.DB.prepare("UPDATE ideas SET suggested_owner_id = NULL, owner_reason = NULL, labels_by = 'pending' WHERE id = ?").bind(id).run();
  await applyClassification(c.env, ws, id);
  return c.json(await getIdea(c.env, ws, id));
});

ideaRoutes.post("/api/ideas/:id/convert", async (c) => {
  const b = await c.req.json<{ assign?: boolean; project_id?: string | null }>().catch(() => ({}) as { assign?: boolean; project_id?: string | null });
  return c.json(await convertIdea(c.env, c.get("ws"), c.get("actor"), c.req.param("id"), { assign: !!b.assign, projectId: b.project_id }));
});

ideaRoutes.delete("/api/ideas/:id", async (c) => {
  const me = c.get("me");
  const ws = c.get("ws");
  const idea = await c.env.DB.prepare("SELECT * FROM ideas WHERE id = ? AND workspace_id = ?").bind(c.req.param("id"), ws.id).first<IdeaRow>();
  if (!idea) throw notFound("Idea");
  if (me.role !== "admin" && idea.created_by !== me.id) throw forbidden("Only admins or whoever added this idea can delete it");
  await c.env.DB.prepare("DELETE FROM ideas WHERE id = ?").bind(idea.id).run();
  await logActivity(c.env, ws.id, c.get("actor"), "idea", idea.id, "deleted", { title: idea.title, body: idea.body });
  await notify(c.env, ws.id, { type: "ideas" });
  return c.json({ ok: true });
});
