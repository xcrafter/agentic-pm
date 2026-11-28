/**
 * Public share links for a task.
 *
 * A share link lets you hand a task to something outside the workspace — Claude, ChatGPT, Cursor, a
 * contractor — without an account. The link serves the whole task (description, checklists, notes,
 * files, thread) as Markdown for AI tools and as a readable page for people.
 *
 * "reply" links also accept POST {url}/messages so the outside tool can report back; those messages land
 * in the task thread as the "External" member, tagged with the link's label. External messages never
 * wake agents (canWake rejects them) and can't change task fields.
 */
import { Hono } from "hono";
import type { Actor, MemberRow, TaskRow, WorkspaceRow } from "./domain";
import { getTaskByRef, getTaskDetail, getWorkspace, logActivity, notify, postEntry, serializeTasks, taskKey } from "./domain";
import { type AppEnv, HttpError, badRequest, forbidden, newId, notFound, nowIso, randomToken, signValue } from "./util";

type Vars = { me: MemberRow; ws: WorkspaceRow; actor: Actor };

export interface ShareRow {
  id: string;
  workspace_id: string;
  task_id: string;
  token: string;
  mode: "read" | "reply";
  label: string;
  created_by: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  use_count: number;
}

const MAX_POSTS_PER_HOUR = 30;
const MAX_BODY = 20_000;

const base = (env: AppEnv) => env.PUBLIC_URL.replace(/\/$/, "");
export const shareUrl = (env: AppEnv, s: Pick<ShareRow, "token">) => `${base(env)}/share/${s.token}`;

function serializeShare(env: AppEnv, s: ShareRow) {
  const expired = !!s.expires_at && s.expires_at < nowIso();
  return {
    id: s.id,
    url: shareUrl(env, s),
    markdown_url: `${shareUrl(env, s)}.md`,
    mode: s.mode,
    label: s.label,
    created_by: s.created_by,
    created_at: s.created_at,
    expires_at: s.expires_at,
    revoked_at: s.revoked_at,
    last_used_at: s.last_used_at,
    use_count: s.use_count,
    active: !s.revoked_at && !expired,
  };
}

async function findShare(env: AppEnv, token: string): Promise<{ share: ShareRow; task: TaskRow; ws: WorkspaceRow }> {
  const share = await env.DB.prepare("SELECT * FROM task_shares WHERE token = ?").bind(token).first<ShareRow>();
  if (!share || share.revoked_at || (share.expires_at && share.expires_at < nowIso())) {
    throw new HttpError(404, "This share link has expired or was turned off.");
  }
  const task = await env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(share.task_id).first<TaskRow>();
  if (!task) throw new HttpError(404, "This task no longer exists.");
  const ws = await getWorkspace(env, share.workspace_id);
  return { share, task, ws };
}

/** The member that external (share-link) messages are posted as. Inactive, so it never gets work. */
async function externalMember(env: AppEnv, ws: WorkspaceRow, createdBy: string): Promise<MemberRow> {
  const id = `external-${ws.id}`;
  const existing = await env.DB.prepare("SELECT * FROM members WHERE id = ?").bind(id).first<MemberRow>();
  if (existing) return existing;
  let handle = "external";
  for (let i = 2; await env.DB.prepare("SELECT 1 FROM members WHERE workspace_id = ? AND handle = ?").bind(ws.id, handle).first(); i++) {
    handle = `external${i}`;
  }
  await env.DB.prepare(
    `INSERT OR IGNORE INTO members (id, workspace_id, kind, name, handle, role, active, description, wake_on_mention, max_runs_per_hour, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(id, ws.id, "agent", "External", handle, "member", 0, "Messages posted through public task share links.", 0, 0, createdBy, nowIso())
    .run();
  return (await env.DB.prepare("SELECT * FROM members WHERE id = ?").bind(id).first<MemberRow>())!;
}

// ---------- Rendering ----------

const STATUS_LABEL: Record<string, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In progress",
  waiting_on_human: "Waiting on human",
  done: "Done",
  canceled: "Canceled",
};

function fmtSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const day = (iso: string) => iso.slice(0, 16).replace("T", " ") + " UTC";

export async function renderShareMarkdown(env: AppEnv, share: ShareRow, task: TaskRow, ws: WorkspaceRow) {
  const d = await getTaskDetail(env, ws, task);
  const t = d.task;
  const members = await env.DB.prepare("SELECT id, name, handle, kind FROM members WHERE workspace_id = ?")
    .bind(ws.id)
    .all<{ id: string; name: string; handle: string; kind: string }>();
  const who = new Map(members.results.map((m) => [m.id, m]));
  const name = (id: string | null | undefined) => (id ? (who.get(id)?.name ?? "Someone") : "Someone");
  const url = shareUrl(env, share);

  const out: string[] = [];
  out.push(`# ${t.key}: ${t.title}`, "");
  const meta = [
    `**Status:** ${t.status_name}`,
    t.priority !== "none" ? `**Priority:** ${t.priority}` : "",
    t.assignee ? `**Assignee:** ${t.assignee.name}` : "",
    t.project ? `**Project:** ${t.project.name}` : "",
    t.due_date ? `**Due:** ${t.due_date}` : "",
  ].filter(Boolean);
  out.push(meta.join("  \n"), "");
  out.push(
    `> Shared from the ${ws.name} task tracker${share.label ? ` for ${share.label}` : ""}. ` +
      (share.mode === "reply" ? "You can read this task and post messages back to it (see the end)." : "This link is read-only.") +
      (share.expires_at ? ` The link expires ${day(share.expires_at)}.` : ""),
    "",
  );

  out.push("## Description", "", t.description.trim() || "_No description._", "");

  const deps = d.dependencies;
  if (deps.blocked_by.length || deps.blocking.length) {
    out.push("## Dependencies", "");
    const line = (x: { key: string; title: string; status: string }) => `- ${x.key}: ${x.title} (${STATUS_LABEL[x.status] ?? x.status})`;
    if (deps.blocked_by.length) {
      out.push(deps.open_blockers ? `Blocked by (${deps.open_blockers} not done yet):` : "Blocked by (all done):", ...deps.blocked_by.map(line), "");
    }
    if (deps.blocking.length) out.push("Blocks:", ...deps.blocking.map(line), "");
  }

  if (d.checklists.length) {
    out.push("## Checklists", "");
    for (const c of d.checklists as unknown as Array<{ title: string; items: Array<{ text: string; done: number }> }>) {
      out.push(`### ${c.title}`, "");
      for (const i of c.items) out.push(`- [${i.done ? "x" : " "}] ${i.text}`);
      out.push("");
    }
  }

  if (d.notes.length) {
    out.push("## Notes", "");
    for (const n of d.notes as Array<{ title: string; content: string }>) {
      out.push(`### ${n.title}`, "", n.content.trim() || "_Empty._", "");
    }
  }

  if (d.attachments.length) {
    // Signed links valid for a week (or until the share expires, if sooner).
    const shareExp = share.expires_at ? Math.floor(Date.parse(share.expires_at) / 1000) : Infinity;
    const exp = Math.min(Math.floor(Date.now() / 1000) + 7 * 86400, shareExp);
    out.push("## Files", "");
    for (const a of d.attachments as Array<{ id: string; filename: string; size: number }>) {
      const sig = await signValue(env, `${a.id}.${exp}`);
      out.push(`- [${a.filename}](${base(env)}/files/${a.id}?exp=${exp}&sig=${sig}) (${fmtSize(a.size)})`);
    }
    out.push("");
  }

  const msgs = (d.entries as unknown as Array<{ id: string; type: string; author_id: string; body: string; created_at: string; data: any; reactions: { emoji: string; by: string[] }[] }>).filter(
    (e) => ["comment", "update", "question", "answer"].includes(e.type) && !e.data?.deleted && e.body.trim(),
  );
  if (msgs.length) {
    out.push("## Thread", "");
    for (const e of msgs) {
      const author = e.data?.via_share ? `${e.data.author_name || "External"} (via share link)` : name(e.author_id);
      const kind = e.type === "comment" ? "" : ` · ${e.type}${e.type === "question" ? ` (${e.data?.state ?? "open"})` : ""}`;
      const ack = e.reactions.find((r) => r.emoji === "👍");
      const others = e.reactions.filter((r) => r.emoji !== "👍").map((r) => `${r.emoji} ${r.by.length}`);
      const foot = [ack ? `👍 Acknowledged by ${ack.by.map(name).join(", ")}` : "", ...others].filter(Boolean).join(" · ");
      out.push(`**${author}** — ${day(e.created_at)}${kind}`, "", e.body.trim(), "", ...(foot ? [`_${foot}_`, ""] : []), "---", "");
    }
  }

  if (share.mode === "reply") {
    out.push(
      "## Report back",
      "",
      "Post progress, questions or the finished result to this task's thread:",
      "",
      "```bash",
      `curl -X POST ${url}/messages \\`,
      `  -H 'Content-Type: application/json' \\`,
      `  -d '{"body": "What you did, links to PRs/files, anything still open", "type": "update", "author": "Claude"}'`,
      "```",
      "",
      '`type` is `update` (progress or result) or `comment`. Markdown is supported. You can also send plain text as the request body.',
      "",
    );
  }
  return out.join("\n");
}

export function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Plain-text summary of Markdown for link previews (Slack, WhatsApp, iMessage, X…). */
export function previewText(md: string, max = 200) {
  const text = md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/gm, "")
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).replace(/\s+\S*$/, "")}…` : text;
}

function renderShareHtml(title: string, md: string, mdUrl: string, wsName: string, meta: { description: string; url: string; status: string }) {
  const desc = meta.description || `${meta.status} · shared from ${wsName}`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="${esc(wsName)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(meta.url)}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<link rel="alternate" type="text/markdown" href="${esc(mdUrl)}">
<style>
:root{--bg:#f7f7f8;--card:#fff;--text:#1d1d20;--muted:#6b6b76;--line:#e6e6ea;--accent:#3b5bdb}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--card:#1c1c1f;--text:#ececef;--muted:#9a9aa5;--line:#2c2c31;--accent:#8ea2ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
header{max-width:820px;margin:0 auto;padding:20px 16px 8px;display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap}
header span{color:var(--muted);font-size:13px}
.actions{display:flex;gap:8px}
button,a.btn{font:inherit;font-size:13px;padding:6px 12px;border-radius:7px;border:1px solid var(--line);background:var(--card);color:var(--text);cursor:pointer;text-decoration:none}
button:focus-visible,a.btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
main{max-width:820px;margin:0 auto 48px;padding:0 16px}
pre.doc{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:20px;white-space:pre-wrap;word-wrap:break-word;font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;margin:0}
</style></head><body>
<header><span>${esc(wsName)} · shared task</span>
<div class="actions"><button id="copy" type="button">Copy for AI</button><a class="btn" href="${esc(mdUrl)}">Raw Markdown</a></div></header>
<main><pre class="doc" id="doc">${esc(md)}</pre></main>
<script>
document.getElementById('copy').onclick=async function(){try{await navigator.clipboard.writeText(document.getElementById('doc').textContent);this.textContent='Copied'}catch(e){this.textContent='Select and copy the text'}setTimeout(()=>this.textContent='Copy for AI',2000)};
</script>
</body></html>`;
}

// ---------- Public routes (no sign-in) ----------

export const PREVIEW_BOTS = /Slackbot|facebookexternalhit|Facebot|Twitterbot|WhatsApp|LinkedInBot|Discordbot|TelegramBot|SkypeUriPreview|Applebot|redditbot|Embedly|Iframely|vkShare|Pinterest|Google-PageRenderer|bingbot.*preview|MicrosoftPreview|Mattermost|Zulip/i;

export const sharePublicRoutes = new Hono<{ Bindings: AppEnv }>();

sharePublicRoutes.onError((err, c) => {
  const status = err instanceof HttpError ? err.status : 500;
  if (!(err instanceof HttpError)) console.error(err);
  const msg = err instanceof HttpError ? err.message : "Internal error";
  return c.req.method === "GET" && (c.req.header("accept") ?? "").includes("text/html")
    ? c.html(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link unavailable</title><p style="font:16px system-ui;max-width:560px;margin:15vh auto;padding:0 16px">${esc(msg)}</p>`, status as 404)
    : c.json({ error: msg }, status as 404);
});

sharePublicRoutes.get("/share/:token", async (c) => {
  let token = c.req.param("token");
  let format: "md" | "json" | "auto" = "auto";
  if (token.endsWith(".md")) (format = "md"), (token = token.slice(0, -3));
  else if (token.endsWith(".json")) (format = "json"), (token = token.slice(0, -5));
  const { share, task, ws } = await findShare(c.env, token);

  // Link-preview bots (Slack, WhatsApp, iMessage…) get the HTML page for its title/description tags,
  // and don't count as a use of the link.
  const ua = c.req.header("user-agent") ?? "";
  const previewBot = PREVIEW_BOTS.test(ua);
  if (!previewBot) {
    await c.env.DB.prepare("UPDATE task_shares SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?").bind(nowIso(), share.id).run();
  }
  const md = await renderShareMarkdown(c.env, share, task, ws);
  const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" };

  if (format === "json") {
    const d = await getTaskDetail(c.env, ws, task);
    return c.json(
      {
        task: { key: d.task.key, title: d.task.title, status: d.task.status, priority: d.task.priority, description: d.task.description },
        markdown: md,
        can_reply: share.mode === "reply",
        reply_url: share.mode === "reply" ? `${shareUrl(c.env, share)}/messages` : null,
        expires_at: share.expires_at,
      },
      200,
      headers,
    );
  }
  const wantsHtml = format === "auto" && (previewBot || (c.req.header("accept") ?? "").includes("text/html"));
  if (!wantsHtml) return c.body(md, 200, { ...headers, "Content-Type": "text/markdown; charset=utf-8" });
  return c.html(
    renderShareHtml(`${taskKey(ws, task)}: ${task.title}`, md, `${shareUrl(c.env, share)}.md`, ws.name, {
      description: previewText(task.description),
      url: shareUrl(c.env, share),
      status: (await serializeTasks(c.env, ws, [task]))[0]?.status_name ?? STATUS_LABEL[task.status] ?? task.status,
    }),
    200,
    headers,
  );
});

sharePublicRoutes.post("/share/:token/messages", async (c) => {
  const { share, task, ws } = await findShare(c.env, c.req.param("token"));
  if (share.mode !== "reply") throw forbidden("This share link is read-only.");

  let body = "";
  let type: "update" | "comment" = "update";
  let author = "";
  const ct = c.req.header("content-type") ?? "";
  if (ct.includes("application/json")) {
    const j = await c.req.json<{ body?: string; type?: string; author?: string }>().catch(() => ({}) as Record<string, string>);
    body = String(j.body ?? "");
    if (j.type === "comment") type = "comment";
    author = String(j.author ?? "");
  } else {
    body = await c.req.text();
  }
  body = body.trim();
  if (!body) throw badRequest('Send {"body": "..."} as JSON, or plain text.');
  if (body.length > MAX_BODY) throw badRequest(`Message is too long (max ${MAX_BODY} characters).`);
  author = author.trim().slice(0, 40);

  const recent = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM thread_entries WHERE task_id = ? AND json_extract(data, '$.share_id') = ? AND created_at > ?",
  )
    .bind(task.id, share.id, new Date(Date.now() - 3600_000).toISOString())
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= MAX_POSTS_PER_HOUR) throw new HttpError(429, "Too many messages from this link. Try again later.");

  const ext = await externalMember(c.env, ws, share.created_by);
  const actor: Actor = { member: ext, via: "system" }; // activity.via has no "share"; the entry is tagged below
  const entry = await postEntry(c.env, ws, actor, task, { type, body });
  const label = share.label || "share link";
  await c.env.DB.prepare(
    "UPDATE thread_entries SET data = json_set(data, '$.via_share', ?, '$.share_id', ?, '$.author_name', ?) WHERE id = ?",
  )
    .bind(label, share.id, author || null, entry.id)
    .run();
  await c.env.DB.prepare("UPDATE task_shares SET last_used_at = ? WHERE id = ?").bind(nowIso(), share.id).run();
  await notify(c.env, ws.id, { type: "thread", task_id: task.id });
  return c.json({ ok: true, id: entry.id, task: taskKey(ws, task) }, 201);
});

// ---------- Signed-in routes ----------

export const shareRoutes = new Hono<{ Bindings: AppEnv; Variables: Vars }>();

shareRoutes.get("/api/tasks/:ref/shares", async (c) => {
  const ws = c.get("ws");
  const task = await getTaskByRef(c.env, ws.id, c.req.param("ref"));
  const rows = await c.env.DB.prepare("SELECT * FROM task_shares WHERE task_id = ? AND revoked_at IS NULL ORDER BY created_at DESC")
    .bind(task.id)
    .all<ShareRow>();
  return c.json(rows.results.map((s) => serializeShare(c.env, s)));
});

shareRoutes.post("/api/tasks/:ref/shares", async (c) => {
  const ws = c.get("ws");
  const me = c.get("me");
  const task = await getTaskByRef(c.env, ws.id, c.req.param("ref"));
  const b = await c.req.json<{ mode?: string; label?: string; expires_in_days?: number }>().catch(() => ({}) as Record<string, never>);
  const mode = b.mode === "reply" ? "reply" : "read";
  const days = Number(b.expires_in_days ?? 7);
  if (!Number.isFinite(days) || days < 0 || days > 365) throw badRequest("expires_in_days must be between 0 (never) and 365");
  const now = nowIso();
  const share: ShareRow = {
    id: newId(),
    workspace_id: ws.id,
    task_id: task.id,
    token: randomToken(24),
    mode,
    label: String(b.label ?? "").trim().slice(0, 60),
    created_by: me.id,
    created_at: now,
    expires_at: days ? new Date(Date.now() + days * 86400_000).toISOString() : null,
    revoked_at: null,
    last_used_at: null,
    use_count: 0,
  };
  await c.env.DB.prepare(
    "INSERT INTO task_shares (id, workspace_id, task_id, token, mode, label, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?)",
  )
    .bind(share.id, ws.id, task.id, share.token, share.mode, share.label, me.id, now, share.expires_at)
    .run();
  await logActivity(c.env, ws.id, c.get("actor"), "task", task.id, "share_created", undefined, {
    share_id: share.id,
    mode,
    label: share.label,
    expires_at: share.expires_at,
  });
  return c.json(serializeShare(c.env, share), 201);
});

shareRoutes.delete("/api/shares/:id", async (c) => {
  const ws = c.get("ws");
  const me = c.get("me");
  const share = await c.env.DB.prepare("SELECT * FROM task_shares WHERE id = ? AND workspace_id = ?")
    .bind(c.req.param("id"), ws.id)
    .first<ShareRow>();
  if (!share) throw notFound("Share link");
  if (share.created_by !== me.id && me.role !== "admin") throw forbidden("Only the person who created the link, or an admin, can turn it off");
  await c.env.DB.prepare("UPDATE task_shares SET revoked_at = ? WHERE id = ?").bind(nowIso(), share.id).run();
  await logActivity(c.env, ws.id, c.get("actor"), "task", share.task_id, "share_revoked", undefined, { share_id: share.id });
  return c.json({ ok: true });
});
