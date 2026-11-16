/**
 * Tools directory: useful tools the team finds online. Paste a website; we read it and write a first summary
 * and tags with Workers AI straight away, then (when a PM agent is set up) ask that agent — Grok — to research
 * it properly. The agent writes back with update_tool.
 */
import { Hono } from "hono";
import type { Actor, MemberRow, WorkspaceRow } from "./domain";
import { createTask, logActivity, notify, taskKey } from "./domain";
import { type AppEnv, HttpError, badRequest, forbidden, newId, notFound, nowIso, parseJson } from "./util";
import { readCapped } from "./workspace";

type Vars = { me: MemberRow; ws: WorkspaceRow; actor: Actor };
type EnrichedBy = "pending" | "ai" | "agent" | "human" | "failed";

export interface ToolRow {
  id: string;
  workspace_id: string;
  url: string;
  domain: string;
  name: string;
  summary: string;
  notes: string;
  tags: string;
  category: string | null;
  pricing: string | null;
  icon_url: string | null;
  enriched_by: EnrichedBy;
  research_task_id: string | null;
  pinned_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

const MAX_HTML = 1_500_000;

export function normalizeUrl(raw: string) {
  let s = raw.trim();
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw badRequest("Enter a valid website, e.g. linear.app");
  }
  if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) throw badRequest("Enter a valid website, e.g. linear.app");
  u.hash = "";
  for (const k of [...u.searchParams.keys()]) if (/^(utm_|ref$|fbclid|gclid)/i.test(k)) u.searchParams.delete(k);
  const path = u.pathname.replace(/\/+$/, "");
  return { url: `${u.protocol}//${u.host.replace(/^www\./, "")}${path}${u.search}`, domain: u.hostname.replace(/^www\./, ""), origin: u.origin };
}

export function cleanTags(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  return [
    ...new Set(
      arr
        .map((x) => String(x).toLowerCase().trim().replace(/^#/, "").replace(/[^a-z0-9+.& -]/g, "").replace(/\s+/g, "-").slice(0, 30))
        .filter(Boolean),
    ),
  ].slice(0, 10);
}

/** Read the page: title, description, icon and a sample of visible text. */
async function readSite(url: string) {
  const out = { title: "", description: "", icon: "" as string, text: "" };
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; AgenticPM/1.0)", Accept: "text/html" },
    redirect: "follow",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`The site answered ${res.status}`);
  if (!(res.headers.get("content-type") || "").includes("html")) throw new Error("The link isn't a web page");
  const base = res.url || url;
  const html = new TextDecoder().decode(await readCapped(res, MAX_HTML).catch(() => new Uint8Array()));
  let ogTitle = "";
  let ogDesc = "";
  let iconScore = -1;
  const textParts: string[] = [];
  let skip = 0;
  await new HTMLRewriter()
    .on("title", { text: (t) => void (out.title += t.text) })
    .on('meta[name="description"]', { element: (el) => void (out.description ||= el.getAttribute("content") ?? "") })
    .on('meta[property="og:title"]', { element: (el) => void (ogTitle ||= el.getAttribute("content") ?? "") })
    .on('meta[property="og:description"]', { element: (el) => void (ogDesc ||= el.getAttribute("content") ?? "") })
    .on("link[rel][href]", {
      element(el) {
        const rel = (el.getAttribute("rel") || "").toLowerCase();
        const href = el.getAttribute("href") || "";
        if (!href || href.startsWith("data:")) return;
        const score = rel.includes("apple-touch-icon") ? 3 : rel.split(/\s+/).includes("icon") ? (href.endsWith(".svg") ? 2 : 1) : -1;
        if (score > iconScore) {
          iconScore = score;
          try {
            out.icon = new URL(href, base).toString();
          } catch {}
        }
      },
    })
    .on("script, style, noscript, svg, nav, footer", {
      element(el) {
        skip++;
        el.onEndTag(() => void skip--);
      },
    })
    .on("h1, h2, h3, p, li", {
      text(t) {
        if (!skip && textParts.join(" ").length < 6000) textParts.push(t.text);
      },
    })
    .transform(new Response(html))
    .text();
  out.title = (ogTitle || out.title).replace(/\s+/g, " ").trim().slice(0, 200);
  out.description = (ogDesc || out.description).replace(/\s+/g, " ").trim().slice(0, 600);
  out.text = textParts.join(" ").replace(/\s+/g, " ").trim().slice(0, 5000);
  if (!out.icon) out.icon = `${new URL(base).origin}/favicon.ico`;
  return out;
}

async function aiSummary(env: AppEnv, url: string, site: { title: string; description: string; text: string }) {
  if (!env.AI) throw new Error("Workers AI not bound");
  const res = (await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
    messages: [
      {
        role: "system",
        content:
          "You catalogue software tools for a small product team. From the website content, give the product's name, " +
          "a plain 1–2 sentence summary of what it does and who it's for (no marketing language), 3–6 short lowercase tags " +
          "(what it does, e.g. analytics, email, ai-agents, design, crm, no-code), one broad category, and pricing if stated " +
          "(e.g. 'Free', 'Freemium', 'From $20/mo', 'Open source', or null). Reply only with JSON.",
      },
      { role: "user", content: JSON.stringify({ url, title: site.title, description: site.description, page_text: site.text.slice(0, 4000) }) },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        type: "object",
        properties: {
          name: { type: "string" },
          summary: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          category: { type: "string" },
          pricing: { type: ["string", "null"] },
        },
        required: ["name", "summary", "tags", "category"],
      },
    },
    max_tokens: 400,
    temperature: 0.2,
  } as never)) as { response?: unknown };
  const o = (typeof res.response === "string" ? JSON.parse(res.response) : res.response) as Record<string, unknown>;
  return {
    name: typeof o?.name === "string" ? o.name.trim().slice(0, 80) : "",
    summary: typeof o?.summary === "string" ? o.summary.trim().slice(0, 600) : "",
    tags: cleanTags(o?.tags).slice(0, 6),
    category: typeof o?.category === "string" ? o.category.trim().slice(0, 40) : null,
    pricing: typeof o?.pricing === "string" && o.pricing.trim() ? o.pricing.trim().slice(0, 60) : null,
  };
}

/** First pass: read the site and fill in what we can. Never overwrites what a person or agent wrote. */
export async function quickEnrich(env: AppEnv, wsId: string, id: string) {
  const t = await env.DB.prepare("SELECT * FROM tools WHERE id = ?").bind(id).first<ToolRow>();
  if (!t) return;
  let site: Awaited<ReturnType<typeof readSite>>;
  try {
    site = await readSite(t.url);
  } catch (err) {
    if (t.enriched_by === "pending") {
      await env.DB.prepare("UPDATE tools SET enriched_by = 'failed', notes = CASE WHEN notes = '' THEN ? ELSE notes END, updated_at = ? WHERE id = ?")
        .bind(`Couldn't read the site: ${err instanceof Error ? err.message : String(err)}`, nowIso(), id)
        .run();
      await notify(env, wsId, { type: "tools" });
    }
    return;
  }
  let ai: Awaited<ReturnType<typeof aiSummary>> | null = null;
  try {
    ai = await aiSummary(env, t.url, site);
  } catch (err) {
    console.error("tool summary failed", err);
  }
  const fresh = await env.DB.prepare("SELECT enriched_by FROM tools WHERE id = ?").bind(id).first<{ enriched_by: EnrichedBy }>();
  if (!fresh) return;
  const locked = fresh.enriched_by === "agent" || fresh.enriched_by === "human";
  if (locked) {
    await env.DB.prepare("UPDATE tools SET icon_url = COALESCE(icon_url, ?) WHERE id = ?").bind(site.icon, id).run();
  } else {
    await env.DB.prepare(
      "UPDATE tools SET name = ?, summary = ?, tags = ?, category = ?, pricing = ?, icon_url = ?, enriched_by = ?, updated_at = ? WHERE id = ?",
    )
      .bind(
        ai?.name || site.title.split(/[|–—-]/)[0].trim() || t.name,
        ai?.summary || site.description || "",
        JSON.stringify(ai?.tags?.length ? ai.tags : []),
        ai?.category ?? null,
        ai?.pricing ?? null,
        site.icon,
        ai ? "ai" : site.description ? "ai" : "failed",
        nowIso(),
        id,
      )
      .run();
  }
  await notify(env, wsId, { type: "tools" });
}

/** Ask the workspace PM agent (Grok) to research the tool properly; it writes back with update_tool. */
export async function requestResearch(env: AppEnv, ws: WorkspaceRow, actor: Actor, t: ToolRow) {
  if (!ws.pm_agent_id) throw badRequest("Pick a PM agent in Workspace settings first; it does the research");
  const pm = await env.DB.prepare("SELECT * FROM members WHERE id = ? AND kind = 'agent' AND active = 1").bind(ws.pm_agent_id).first<MemberRow>();
  if (!pm) throw badRequest("The workspace PM agent is inactive");
  if (t.research_task_id) {
    const open = await env.DB.prepare("SELECT status FROM tasks WHERE id = ?").bind(t.research_task_id).first<{ status: string }>();
    if (open && !["done", "canceled"].includes(open.status)) throw new HttpError(409, "Research is already in progress for this tool");
  }
  const task = await createTask(env, ws, actor, {
    title: `Research tool: ${t.name}`,
    assigneeId: pm.id,
    priority: "low",
    description: [
      `Research this tool for the team's Tools directory: ${t.url}`,
      "",
      "1. Visit the website (and its pricing/docs pages if useful).",
      `2. Call \`update_tool\` with tool \`${t.id}\` and: a plain 1–2 sentence **summary** of what it does and who it's for, ` +
        "3–6 lowercase **tags**, a **category**, **pricing** (e.g. Free, Freemium, From $20/mo, Open source), and short **notes** " +
        "(standout features, alternatives, how a small product team might use it).",
      "3. Complete this task with a one-line summary.",
      "",
      "_Created from the Tools directory._",
    ].join("\n"),
  });
  await env.DB.prepare("UPDATE tools SET research_task_id = ?, updated_at = ? WHERE id = ?").bind(task.id, nowIso(), t.id).run();
  await notify(env, ws.id, { type: "tools" });
  return task;
}

export function toolOut(ws: WorkspaceRow, t: ToolRow & { task_number?: number | null; task_status?: string | null }) {
  return {
    id: t.id,
    url: t.url,
    domain: t.domain,
    name: t.name,
    summary: t.summary,
    notes: t.notes,
    tags: parseJson<string[]>(t.tags, []),
    category: t.category,
    pricing: t.pricing,
    icon_url: t.icon_url,
    enriched_by: t.enriched_by,
    pinned_at: t.pinned_at,
    research_task:
      t.research_task_id && t.task_number != null ? { key: `${ws.key_prefix}-${t.task_number}`, status: t.task_status ?? null } : null,
    created_by: t.created_by,
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
}

export async function listTools(env: AppEnv, ws: WorkspaceRow) {
  const rows = await env.DB.prepare(
    `SELECT tl.*, t.number AS task_number, t.status AS task_status FROM tools tl LEFT JOIN tasks t ON t.id = tl.research_task_id
     WHERE tl.workspace_id = ? ORDER BY (tl.pinned_at IS NULL), tl.created_at DESC LIMIT 2000`,
  )
    .bind(ws.id)
    .all<ToolRow & { task_number: number | null; task_status: string | null }>();
  return rows.results.map((r) => toolOut(ws, r));
}

export async function getTool(env: AppEnv, ws: WorkspaceRow, ref: string) {
  let t = await env.DB.prepare(
    `SELECT tl.*, t.number AS task_number, t.status AS task_status FROM tools tl LEFT JOIN tasks t ON t.id = tl.research_task_id
     WHERE tl.workspace_id = ? AND tl.id = ?`,
  )
    .bind(ws.id, ref)
    .first<ToolRow & { task_number: number | null; task_status: string | null }>();
  if (!t && /[./]/.test(ref)) {
    const { url } = normalizeUrl(ref);
    t = await env.DB.prepare(
      `SELECT tl.*, t.number AS task_number, t.status AS task_status FROM tools tl LEFT JOIN tasks t ON t.id = tl.research_task_id
       WHERE tl.workspace_id = ? AND tl.url = ?`,
    )
      .bind(ws.id, url)
      .first<ToolRow & { task_number: number | null; task_status: string | null }>();
  }
  if (!t) throw notFound("Tool");
  return t;
}

export async function addTool(
  env: AppEnv,
  ws: WorkspaceRow,
  actor: Actor,
  input: { url: string; notes?: string; research?: boolean },
  defer: (p: Promise<unknown>) => void,
) {
  const { url, domain } = normalizeUrl(input.url);
  const other = url.startsWith("https://") ? url.replace(/^https:/, "http:") : url.replace(/^http:/, "https:");
  const dup = await env.DB.prepare("SELECT id FROM tools WHERE workspace_id = ? AND url IN (?, ?)").bind(ws.id, url, other).first<{ id: string }>();
  if (dup) throw new HttpError(409, "This tool is already in the directory");
  const id = newId();
  const now = nowIso();
  const name = domain.split(".").slice(-2, -1)[0] ?? domain;
  await env.DB.prepare(
    "INSERT INTO tools (id, workspace_id, url, domain, name, notes, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
  )
    .bind(id, ws.id, url, domain, name.charAt(0).toUpperCase() + name.slice(1), (input.notes ?? "").slice(0, 5000), actor.member.id, now, now)
    .run();
  await logActivity(env, ws.id, actor, "tool", id, "created", undefined, { url });
  await notify(env, ws.id, { type: "tools" });
  const t = (await getTool(env, ws, id)) as ToolRow;
  // Agents adding a tool are doing the research themselves; people get Grok's help when a PM is set up.
  defer(
    (async () => {
      await quickEnrich(env, ws.id, id);
      if (input.research && actor.member.kind === "human" && ws.pm_agent_id) {
        const fresh = (await env.DB.prepare("SELECT * FROM tools WHERE id = ?").bind(id).first<ToolRow>())!;
        await requestResearch(env, ws, actor, fresh).catch((e) => console.error("research request failed", e));
      }
    })(),
  );
  return toolOut(ws, t);
}

export async function updateTool(env: AppEnv, ws: WorkspaceRow, actor: Actor, id: string, b: Record<string, unknown>) {
  const t = (await getTool(env, ws, id)) as ToolRow;
  const next = { ...t };
  if (typeof b.name === "string" && b.name.trim()) next.name = b.name.trim().slice(0, 80);
  if (typeof b.summary === "string") next.summary = b.summary.trim().slice(0, 600);
  if (typeof b.notes === "string") next.notes = b.notes.slice(0, 10_000);
  if (b.tags !== undefined) next.tags = JSON.stringify(cleanTags(b.tags));
  if (b.category !== undefined) next.category = typeof b.category === "string" && b.category.trim() ? b.category.trim().slice(0, 40) : null;
  if (b.pricing !== undefined) next.pricing = typeof b.pricing === "string" && b.pricing.trim() ? b.pricing.trim().slice(0, 60) : null;
  if (b.pinned !== undefined) next.pinned_at = b.pinned ? (t.pinned_at ?? nowIso()) : null;
  const content = ["name", "summary", "notes", "tags", "category", "pricing"].some((k) => b[k] !== undefined);
  if (content) next.enriched_by = actor.member.kind === "agent" ? "agent" : "human";
  await env.DB.prepare(
    "UPDATE tools SET name = ?, summary = ?, notes = ?, tags = ?, category = ?, pricing = ?, pinned_at = ?, enriched_by = ?, updated_at = ? WHERE id = ?",
  )
    .bind(next.name, next.summary, next.notes, next.tags, next.category, next.pricing, next.pinned_at, next.enriched_by, nowIso(), t.id)
    .run();
  if (content) await logActivity(env, ws.id, actor, "tool", t.id, "updated", undefined, { by: next.enriched_by });
  await notify(env, ws.id, { type: "tools" });
  return toolOut(ws, (await getTool(env, ws, t.id)) as ToolRow);
}

// ---------- Routes ----------

export const toolRoutes = new Hono<{ Bindings: AppEnv; Variables: Vars }>();

toolRoutes.get("/api/tools", async (c) => c.json(await listTools(c.env, c.get("ws"))));

toolRoutes.post("/api/tools", async (c) => {
  const b = await c.req.json<{ url?: string; notes?: string; research?: boolean }>();
  if (!b.url?.trim()) throw badRequest("Paste the tool's website");
  return c.json(
    await addTool(c.env, c.get("ws"), c.get("actor"), { url: b.url, notes: b.notes, research: b.research !== false }, (p) => c.executionCtx.waitUntil(p)),
    201,
  );
});

toolRoutes.patch("/api/tools/:id", async (c) => c.json(await updateTool(c.env, c.get("ws"), c.get("actor"), c.req.param("id"), await c.req.json())));

toolRoutes.post("/api/tools/:id/refresh", async (c) => {
  const ws = c.get("ws");
  const t = (await getTool(c.env, ws, c.req.param("id"))) as ToolRow;
  await c.env.DB.prepare("UPDATE tools SET enriched_by = 'pending' WHERE id = ?").bind(t.id).run();
  await quickEnrich(c.env, ws.id, t.id);
  return c.json(toolOut(ws, (await getTool(c.env, ws, t.id)) as ToolRow));
});

toolRoutes.post("/api/tools/:id/research", async (c) => {
  const ws = c.get("ws");
  const t = (await getTool(c.env, ws, c.req.param("id"))) as ToolRow;
  const task = await requestResearch(c.env, ws, c.get("actor"), t);
  return c.json({ task_key: taskKey(ws, task) });
});

toolRoutes.delete("/api/tools/:id", async (c) => {
  const ws = c.get("ws");
  const me = c.get("me");
  const t = (await getTool(c.env, ws, c.req.param("id"))) as ToolRow;
  if (me.role !== "admin" && t.created_by !== me.id) throw forbidden("Only admins or whoever added this tool can delete it");
  await c.env.DB.prepare("DELETE FROM tools WHERE id = ?").bind(t.id).run();
  await logActivity(c.env, ws.id, c.get("actor"), "tool", t.id, "deleted", { url: t.url, name: t.name, summary: t.summary });
  await notify(c.env, ws.id, { type: "tools" });
  return c.json({ ok: true });
});

