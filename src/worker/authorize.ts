/**
 * OAuth consent for MCP clients (e.g. Grok Bot). A signed-in human chooses who the
 * connection acts as: themselves, or (admins only) one of the agent members.
 */
import { AuthorizationError, CimdFetchError, type ConsentDescription } from "@cloudflare/workers-oauth-provider";
import { getCookie } from "hono/cookie";
import type { Context } from "hono";
import { type MemberRow, ensureWorkspace, logActivity } from "./domain";
import { SESSION_COOKIE, getSessionMember } from "./auth";
import { type AppEnv, escapeHtml } from "./util";

export interface McpProps {
  memberId: string;
  workspaceId: string;
  connectedBy: string;
}

function page(title: string, body: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#fafafa;--fg:#18181b;--muted:#71717a;--card:#fff;--border:#e4e4e7;--accent:#4f46e5}
@media (prefers-color-scheme:dark){:root{--bg:#09090b;--fg:#fafafa;--muted:#a1a1aa;--card:#18181b;--border:#27272a}}
body{font-family:ui-sans-serif,system-ui,sans-serif;background:var(--bg);color:var(--fg);margin:0;padding:48px 16px}
.card{max-width:440px;margin:0 auto;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:28px}
h1{font-size:18px;margin:0 0 8px}p{color:var(--muted);font-size:14px;line-height:1.5}
label.opt{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1px solid var(--border);border-radius:8px;margin:8px 0;cursor:pointer;font-size:14px}
label.opt small{display:block;color:var(--muted)}
.warn{background:#fef3c7;color:#92400e;padding:10px;border-radius:8px;font-size:13px}
.row{display:flex;gap:8px;margin-top:20px}button{flex:1;padding:10px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--fg);font-size:14px;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
</style></head><body><div class="card">${body}</div></body></html>`;
}

function consentHtml(details: ConsentDescription, handle: string, me: MemberRow, agents: MemberRow[]) {
  const name = escapeHtml(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : "This app registered itself; its name is not verified.";
  const options = [
    `<label class="opt"><input type="radio" name="act_as" value="${escapeHtml(me.id)}" ${agents.length ? "" : "checked"}>
      <span>Myself — ${escapeHtml(me.name)}<small>The assistant acts as you.</small></span></label>`,
    ...agents.map(
      (a, i) => `<label class="opt"><input type="radio" name="act_as" value="${escapeHtml(a.id)}" ${i === 0 ? "checked" : ""}>
      <span>Agent — ${escapeHtml(a.name)} <small>@${escapeHtml(a.handle)}${a.description ? " · " + escapeHtml(a.description) : ""}</small></span></label>`,
    ),
  ].join("");
  return page(
    `Connect ${details.clientName}`,
    `<h1>Connect ${name} to Agentic PM</h1>
<p>${origin} Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? '<p class="warn">This sends access to an app on your computer. Continue only if you just started connecting from it.</p>' : ""}
<form method="post">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<p style="margin-top:16px"><strong style="color:var(--fg)">Who should this connection act as?</strong></p>
${options}
${me.role !== "admin" ? "<p><small>Only admins can connect an assistant as an agent member.</small></p>" : ""}
<p>It will be able to read and update tasks, post to task threads, ask questions, and upload attachments.</p>
<div class="row"><button name="decision" value="deny">Deny</button><button class="primary" name="decision" value="approve">Allow</button></div>
</form>`,
  );
}

export async function handleAuthorize(c: Context<{ Bindings: AppEnv }>) {
  const env = c.env;
  const oauth = env.OAUTH_PROVIDER;
  const me = await getSessionMember(env, getCookie(c, SESSION_COOKIE));
  try {
    if (c.req.method === "GET") {
      if (!me) {
        const url = new URL(c.req.url);
        const next = url.pathname + url.search;
        const loginPath = env.GOOGLE_CLIENT_ID ? "/auth/google" : "/auth/dev";
        return c.redirect(`${loginPath}?next=${encodeURIComponent(next)}`);
      }
      const request = await oauth.parseAuthRequest(c.req.raw);
      const details = await oauth.describeConsent(request);
      const consent = await oauth.beginConsent(request);
      const agents =
        me.role === "admin"
          ? (
              await env.DB.prepare("SELECT * FROM members WHERE workspace_id = ? AND kind = 'agent' AND active = 1 ORDER BY name")
                .bind(me.workspace_id)
                .all<MemberRow>()
            ).results
          : [];
      consent.headers.set("Content-Type", "text/html; charset=utf-8");
      return new Response(consentHtml(details, consent.handle, me, agents), { headers: consent.headers });
    }

    // POST
    if (!me) return c.text("Your session expired. Start connecting again.", 401);
    const form = await c.req.formData();
    const handle = String(form.get("handle") ?? "");
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(c.req.raw, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const actAs = String(form.get("act_as") ?? me.id);
    let target: MemberRow = me;
    if (actAs !== me.id) {
      if (me.role !== "admin") return c.text("Only admins can connect as an agent", 403);
      const agent = await env.DB.prepare(
        "SELECT * FROM members WHERE id = ? AND workspace_id = ? AND kind = 'agent' AND active = 1",
      )
        .bind(actAs, me.workspace_id)
        .first<MemberRow>();
      if (!agent) return c.text("Unknown agent", 400);
      target = agent;
    }
    const approved = await oauth.approveConsent(c.req.raw, handle);
    const ws = await ensureWorkspace(env);
    const props: McpProps = { memberId: target.id, workspaceId: ws.id, connectedBy: me.id };
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: target.id,
      metadata: { connectedBy: me.id, connectedByName: me.name },
      scope: approved.request.scope,
      props,
    });
    await logActivity(env, ws.id, { member: me, via: "web" }, "member", target.id, "mcp_connected", undefined, {
      client: approved.request.clientId,
    });
    approved.headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      const message = error instanceof AuthorizationError ? error.description : "This app could not be verified.";
      return new Response(page("Connection failed", `<h1>Connection failed</h1><p>${escapeHtml(message ?? "Unknown error")}</p>`), {
        status: 400,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    throw error;
  }
}
