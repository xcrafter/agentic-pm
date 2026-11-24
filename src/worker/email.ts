/**
 * Email notifications through Cloudflare Email Service.
 *
 * Off unless the deployment sets EMAIL_FROM (an address on a domain onboarded to Email Sending) and has
 * the `send_email` binding EMAIL; scripts/configure.mjs adds both from the APM_EMAIL_FROM build variable.
 * Emails go through the dispatch queue so a slow or failing send never holds up the request, and every
 * attempt is written to email_log so admins can see what was sent.
 */
import { Hono } from "hono";
import type { MemberRow, TaskRow, WorkspaceRow } from "./domain";
import { type AppEnv, HttpError, badRequest, forbidden, newId, nowIso } from "./util";

/** Notifications a person can turn off. Invites, password resets and test emails always go. */
export const EMAIL_KINDS = [
  { key: "assigned", label: "A task is assigned to me" },
  { key: "mentioned", label: "Someone @mentions me" },
  { key: "question", label: "An agent asks me a question" },
  { key: "run_failed", label: "An agent I started fails or gets stuck" },
] as const;
export type NotifyKind = (typeof EMAIL_KINDS)[number]["key"];
type EmailKind = NotifyKind | "invite" | "reset" | "test";

export interface EmailJob {
  workspaceId: string;
  memberId: string | null;
  to: string;
  kind: EmailKind;
  subject: string;
  text: string;
  html: string;
}
export interface EmailQueueMessage {
  email: EmailJob;
}

const MAX_ATTEMPTS = 3;

export const emailFrom = (env: AppEnv) => (env.EMAIL_FROM ?? "").trim();
export const emailEnabled = (env: AppEnv) => !!emailFrom(env);

function offKinds(m: MemberRow): string[] {
  try {
    const p = JSON.parse(m.email_prefs || "{}");
    return Array.isArray(p.off) ? p.off.filter((k: unknown) => typeof k === "string") : [];
  } catch {
    return [];
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Build a plain email: a few lines of text, one button, and a footer. */
export function composeEmail(
  env: AppEnv,
  ws: { name: string },
  o: { lines: string[]; quote?: string | null; link: string; linkLabel: string; footer?: string },
) {
  const quote = o.quote ? o.quote.trim().slice(0, 600) : "";
  const footer =
    o.footer ?? `You get this because you're in ${ws.name} on Agentic PM. Choose which emails you get from your menu → Email notifications.`;
  const text = [...o.lines, ...(quote ? ["", quote.replace(/^/gm, "> ")] : []), "", `${o.linkLabel}: ${o.link}`, "", "—", footer].join("\n");
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;line-height:1.5;color:#1f2328;max-width:560px">
${o.lines.map((l) => `<p style="margin:0 0 12px">${esc(l)}</p>`).join("\n")}
${quote ? `<blockquote style="margin:0 0 16px;padding:8px 12px;border-left:3px solid #d0d7de;color:#57606a;white-space:pre-wrap">${esc(quote)}</blockquote>` : ""}
<p style="margin:16px 0"><a href="${esc(o.link)}" style="display:inline-block;background:#1f2328;color:#fff;text-decoration:none;padding:8px 14px;border-radius:6px">${esc(o.linkLabel)}</a></p>
<p style="margin:24px 0 0;font-size:12px;color:#8c959f">${esc(footer)}</p>
</div>`;
  return { text, html };
}

/** Queue an email. Does nothing when email isn't set up. */
export async function queueEmail(env: AppEnv, job: EmailJob) {
  if (!emailEnabled(env)) return false;
  try {
    await env.DISPATCH_QUEUE.send({ email: job } satisfies EmailQueueMessage);
    return true;
  } catch (err) {
    console.error("queue email failed", err);
    return false;
  }
}

/**
 * Email a member about something, if they're a person with an address who hasn't turned that kind off,
 * and isn't the one who caused it.
 */
export async function notifyMember(
  env: AppEnv,
  ws: WorkspaceRow,
  member: MemberRow | null | undefined,
  kind: NotifyKind,
  o: { subject: string; lines: string[]; quote?: string | null; link: string; linkLabel: string; actorId?: string | null },
) {
  if (!emailEnabled(env) || !member) return;
  if (member.kind !== "human" || !member.active || !member.email) return;
  if (o.actorId && o.actorId === member.id) return;
  if (offKinds(member).includes(kind)) return;
  const { text, html } = composeEmail(env, ws, o);
  await queueEmail(env, { workspaceId: ws.id, memberId: member.id, to: member.email, kind, subject: o.subject, text, html });
}

export const taskLink = (env: AppEnv, ws: WorkspaceRow, t: TaskRow) => `${env.PUBLIC_URL.replace(/\/$/, "")}/t/${ws.key_prefix}-${t.number}`;
export const taskLabel = (ws: WorkspaceRow, t: TaskRow) => `${ws.key_prefix}-${t.number} ${t.title}`;

async function logEmail(env: AppEnv, job: EmailJob, status: "sent" | "failed" | "skipped", error: string | null) {
  await env.DB.prepare(
    "INSERT INTO email_log (id, workspace_id, member_id, to_email, kind, subject, status, error, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
  )
    .bind(newId(), job.workspaceId, job.memberId, job.to, job.kind, job.subject, status, error?.slice(0, 500) ?? null, nowIso())
    .run();
}

/** Errors that won't go away by trying again (bad address, domain not set up, plan doesn't allow it). */
const PERMANENT = /E_(SENDER|RECIPIENT|FIELD|HEADER|CONTENT|VALIDATION|PLAN)|not allowed|not verified|not configured|suppressed/i;

/** Send one email now. Returns the outcome; logs it unless `retrying` says another attempt will follow. */
export async function deliverEmail(env: AppEnv, job: EmailJob, attempt = 1): Promise<{ status: "sent" | "failed" | "skipped" | "retry"; error?: string }> {
  if (!env.EMAIL) {
    const error = "This deployment has no EMAIL binding. Set the APM_EMAIL_FROM build variable and rebuild.";
    await logEmail(env, job, "skipped", error);
    return { status: "skipped", error };
  }
  const ws = await env.DB.prepare("SELECT name FROM workspaces WHERE id = ?").bind(job.workspaceId).first<{ name: string }>();
  try {
    await env.EMAIL.send({
      from: { email: emailFrom(env), name: ws?.name ? `${ws.name} (Agentic PM)` : "Agentic PM" },
      to: job.to,
      subject: job.subject,
      text: job.text,
      html: job.html,
    });
    await logEmail(env, job, "sent", null);
    return { status: "sent" };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (attempt < MAX_ATTEMPTS && !PERMANENT.test(error)) return { status: "retry", error };
    await logEmail(env, job, "failed", error);
    return { status: "failed", error };
  }
}

export async function handleEmailMessage(env: AppEnv, msg: Message<EmailQueueMessage>) {
  const r = await deliverEmail(env, msg.body.email, msg.attempts);
  if (r.status === "retry") msg.retry({ delaySeconds: 60 * msg.attempts });
  else msg.ack();
}

// ---------- API ----------

type Vars = { me: MemberRow; ws: WorkspaceRow };
export const emailRoutes = new Hono<{ Bindings: AppEnv; Variables: Vars }>();

emailRoutes.get("/api/email-prefs", (c) => {
  const me = c.get("me");
  return c.json({ enabled: emailEnabled(c.env), kinds: EMAIL_KINDS, off: offKinds(me), email: me.email });
});

emailRoutes.put("/api/email-prefs", async (c) => {
  const me = c.get("me");
  if (me.kind !== "human") throw badRequest("Agents don't get email");
  const body = await c.req.json<{ off?: unknown }>().catch(() => ({}) as { off?: unknown });
  if (!Array.isArray(body.off)) throw badRequest("Send {off: [...]} with the kinds to turn off");
  const known = new Set<string>(EMAIL_KINDS.map((k) => k.key));
  const bad = body.off.filter((k) => typeof k !== "string" || !known.has(k));
  if (bad.length) throw badRequest(`Unknown email kind: ${bad.join(", ")}`);
  const off = [...new Set(body.off as string[])];
  await c.env.DB.prepare("UPDATE members SET email_prefs = ? WHERE id = ?").bind(JSON.stringify({ off }), me.id).run();
  return c.json({ enabled: emailEnabled(c.env), kinds: EMAIL_KINDS, off, email: me.email });
});

emailRoutes.get("/api/email-log", async (c) => {
  if (c.get("me").role !== "admin") throw forbidden("Only admins can see the email log");
  const rows = await c.env.DB.prepare(
    "SELECT id, to_email, kind, subject, status, error, created_at FROM email_log WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 50",
  )
    .bind(c.get("ws").id)
    .all();
  return c.json({ enabled: emailEnabled(c.env), from: emailFrom(c.env) || null, binding: !!c.env.EMAIL, items: rows.results });
});

/** Admins: send a test email to yourself right away and see the result. */
emailRoutes.post("/api/email-test", async (c) => {
  const me = c.get("me");
  if (me.role !== "admin") throw forbidden("Only admins can send a test email");
  if (!emailEnabled(c.env)) throw new HttpError(400, "Email isn't set up for this deployment yet (no sender address).");
  if (!me.email) throw badRequest("Your account has no email address");
  const ws = c.get("ws");
  const { text, html } = composeEmail(c.env, ws, {
    lines: [`This is a test email from ${ws.name} on Agentic PM.`, "If you're reading it, email notifications work."],
    link: c.env.PUBLIC_URL,
    linkLabel: "Open Agentic PM",
  });
  const r = await deliverEmail(c.env, { workspaceId: ws.id, memberId: me.id, to: me.email, kind: "test", subject: `Test email from ${ws.name}`, text, html }, MAX_ATTEMPTS);
  return c.json({ status: r.status, error: r.error ?? null, to: me.email });
});
