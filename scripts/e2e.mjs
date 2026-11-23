#!/usr/bin/env node
/**
 * End-to-end check of the human ⇄ agent loop against a running dev server.
 *   npm run dev   (in another terminal)
 *   node scripts/e2e.mjs [baseUrl]
 *
 * Plays the part of a Grok Bot: a local webhook receiver, an MCP client that signs in
 * through the real OAuth flow, and a human using the web API.
 */
import http from "node:http";
import crypto from "node:crypto";
import assert from "node:assert/strict";

const BASE = process.argv[2] ?? "http://localhost:5173";
const HOOK_PORT = 8799;
const HOOK_KEY = "test-secret-key";
const runId = Date.now().toString(36);

// ---------- mock agent webhook ----------
const hookCalls = [];
let hookWaiters = [];
const hookServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url === "/site") {
      res.writeHead(200, { "Content-Type": "text/html" }).end(
        `<html><head><title>Quillpad | Notes for teams</title><meta name="description" content="Quillpad is a shared notebook for product teams."><link rel="icon" href="/fav.svg"></head><body><h1>Write together</h1><p>Shared docs with comments.</p></body></html>`,
      );
      return;
    }
    if (req.url === "/hook") {
      const ok = req.headers.authorization === `Bearer ${HOOK_KEY}`;
      const call = { auth: ok, body: body ? JSON.parse(body) : null };
      hookCalls.push(call);
      hookWaiters.forEach((w) => w());
      hookWaiters = [];
      res.writeHead(ok ? 200 : 401).end(ok ? "accepted" : "bad key");
    } else res.writeHead(404).end();
  });
});
await new Promise((r) => hookServer.listen(HOOK_PORT, r));

async function waitForHook(pred, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const hit = hookCalls.find(pred);
    if (hit) return hit;
    await new Promise((r) => {
      hookWaiters.push(r);
      setTimeout(r, 500);
    });
  }
  throw new Error("Timed out waiting for webhook call");
}

// ---------- cookie jar helpers ----------
function cookiesFrom(res, jar = {}) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const [k, ...v] = pair.split("=");
    jar[k.trim()] = v.join("=");
  }
  return jar;
}
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");

async function authPost(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { res, jar: cookiesFrom(res), data: await res.json().catch(() => null) };
}

function webApi(jar) {
  return async (method, path, body) => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { Cookie: cookieHeader(jar), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
    return data;
  };
}

const step = (s) => console.log(`\n▶ ${s}`);
const pass = (s) => console.log(`  ✓ ${s}`);

try {
  // ---------- human admin ----------
  step("First person sets up the workspace with email + password");
  const meBefore = await (await fetch(`${BASE}/api/me`)).json();
  if (!meBefore.auth.setup) throw new Error("Run against a fresh database: the workspace is already set up");
  const unauthApi = await fetch(`${BASE}/api/tasks`);
  assert.equal(unauthApi.status, 401);
  pass("API refuses requests without a session");
  const PASSWORD = "correct horse battery";
  const setup = await authPost("/auth/setup", { name: "Alice", email: "alice@example.com", password: PASSWORD });
  assert.equal(setup.res.status, 200, `setup: ${JSON.stringify(setup.data)}`);
  const alice = webApi(setup.jar);
  const me = await alice("GET", "/api/me");
  assert.equal(me.member.role, "admin");
  pass(`signed up as ${me.member.name} (${me.member.role})`);
  const again = await authPost("/auth/setup", { name: "Mallory", email: "mallory@example.com", password: "whatever123" });
  assert.equal(again.res.status, 403);
  pass("setup is closed once the first person exists");
  const outsider = await authPost("/auth/setup", { email: "x@gmail.com", password: "whatever123" });
  assert.notEqual(outsider.res.status, 200);
  const devGone = await fetch(`${BASE}/auth/dev`, { method: "POST", body: new URLSearchParams({ email: "eve@example.com" }), redirect: "manual" });
  assert.notEqual(devGone.status, 302);
  pass("passwordless developer sign-in no longer exists");

  step("Password sign-in");
  const wrong = await authPost("/auth/login", { email: "alice@example.com", password: "nope-nope" });
  assert.equal(wrong.res.status, 401);
  const unknown = await authPost("/auth/login", { email: "nobody@example.com", password: PASSWORD });
  assert.equal(unknown.res.status, 401);
  const formPost = await fetch(`${BASE}/auth/login`, { method: "POST", body: new URLSearchParams({ email: "alice@example.com", password: PASSWORD }) });
  assert.equal(formPost.status, 415);
  pass("wrong password, unknown email and cross-site form posts are refused");
  const good = await authPost("/auth/login", { email: "alice@example.com", password: PASSWORD });
  assert.equal(good.res.status, 200);
  const aliceJar = good.jar;
  pass("correct password signs in");

  step("Admin invites a teammate; they set their own password");
  const invite = await alice("POST", "/api/invites", { email: "bob@example.com", name: "Bob" });
  const token = invite.url.split("/invite/")[1];
  const info = await (await fetch(`${BASE}/auth/invite/${token}`)).json();
  assert.equal(info.email, "bob@example.com");
  const accept = await authPost(`/auth/invite/${token}`, { name: "Bob", password: "bobs-password" });
  assert.equal(accept.res.status, 200, JSON.stringify(accept.data));
  const bobJar = accept.jar;
  const bob = webApi(bobJar);
  assert.equal((await bob("GET", "/api/me")).member.role, "member");
  const reuse = await authPost(`/auth/invite/${token}`, { name: "Eve", password: "eves-password" });
  assert.equal(reuse.res.status, 404);
  pass("invite link signs Bob up as a member and can't be reused");
  const bobMember = (await alice("GET", "/api/members")).find((m) => m.email === "bob@example.com");
  const resetLink = await alice("POST", `/api/members/${bobMember.id}/reset-link`);
  const reset = await authPost(`/auth/invite/${resetLink.url.split("/invite/")[1]}`, { password: "bobs-new-password" });
  assert.equal(reset.res.status, 200);
  assert.equal((await fetch(`${BASE}/api/me`, { headers: { Cookie: cookieHeader(bobJar) } }).then((r) => r.json())).member, null);
  assert.equal((await authPost("/auth/login", { email: "bob@example.com", password: "bobs-new-password" })).res.status, 200);
  pass("admin reset link sets a new password and signs out old sessions");
  const bobJar2 = reset.jar;
  const bob2 = webApi(bobJar2);

  step("Admin adds a Grok Bot agent with a webhook");
  const agent = await alice("POST", "/api/members/agents", {
    name: `Grok Bot ${runId}`,
    handle: `grok-${runId}`,
    description: "Research and writing",
    webhook_url: `http://localhost:${HOOK_PORT}/hook`,
    webhook_key: HOOK_KEY,
  });
  pass(`agent @${agent.handle} created`);

  const ping = await alice("POST", `/api/members/${agent.id}/test-ping`);
  assert.equal(ping.ok, true, `test ping: ${JSON.stringify(ping)}`);
  assert.equal(hookCalls.at(-1).body.event, "test");
  pass("test ping reached the webhook with the right Bearer key");

  // ---------- OAuth: connect "Grok Bot" to the MCP server ----------
  step("MCP client discovers auth and registers (DCR)");
  const unauth = await fetch(`${BASE}/mcp`, { method: "POST", body: "{}" });
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get("www-authenticate") ?? "", /resource_metadata/);
  pass("unauthenticated /mcp → 401 with resource metadata challenge");
  const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
  const asMeta = await (await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();
  const redirectUri = `http://localhost:${HOOK_PORT}/callback`;
  const reg = await (
    await fetch(asMeta.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Grok Bot (test)",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    })
  ).json();
  assert.ok(reg.client_id, `registration: ${JSON.stringify(reg)}`);
  pass(`registered client ${reg.client_id.slice(0, 12)}…`);

  async function connect(jar, fields, checkHtml) {
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const state = crypto.randomBytes(8).toString("hex");
    const authUrl = new URL(asMeta.authorization_endpoint);
    Object.entries({
      response_type: "code",
      client_id: reg.client_id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      resource: prm.resource,
      scope: "tasks",
    }).forEach(([k, v]) => authUrl.searchParams.set(k, v));
    const consentJar = { ...jar };
    const consentRes = await fetch(authUrl, { headers: { Cookie: cookieHeader(consentJar) }, redirect: "manual" });
    assert.equal(consentRes.status, 200, `consent page: ${consentRes.status} ${await consentRes.clone().text()}`);
    cookiesFrom(consentRes, consentJar);
    const html = await consentRes.text();
    checkHtml?.(html);
    const handle = /name="handle" value="([^"]+)"/.exec(html)[1];
    const approve = await fetch(authUrl, {
      method: "POST",
      headers: { Cookie: cookieHeader(consentJar), "Content-Type": "application/x-www-form-urlencoded", Origin: new URL(BASE).origin },
      body: new URLSearchParams({ handle, decision: "approve", ...fields }),
      redirect: "manual",
    });
    if (approve.status !== 302) return { status: approve.status };
    const cb = new URL(approve.headers.get("location"));
    assert.equal(cb.searchParams.get("state"), state);
    const tokenRes = await fetch(asMeta.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: cb.searchParams.get("code"),
        redirect_uri: redirectUri,
        client_id: reg.client_id,
        code_verifier: verifier,
        resource: prm.resource,
      }),
    });
    const tokens = await tokenRes.json();
    assert.ok(tokens.access_token, `token: ${JSON.stringify(tokens)}`);
    return { status: 302, tokens };
  }

  step("Signing in from the MCP consent screen redirects to the sign-in page");
  const anonAuthorize = await fetch(`${BASE}/authorize?client_id=${reg.client_id}`, { redirect: "manual" });
  assert.equal(anonAuthorize.status, 302);
  assert.match(anonAuthorize.headers.get("location"), /^\/\?next=%2Fauthorize/);
  pass("signed-out visitor is sent to /?next=/authorize…");

  step("Admin approves the connection, acting as the agent");
  const { tokens } = await connect(aliceJar, { act_as: agent.id }, (html) => {
    assert.match(html, new RegExp(agent.name));
    assert.match(html, /A new agent/);
  });
  pass("consent page lists the agent and a 'new agent' option");
  pass("access token issued");

  step("A non-admin can't take over an agent they didn't create");
  const hijack = await connect(bobJar2, { act_as: agent.id }, (html) => assert.doesNotMatch(html, new RegExp(agent.name)));
  assert.equal(hijack.status, 403);
  pass("Bob doesn't see Alice's agent and can't connect as it");

  step("Bob connects his assistant and creates a new agent profile on the consent screen");
  const bobConn = await connect(bobJar2, { act_as: "__new__", agent_name: `Bob's Grok ${runId}` });
  assert.equal(bobConn.status, 302);
  const bobsAgent = (await bob2("GET", "/api/members")).find((m) => m.name === `Bob's Grok ${runId}`);
  assert.ok(bobsAgent && bobsAgent.kind === "agent", "new agent member exists");
  pass(`agent @${bobsAgent.handle} created by Bob`);

  // ---------- MCP client ----------
  let rpcId = 0;
  async function mcp(method, params, accessToken = tokens.access_token) {
    const res = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    });
    const text = await res.text();
    assert.equal(res.status, 200, `mcp ${method}: ${res.status} ${text}`);
    const msg = JSON.parse(text);
    if (msg.error) throw new Error(`mcp ${method}: ${JSON.stringify(msg.error)}`);
    return msg.result;
  }
  async function tool(name, args = {}, accessToken) {
    const r = await mcp("tools/call", { name, arguments: args }, accessToken);
    const text = r.content?.[0]?.text ?? "";
    if (r.isError) throw new Error(`tool ${name}: ${text}`);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  step("Agent connects over MCP");
  const init = await mcp("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "e2e", version: "1" },
  });
  assert.equal(init.serverInfo.name, "agentic-pm");
  const tools = await mcp("tools/list", {});
  pass(`${tools.tools.length} tools: ${tools.tools.map((t) => t.name).join(", ")}`);
  const myMembers = await tool("list_members");
  assert.ok(myMembers.some((m) => m.id === agent.id));

  step("Bob's new agent sets up its own profile and webhook over MCP");
  const profile = await tool(
    "update_my_profile",
    { description: "Bob's research helper", webhook_url: `http://localhost:${HOOK_PORT}/hook`, webhook_key: HOOK_KEY },
    bobConn.tokens.access_token,
  );
  assert.equal(profile.webhook_set, true);
  const bobPing = await bob2("POST", `/api/members/${bobsAgent.id}/test-ping`);
  assert.equal(bobPing.ok, true, JSON.stringify(bobPing));
  pass("agent configured itself; its creator's test ping reaches the webhook");

  // ---------- the loop ----------
  step("Human creates a task assigned to the agent → agent is woken");
  const project = await alice("POST", "/api/projects", { name: `Launch ${runId}` });
  const task = await alice("POST", "/api/tasks", {
    title: "Research top 5 competitors",
    description: "Summarise pricing and positioning.",
    assignee_id: agent.id,
    project_id: project.id,
    priority: "high",
  });
  const assignedHook = await waitForHook((c) => c.body?.event === "assigned" && c.body.task.key === task.key);
  assert.equal(assignedHook.auth, true);
  assert.match(assignedHook.body.instruction, /get_task/);
  pass(`webhook called: event=assigned task=${task.key} run=${assignedHook.body.run_id}`);

  step("Agent reads the task and works");
  const mine = await tool("list_my_tasks");
  assert.ok(mine.some((t) => t.key === task.key), "task in list_my_tasks");
  const got = await tool("get_task", { task: task.key });
  assert.equal(got.task.title, "Research top 5 competitors");
  let detail = await alice("GET", `/api/tasks/${task.key}`);
  assert.equal(detail.task.status, "in_progress", "status moves to in_progress when the agent starts");
  assert.equal(detail.runs[0].status, "active");
  pass("task moved to In Progress and run is active");
  await tool("post_update", { task: task.key, body: "Found 7 candidates, narrowing to 5." });
  const cl = await tool("create_checklist", { task: task.key, title: "Competitors", items: ["Acme", "Globex", "Initech"] });
  await tool("set_checklist_item", { item_id: cl.items[0].id, done: true });
  await tool("write_note", { task: task.key, title: "Findings", content: "## Acme\n- Pricing: $49/mo\n- [ ] verify enterprise tier" });
  await tool("attach_file", {
    task: task.key,
    filename: "summary.csv",
    content_type: "text/csv",
    content_base64: Buffer.from("name,price\nAcme,49\n").toString("base64"),
  });
  pass("posted update, checklist, note, attachment");

  step("Human comments while the agent is working → coalesced, no duplicate wake");
  const before = hookCalls.length;
  await alice("POST", `/api/tasks/${task.key}/entries`, { body: `@${agent.handle} include Hooli too` });
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(hookCalls.length, before, "no new webhook while run is open");
  pass("mention during an open run was queued, not dispatched");

  step("Agent asks a question → waiting on human, run ends");
  const q = await tool("ask_question", { task: task.key, body: "Should I include private companies?" });
  detail = await alice("GET", `/api/tasks/${task.key}`);
  assert.equal(detail.task.status, "waiting_on_human");
  pass("task is Waiting on human");
  const inbox = await alice("GET", "/api/inbox");
  assert.ok(inbox.questions.some((x) => x.id === q.id), "question in creator's inbox");
  pass("question shows in the human's Needs you inbox");
  // No catch-up wake right after a question: the answer will wake the agent (and it sees the mention then).
  await new Promise((r) => setTimeout(r, 2500));
  assert.ok(!hookCalls.some((c) => c.body?.event === "followup" && c.body.task.key === task.key), "no follow-up after asking");
  pass("asking a question doesn't trigger a catch-up wake");

  step("Human answers while another run is open → the answer is still delivered at once");
  await alice("POST", `/api/tasks/${task.key}/wake`, { agent_id: agent.id });
  const manualHook = await waitForHook((c) => c.body?.event === "manual" && c.body.task.key === task.key);
  await alice("POST", `/api/tasks/${task.key}/entries`, { body: "Yes, include private ones.", reply_to_id: q.id });
  const answeredHook = await waitForHook((c) => c.body?.event === "answered" && c.body.task.key === task.key);
  assert.notEqual(answeredHook.body.run_id, manualHook.body.run_id);
  const superseded = (await alice("GET", `/api/tasks/${task.key}`)).runs.find((r) => r.id === manualHook.body.run_id);
  assert.equal(superseded.status, "ended");
  pass(`answer delivered immediately (run ${answeredHook.body.run_id}); the open run was replaced`);
  detail = await alice("GET", `/api/tasks/${task.key}`);
  assert.equal(detail.task.status, "in_progress");
  pass("task back to In Progress");
  const afterAnswer = await tool("get_task", { task: task.key });
  assert.ok(afterAnswer.unread.some((e) => e.type === "answer" && e.body.includes("private")), "answer in unread");
  assert.equal(afterAnswer.open_questions.length, 0);
  pass("agent sees the answer under 'unread'");

  step("Agent completes the task");
  await tool("complete_task", { task: task.key, summary: "Done: 5 competitors summarised in the Findings note." });
  detail = await alice("GET", `/api/tasks/${task.key}`);
  assert.equal(detail.task.status, "done");
  assert.ok(detail.runs.every((r) => r.status === "ended"), "all runs ended");
  assert.equal(detail.notes.length, 1);
  assert.equal(detail.checklists[0].items.filter((i) => i.done).length, 1);
  assert.equal(detail.attachments.length, 1);
  pass(`task done; thread has ${detail.entries.length} entries`);

  step("Loop guard: agent @mentioning itself / assigning to an agent doesn't wake anyone");
  const n = hookCalls.length;
  const t2 = await tool("create_task", { title: "Follow-up by agent", assignee: agent.handle });
  await tool("add_comment", { task: t2.key, body: `@${agent.handle} reminder to self` });
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(hookCalls.length, n);
  pass("no webhook calls from agent-originated actions");

  step("Attachment download via signed URL");
  const att = await tool("get_attachment", { attachment_id: detail.attachments[0].id });
  const dl = await fetch(att.url);
  assert.equal(await dl.text(), "name,price\nAcme,49\n");
  const bad = await fetch(att.url.replace(/sig=[^&]+/, "sig=nope"));
  assert.equal(bad.status, 403);
  pass("signed URL works; tampered URL is rejected");

  // ---------- workspace settings ----------
  step("Workspace settings: only admins change them; allowed domains are enforced");
  await assert.rejects(bob2("PATCH", "/api/workspace", { name: "Hijacked" }), /403/);
  await assert.rejects(alice("PATCH", "/api/workspace", { allowed_domains: ["example.org"] }), /block your own address/);
  let wsInfo = await alice("PATCH", "/api/workspace", { name: "Acme", allowed_domains: ["example.com", "partner.io"] });
  assert.deepEqual(wsInfo.allowed_domains, ["example.com", "partner.io"]);
  assert.equal(wsInfo.allowed_domains_source, "workspace");
  const partnerInvite = await alice("POST", "/api/invites", { email: `dana-${runId}@partner.io`, name: "Dana" });
  assert.ok(partnerInvite.url);
  await assert.rejects(alice("POST", "/api/invites", { email: `eve-${runId}@other.com` }), /403/);
  pass("non-admin blocked; admin can't lock themselves out; new domain accepted, others rejected");

  step("Workspace logo upload is served publicly (sign-in page)");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKElEQVR42mNkYPj/n4EIwDiqgWE0DBhGw4BhNAwYRsOAYTQMGEbDAACJ0B/xMzq+6wAAAABJRU5ErkJggg==",
    "base64",
  );
  const fd = new FormData();
  fd.append("file", new Blob([png], { type: "image/png" }), "logo.png");
  const up = await fetch(`${BASE}/api/workspace/logo`, { method: "POST", headers: { Cookie: cookieHeader(aliceJar) }, body: fd });
  assert.equal(up.status, 200, await up.clone().text());
  const logoRes = await fetch(`${BASE}/api/logo`);
  assert.equal(logoRes.status, 200);
  assert.equal(logoRes.headers.get("content-type"), "image/png");
  const signedOut = await (await fetch(`${BASE}/api/me`)).json();
  assert.ok(signedOut.brand.logo_url, "brand logo visible when signed out");
  const notImage = new FormData();
  notImage.append("file", new Blob(["<script>alert(1)</script>"], { type: "image/png" }), "x.png");
  const badUp = await fetch(`${BASE}/api/workspace/logo`, { method: "POST", headers: { Cookie: cookieHeader(aliceJar) }, body: notImage });
  assert.equal(badUp.status, 400);
  wsInfo = await alice("PATCH", "/api/workspace", { allowed_domains: null });
  assert.equal(wsInfo.allowed_domains_source, "default");
  pass("PNG logo stored and served; non-images rejected; domains reset to default");

  // ---------- orchestrator + sub-agents ----------
  step("Orchestrator agent registers a sub-agent over MCP");
  const toolList = (await mcp("tools/list", {})).tools;
  assert.ok(toolList.some((t) => t.name === "register_agent"));
  assert.ok(toolList.find((t) => t.name === "get_task").inputSchema.properties.as_agent, "as_agent on every tool");
  const sub = await tool("register_agent", {
    name: `Grok Researcher ${runId}`,
    description: "Deep web research",
    webhook_url: `http://localhost:${HOOK_PORT}/hook`,
    webhook_key: HOOK_KEY,
  });
  assert.equal(sub.webhook_set, true);
  assert.ok((await tool("list_my_agents")).some((a) => a.handle === sub.handle));
  const orchRecord = await alice("GET", `/api/members/${agent.handle}/record`);
  assert.ok(orchRecord.sub_agents.some((a) => a.handle === sub.handle));
  const subRecord = await alice("GET", `/api/members/${sub.handle}/record`);
  assert.equal(subRecord.created_by.id, agent.id);
  pass(`@${sub.handle} registered and managed by @${agent.handle}`);

  step("Orchestrator assigns a task to its sub-agent → the sub-agent is woken with as_agent");
  const subTask = await tool("create_task", { title: `Research for ${runId}`, assignee: sub.handle });
  const subHook = await waitForHook((c) => c.body?.event === "assigned" && c.body.task.key === subTask.key);
  assert.equal(subHook.body.as_agent, sub.handle);
  assert.match(subHook.body.instruction, /as_agent/);
  pass("webhook carries as_agent and tells the agent to pass it");

  step("Orchestrator acts as the sub-agent");
  await tool("get_task", { task: subTask.key, as_agent: sub.handle });
  await tool("post_update", { task: subTask.key, body: "Starting research.", as_agent: sub.handle });
  let subDetail = await alice("GET", `/api/tasks/${subTask.key}`);
  assert.equal(subDetail.runs[0].status, "active");
  assert.equal(subDetail.task.status, "in_progress");
  const subMember = (await alice("GET", "/api/members")).find((m) => m.handle === sub.handle);
  assert.ok(subDetail.entries.some((e) => e.type === "update" && e.author_id === subMember.id), "update authored by the sub-agent");
  pass("update is authored by the sub-agent and its run is active");

  step("Sub-agents can't register agents or wake anyone; strangers' agents are off-limits");
  await assert.rejects(tool("register_agent", { name: "Nested", as_agent: sub.handle }));
  await assert.rejects(tool("get_task", { task: subTask.key, as_agent: bobsAgent.handle }), /isn't one of your agents/);
  const hooksBefore = hookCalls.length;
  await tool("create_task", { title: "Sub tries to wake orchestrator", assignee: agent.handle, as_agent: sub.handle });
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(hookCalls.length, hooksBefore);
  pass("nested registration refused, other owners' agents refused, no wake from a sub-agent");

  step("Agent reports a failure → task flagged red (run failed) and in Needs you");
  await tool("end_run", { task: subTask.key, reason: "The search API returned 401.", outcome: "failed", as_agent: sub.handle });
  const listed = (await alice("GET", "/api/tasks")).find((t) => t.key === subTask.key);
  assert.equal(listed.run_status, "failed");
  subDetail = await alice("GET", `/api/tasks/${subTask.key}`);
  assert.match(subDetail.runs[0].last_error, /Failed: The search API returned 401/);
  const inbox3 = await alice("GET", "/api/inbox");
  assert.ok(inbox3.runs.some((r) => r.task_key === subTask.key));
  pass("run_status=failed on the task list; problem shows in Needs you");

  // ---------- workspace PM (dispatcher) ----------
  step("Admin picks a PM agent and sets the workspace webhook (the PM's)");
  const pmAgent = await alice("POST", "/api/members/agents", { name: `Grok PM ${runId}`, description: "Routes work to the right agent" });
  const writer = await alice("POST", "/api/members/agents", { name: `Writer ${runId}`, description: "Writes outreach copy" });
  await assert.rejects(bob2("PATCH", "/api/workspace", { pm_agent_id: pmAgent.id }), /403/);
  wsInfo = await alice("PATCH", "/api/workspace", { pm_agent_id: pmAgent.id });
  assert.equal(wsInfo.pm_agent_id, pmAgent.id);
  assert.equal(wsInfo.pm_triage, false, "triage is opt-in");
  await alice("PATCH", "/api/workspace/pm-webhook", { webhook_url: `http://localhost:${HOOK_PORT}/hook`, webhook_key: HOOK_KEY });
  const pmPing = await alice("POST", "/api/workspace/pm-webhook/test");
  assert.equal(pmPing.ok, true, JSON.stringify(pmPing));
  const writerPing = await alice("POST", `/api/members/${writer.id}/test-ping`);
  assert.equal(writerPing.ok, true, "an agent without a webhook is reachable through the PM");
  pass(`@${pmAgent.handle} is PM; its webhook answers; @${writer.handle} (no webhook) pings through it`);

  step("Assigning an agent with no webhook wakes the PM, told which agent it's for");
  const writeTask = await alice("POST", "/api/tasks", { title: `Draft outreach ${runId}`, assignee_id: writer.id });
  const routed = await waitForHook((c) => c.body?.event === "assigned" && c.body.task.key === writeTask.key);
  assert.equal(routed.body.as_agent, writer.handle);
  assert.equal(routed.body.routed_via, pmAgent.handle);
  assert.equal(routed.body.agent.description, "Writes outreach copy");
  pass("webhook went to the PM with as_agent + routed_via");

  step("An agent with its own webhook overrides the PM");
  const ownTask = await alice("POST", "/api/tasks", { title: `Own hook ${runId}`, assignee_id: agent.id });
  const direct = await waitForHook((c) => c.body?.event === "assigned" && c.body.task.key === ownTask.key);
  assert.equal(direct.body.routed_via, undefined);
  assert.equal(direct.body.as_agent, undefined);
  await tool("end_run", { task: ownTask.key, reason: "test" });
  pass("own webhook used directly");

  step("By default the PM stays idle for unassigned tasks");
  const idleBefore = hookCalls.length;
  const idle = await alice("POST", "/api/tasks", { title: `Idle ${runId}` });
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(hookCalls.length, idleBefore);
  assert.equal((await alice("GET", `/api/tasks/${idle.key}`)).runs.length, 0);
  pass("no wake-up without an assigned or mentioned agent");

  step("Per task: 'ask the PM to triage' on create, or later from the task");
  const asked = await alice("POST", "/api/tasks", { title: `Ask PM ${runId}`, triage: true });
  await waitForHook((c) => c.body?.event === "triage" && c.body.task.key === asked.key);
  await alice("POST", `/api/tasks/${idle.key}/triage`);
  await waitForHook((c) => c.body?.event === "triage" && c.body.task.key === idle.key);
  pass("triage on create (setting off) and the Ask-PM button both wake the PM");

  step("With triage on: new unassigned task → PM is woken; PM assigns it, which wakes that agent");
  await alice("PATCH", "/api/workspace", { pm_triage: true });
  const loose = await alice("POST", "/api/tasks", { title: `Unassigned ${runId}` });
  const triage = await waitForHook((c) => c.body?.event === "triage" && c.body.task.key === loose.key);
  assert.match(triage.body.instruction, /list_members/);
  const pmConn = await connect(aliceJar, { act_as: pmAgent.id });
  const pmTok = pmConn.tokens.access_token;
  assert.ok((await mcp("tools/list", {}, pmTok)).tools.find((t) => t.name === "get_task").inputSchema.properties.as_agent);
  await tool("get_task", { task: loose.key }, pmTok);
  await tool("update_task", { task: loose.key, assignee: writer.handle }, pmTok);
  const handed = await waitForHook((c) => c.body?.event === "assigned" && c.body.task.key === loose.key);
  assert.equal(handed.body.as_agent, writer.handle);
  let looseDetail = await alice("GET", `/api/tasks/${loose.key}`);
  const pmRun = looseDetail.runs.find((r) => r.agent_id === pmAgent.id);
  assert.equal(pmRun.trigger, "triage");
  assert.equal(pmRun.status, "ended", "PM's triage run ends when it hands the task over");
  pass("triage → PM assigned @writer → writer woken via PM; PM's run ended");

  step("PM works as the agent; work is recorded under that agent and can't wake others");
  await tool("post_update", { task: loose.key, body: "Drafting now.", as_agent: writer.handle }, pmTok);
  looseDetail = await alice("GET", `/api/tasks/${loose.key}`);
  assert.ok(looseDetail.entries.some((e) => e.type === "update" && e.author_id === writer.id));
  assert.equal(looseDetail.runs.find((r) => r.agent_id === writer.id).status, "active");
  const nHooks = hookCalls.length;
  await tool("create_task", { title: "Writer tries to wake", assignee: agent.handle, as_agent: writer.handle }, pmTok);
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(hookCalls.length, nHooks);
  await tool("complete_task", { task: loose.key, summary: "Done.", as_agent: writer.handle }, pmTok);
  wsInfo = await alice("PATCH", "/api/workspace", { pm_agent_id: null });
  assert.equal(wsInfo.pm_agent_id, null);
  pass("update authored by @writer; acting-as agent can't wake others; PM cleared");

  // ---------- feed & reports ----------
  step("Feed: completing a task posts automatically; agents share routine updates; people react");
  let feedPosts = await alice("GET", "/api/posts");
  const autoDone = feedPosts.find((x) => x.auto && x.kind === "done" && x.task?.key === task.key);
  assert.ok(autoDone, "complete_task produced a 'done' post");
  assert.match(autoDone.body, /5 competitors summarised/, "uses the agent's summary");
  const shared = await tool("share_update", {
    body: "Published today's blog: *Why agents need a PM*",
    kind: "done",
    link: "https://example.com/blog/agents-need-a-pm",
    routine: "Daily Blog",
  });
  assert.equal(shared.routine, "daily-blog");
  await alice("POST", "/api/posts", { body: "Waiting on design for the pricing page", kind: "blocker" });
  feedPosts = await alice("GET", "/api/posts?member_kind=agent&routine=daily-blog");
  assert.equal(feedPosts.length, 1);
  const blogPost = feedPosts[0];
  await alice("POST", `/api/posts/${blogPost.id}/reactions`, { emoji: "👍" });
  await bob2("POST", `/api/posts/${blogPost.id}/reactions`, { emoji: "👍" });
  await bob2("POST", `/api/posts/${blogPost.id}/reactions`, { emoji: "🎉" });
  await bob2("POST", `/api/posts/${blogPost.id}/reactions`, { emoji: "🎉" }); // toggles off
  const reacted = (await alice("GET", "/api/posts?routine=daily-blog"))[0];
  assert.deepEqual(reacted.reactions.map((r) => `${r.emoji}${r.count}`), ["👍2"]);
  const aliceBlocker = (await alice("GET", "/api/posts?kind=blocker"))[0];
  await assert.rejects(bob2("DELETE", `/api/posts/${aliceBlocker.id}`), /403/);
  const agentFeed = await tool("read_feed", { limit: 5 });
  assert.ok(agentFeed.some((x) => x.routine === "daily-blog" && x.reactions === "👍2"));
  pass("auto 'done' post with summary; routine post; reactions toggle; Bob can't delete Alice's post; agents can read the feed");

  step("Reports: per person/agent output, usefulness and routine consistency");
  const report = await alice("GET", "/api/reports?days=7");
  const agentRow = report.people.find((x) => x.id === agent.id);
  assert.ok(agentRow.tasks_done >= 1, "agent's completed task counted");
  assert.equal(agentRow.useful, 2, "two people found it useful");
  assert.ok(agentRow.updates >= 1);
  const routineRow = report.routines.find((r) => r.routine === "daily-blog");
  assert.equal(routineRow.author_id, agent.id);
  assert.equal(routineRow.days.length, 1);
  await assert.rejects(alice("GET", "/api/reports?days=12"), /400/);
  pass(`@${agent.handle}: ${agentRow.tasks_done} done, ${agentRow.useful} 👍, routine daily-blog on ${routineRow.days.length} day(s)`);

  // ---------- product ideas ----------
  step("Ideas: auto-labelled with a suggested owner, editable, convert to task");
  const ideaA = await alice("POST", "/api/ideas", {
    title: "Pay creators inside the app",
    body: "Merchants pay creators off-platform today. Let them record and send upfront and milestone payments, with status per creator.",
  });
  let labelled;
  for (let i = 0; i < 40; i++) {
    labelled = (await alice("GET", "/api/ideas")).ideas.find((x) => x.id === ideaA.id);
    if (labelled.labels_by !== "pending") break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.notEqual(labelled.labels_by, "pending", "labelling finished");
  assert.ok(labelled.labels.length >= 1 && labelled.labels.length <= 3, JSON.stringify(labelled.labels));
  const { labels: allowedLabels } = await alice("GET", "/api/ideas");
  assert.ok(labelled.labels.every((l) => allowedLabels.includes(l)));
  console.log(`    labels by ${labelled.labels_by}: ${labelled.labels.join(", ")}; owner ${labelled.suggested_owner_id ? "suggested" : "none"}`);
  const fromAgent = await tool("log_idea", { title: "Weekly 'what worked' email for brands", body: "Summarise top creators and content each week.", labels: ["marketing", "analytics"], source_url: "https://github.com/example/repo/issues/1" });
  assert.deepEqual(fromAgent.labels, ["marketing", "analytics"]);
  assert.ok((await tool("list_ideas", { label: "marketing" })).some((x) => x.id === fromAgent.id));
  const relabelled = await alice("PATCH", `/api/ideas/${ideaA.id}`, { labels: ["feature", "pricing", "nonsense"], status: "exploring" });
  assert.deepEqual(relabelled.labels, ["feature", "pricing"]);
  assert.equal(relabelled.labels_by, "human");
  await assert.rejects(bob2("DELETE", `/api/ideas/${ideaA.id}`), /403/);
  const conv = await alice("POST", `/api/ideas/${ideaA.id}/convert`, { assign: false });
  const ideaTask = await alice("GET", `/api/tasks/${conv.task_key}`);
  assert.equal(ideaTask.task.title, "Pay creators inside the app");
  assert.match(ideaTask.task.description, /Created from a product idea/);
  assert.equal(conv.idea.status, "converted");
  assert.equal(conv.idea.task.key, conv.task_key);
  await assert.rejects(alice("POST", `/api/ideas/${ideaA.id}/convert`, {}), /409/);
  await alice("DELETE", `/api/ideas/${fromAgent.id}`);
  pass(`labels within the fixed set; agent idea kept its labels; converted to ${conv.task_key}; Bob can't delete Alice's idea`);

  // ---------- customers & feature requests ----------
  step("Feature requests: many customers per idea, one count per customer, carried into the task");
  const fr1 = await alice("POST", "/api/feature-requests", { customer_name: `Glow Co ${runId}`, title: `Bulk approve gift requests ${runId}`, note: "We get 50 a day" });
  assert.equal(fr1.customer_created, true);
  assert.equal(fr1.idea_created, true);
  const glow = fr1.customer;
  await alice("PATCH", `/api/customers/${glow.id}`, { plan: "Growth", mrr: 99, domain: "https://glowco.myshopify.com/admin" });
  const fr2 = await bob2("POST", "/api/feature-requests", { customer_name: `Lumen ${runId}`, idea_id: fr1.idea.id, note: "Blocking our launch" });
  assert.equal(fr2.idea.request_count, 2);
  const askedAgain = await alice("POST", `/api/ideas/${fr1.idea.id}/requests`, { customer_id: glow.id, note: "Asked again on a call" });
  assert.equal(askedAgain.already, true);
  assert.equal(askedAgain.idea.request_count, 2, "same customer doesn't double count");
  assert.equal(askedAgain.idea.request_mrr, 99);
  await assert.rejects(alice("POST", "/api/customers", { name: `glow co ${runId}` }), /409/);
  const viaAgent = await tool("log_feature_request", { customer: `Glow Co ${runId}`, title: `Instagram story tracking ${runId}`, note: "from support chat" });
  assert.equal(viaAgent.customer_created, false, "existing customer reused (case-insensitive)");
  const glowDetail = await alice("GET", `/api/customers/${glow.id}`);
  assert.equal(glowDetail.domain, "glowco.myshopify.com");
  assert.equal(glowDetail.requests.length, 2);
  assert.ok(glowDetail.requests.some((r) => r.note === "Asked again on a call"));
  const frListed = (await alice("GET", "/api/ideas")).ideas.find((i) => i.id === fr1.idea.id);
  assert.deepEqual(frListed.requested_by.map((c) => c.name).sort(), [`Glow Co ${runId}`, `Lumen ${runId}`]);
  const frConv = await alice("POST", `/api/ideas/${fr1.idea.id}/convert`, {});
  const frTask = await alice("GET", `/api/tasks/${frConv.task_key}`);
  assert.match(frTask.task.description, /Requested by 2 customers/);
  assert.match(frTask.task.description, /Blocking our launch/);
  await alice("DELETE", `/api/customers/${glow.id}`);
  assert.equal((await alice("GET", `/api/ideas/${fr1.idea.id}`)).request_count, 1, "deleting a customer removes their requests");
  pass("2 customers on one idea (no double count), agent reused the customer, task lists who asked, delete cascades");

  // ---------- views & closing ----------
  step("Saved views are shared; only their creator or an admin can delete them");
  const view = await bob2("POST", "/api/views", { name: "Bob's urgent", config: { priorities: ["urgent"], hideDone: true, layout: "board" } });
  assert.deepEqual(view.config.priorities, ["urgent"]);
  assert.ok((await alice("GET", "/api/views")).some((v) => v.id === view.id), "visible to everyone");
  const renamed = await bob2("PATCH", `/api/views/${view.id}`, { name: "Urgent", config: { priorities: ["urgent", "high"] } });
  assert.equal(renamed.name, "Urgent");
  const aliceView = await alice("POST", "/api/views", { name: "Alice's", config: {} });
  await assert.rejects(bob2("DELETE", `/api/views/${aliceView.id}`), /403/);
  await alice("DELETE", `/api/views/${view.id}`);
  assert.ok(!(await alice("GET", "/api/views")).some((v) => v.id === view.id));
  pass("create, share, rename; Bob can't delete Alice's view; admin can delete Bob's");

  step("A person marking a task done closes the agent's open run");
  const closeTask = await alice("POST", "/api/tasks", { title: `Close me ${runId}`, assignee_id: agent.id });
  await waitForHook((c) => c.body?.event === "assigned" && c.body.task.key === closeTask.key);
  await alice("PATCH", `/api/tasks/${closeTask.key}`, { status: "done" });
  const closed = await alice("GET", `/api/tasks/${closeTask.key}`);
  assert.ok(closed.runs.every((r) => r.status === "ended"), JSON.stringify(closed.runs.map((r) => r.status)));
  assert.equal((await alice("GET", "/api/tasks")).find((t) => t.key === closeTask.key).run_status, null);
  pass("run ended; task no longer shows as Starting/Working");

  // ---------- deleting ----------
  step("Deleting: people delete their own things, admins delete anything, only admins delete tasks");
  const dt = await alice("POST", "/api/tasks", { title: `Delete me ${runId}` });
  const note = await alice("POST", `/api/tasks/${dt.key}/notes`, { title: "Scratch", content: "x" });
  const list = await alice("POST", `/api/tasks/${dt.key}/checklists`, { title: "Steps", items: ["a", "b"] });
  const aliceMsg = await alice("POST", `/api/tasks/${dt.key}/entries`, { body: "alice says hi" });
  const bobMsg = await bob2("POST", `/api/tasks/${dt.key}/entries`, { body: "bob says hi" });
  const fd2 = new FormData();
  fd2.append("file", new Blob(["hello"], { type: "text/plain" }), "hello.txt");
  const upRes = await fetch(`${BASE}/api/tasks/${dt.key}/attachments`, { method: "POST", headers: { Cookie: cookieHeader(aliceJar) }, body: fd2 });
  assert.ok(upRes.ok, `upload ${upRes.status}`);
  let dd = await alice("GET", `/api/tasks/${dt.key}`);
  const fileId = dd.attachments[0].id;

  await assert.rejects(bob2("DELETE", `/api/notes/${note.id}`), /403/);
  await assert.rejects(bob2("DELETE", `/api/entries/${aliceMsg.id}`), /403/);
  await assert.rejects(bob2("DELETE", `/api/tasks/${dt.key}`), /403/);
  await bob2("DELETE", `/api/entries/${bobMsg.id}`);
  pass("Bob can delete his own message but not Alice's note, message or the task");

  await alice("DELETE", `/api/notes/${note.id}`);
  await alice("DELETE", `/api/checklists/${list.id}`);
  await alice("DELETE", `/api/attachments/${fileId}`);
  await alice("DELETE", `/api/entries/${aliceMsg.id}`);
  dd = await alice("GET", `/api/tasks/${dt.key}`);
  assert.equal(dd.notes.length, 0);
  assert.equal(dd.checklists.length, 0);
  assert.equal(dd.attachments.length, 0);
  assert.ok(dd.entries.filter((e) => e.data.deleted && e.body === "").length >= 2, "messages blanked and marked deleted");
  assert.ok(dd.entries.some((e) => e.type === "attachment_added" && e.data.deleted));
  const gone = await fetch(`${BASE}/api/attachments/${fileId}`, { headers: { Cookie: cookieHeader(aliceJar) } });
  assert.equal(gone.status, 404);
  pass("admin deleted note, checklist, file (storage too) and a message");

  await alice("DELETE", `/api/tasks/${dt.key}`);
  await assert.rejects(alice("GET", `/api/tasks/${dt.key}`), /404/);
  assert.ok(!(await alice("GET", "/api/tasks")).some((t) => t.key === dt.key));
  // A task with agent runs, notes and a thread (the earlier agent task) deletes cleanly too.
  await alice("DELETE", `/api/tasks/${task.key}`);
  await assert.rejects(alice("GET", `/api/tasks/${task.key}`), /404/);
  pass("admin deleted tasks, including one with agent runs, files and a full thread");

  step("Policies: folders and docs; required policies gate agent work until the latest version is read");
  const ops = await alice("POST", "/api/policies", { kind: "folder", title: `Ops ${runId}` });
  const sop = await alice("POST", "/api/policies", { kind: "doc", title: "Blog SOP", parent_id: ops.id, content: "1. Draft in Docs\n2. Get review" });
  await assert.rejects(alice("PATCH", `/api/policies/${ops.id}`, { parent_id: sop.id }), /folder/i);
  const subFolder = await alice("POST", "/api/policies", { kind: "folder", title: "Sub", parent_id: ops.id });
  await assert.rejects(alice("PATCH", `/api/policies/${ops.id}`, { parent_id: subFolder.id }), /inside itself/);
  await alice("PATCH", `/api/policies/${sop.id}`, { required: true, summary: "Before publishing any blog post" });
  const pt = await alice("POST", "/api/tasks", { title: `Policy gated ${runId}` });
  await assert.rejects(tool("post_update", { task: pt.key, body: "starting" }), /read the workspace policies/);
  const gt = await tool("get_task", { task: pt.key });
  const listedPol = gt.policies.find((x) => x.id === sop.id);
  assert.ok(listedPol && listedPol.required && !listedPol.read_latest && listedPol.path === `Ops ${runId} / Blog SOP`);
  assert.ok((await tool("list_policies", { query: "draft in docs" })).some((x) => x.id === sop.id && x.applies_to_you));
  const read1 = await tool("get_policy", { policy: `Ops ${runId} / Blog SOP` });
  assert.ok(read1.content.includes("Get review") && read1.version === 1);
  await tool("post_update", { task: pt.key, body: "read the SOP, starting" });
  await alice("PATCH", `/api/policies/${sop.id}`, { content: "1. Draft in Docs\n2. Get review\n3. Add alt text" });
  await assert.rejects(tool("post_update", { task: pt.key, body: "more" }), /Blog SOP/);
  assert.equal((await tool("get_policy", { policy: sop.id })).version, 2);
  await tool("post_update", { task: pt.key, body: "synced with v2" });
  const sopDetail = await alice("GET", `/api/policies/${sop.id}`);
  assert.ok(sopDetail.revisions.some((r) => r.version === 1) && sopDetail.reads.some((r) => r.member_id === agent.id && r.version === 2));
  // Scoped to another agent → no longer applies to this one.
  await alice("PATCH", `/api/policies/${sop.id}`, { audience: "agents", agent_ids: [] });
  assert.ok(!(await tool("get_task", { task: pt.key })).policies.some((x) => x.id === sop.id));
  await alice("PATCH", `/api/policies/${sop.id}`, { audience: "all", content: "v3 text" });
  await alice("PATCH", `/api/tasks/${pt.key}`, { assignee_id: agent.id });
  const polHook = await waitForHook((c) => c.body?.task?.key === pt.key && c.body.policies);
  assert.ok(polHook.body.policies.some((x) => x.id === sop.id && x.required && !x.read_latest) && /must read/.test(polHook.body.instruction));
  await assert.rejects(bob2("DELETE", `/api/policies/${ops.id}`), /403/);
  const removedPol = await alice("DELETE", `/api/policies/${ops.id}`);
  assert.equal(removedPol.removed, 3);
  await tool("post_update", { task: pt.key, body: "policy gone, not gated" });
  await alice("PATCH", `/api/tasks/${pt.key}`, { status: "done" });
  pass("tree + cycle guard, gating until read, re-read after edits, revisions, scoping, webhook lists policies, folder delete cascades");

  step("Agents write policies over MCP (folders created from the path) but can't make them required");
  const made = await tool("create_policy", { title: "Release checklist", folder: `Product ${runId} / Engineering`, content: "1. Tag\n2. Ship", summary: "Before any release" });
  assert.ok(made.created && made.path === `Product ${runId} / Engineering / Release checklist`);
  await assert.rejects(tool("create_policy", { title: "release checklist", folder: `Product ${runId} / Engineering`, content: "dup" }), /already exists/);
  const upd = await tool("update_policy", { policy: made.id, content: "1. Tag\n2. Ship\n3. Announce" });
  assert.equal(upd.version, 2);
  const madeTree = await alice("GET", "/api/policies");
  assert.equal(madeTree.filter((x) => x.kind === "folder" && [`Product ${runId}`, "Engineering"].includes(x.title)).length, 2);
  await alice("PATCH", `/api/policies/${made.id}`, { required: true });
  assert.equal((await tool("get_task", { task: (await alice("POST", "/api/tasks", { title: `pol ${runId}` })).key })).policies.find((x) => x.id === made.id).read_latest, true, "the writer has read its own version");
  await alice("DELETE", `/api/policies/${madeTree.find((x) => x.title === `Product ${runId}`).id}`);
  pass("create_policy builds the folder path, refuses duplicates, update_policy versions it");

  step("Ideas: backlog / live / archived, pins, bulk actions; requests count repeat asks and follow the idea's stage");
  const iA = await alice("POST", "/api/ideas", { title: `Stage A ${runId}`, labels: ["feature"] });
  const iB = await alice("POST", "/api/ideas", { title: `Stage B ${runId}`, labels: ["feature"] });
  const cust1 = await alice("POST", "/api/customers", { name: `Acme ${runId}` });
  const cust2 = await alice("POST", "/api/customers", { name: `Globex ${runId}` });
  await alice("POST", "/api/feature-requests", { customer_id: cust1.id, idea_id: iA.id, note: "need it" });
  const again2 = await alice("POST", "/api/feature-requests", { customer_id: cust1.id, idea_id: iA.id, note: "asked again on a call" });
  assert.equal(again2.already_requested, true);
  await alice("POST", "/api/feature-requests", { customer_id: cust2.id, idea_id: iA.id });
  let ia = await alice("GET", `/api/ideas/${iA.id}`);
  assert.equal(ia.request_count, 2);
  assert.equal(ia.request_times, 3, "one customer asked twice");
  assert.ok(ia.requests.every((r) => r.status === "open") && ia.stage === "backlog");
  await alice("POST", "/api/ideas/bulk", { ids: [iA.id, iB.id], action: "pin" });
  assert.ok((await alice("GET", "/api/ideas")).ideas.filter((i) => [iA.id, iB.id].includes(i.id)).every((i) => i.pinned_at));
  const acmeReq = ia.requests.find((r) => r.customer_id === cust1.id);
  await alice("PATCH", `/api/idea-requests/${acmeReq.id}`, { status: "archived" });
  await alice("PATCH", `/api/ideas/${iA.id}`, { stage: "live" });
  ia = await alice("GET", `/api/ideas/${iA.id}`);
  assert.equal(ia.stage, "live");
  assert.equal(ia.requests.find((r) => r.customer_id === cust2.id).status, "live", "open requests go live with the idea");
  assert.equal(ia.requests.find((r) => r.customer_id === cust1.id).status, "archived", "requests set by hand stay put");
  assert.equal(ia.request_count, 1, "archived requests don't count");
  // Edit a request: times, note, pin; move it to another idea.
  await alice("PATCH", `/api/idea-requests/${acmeReq.id}`, { times: 5, note: "edited", pinned: true, status: "open" });
  const moved = await alice("PATCH", `/api/idea-requests/${acmeReq.id}`, { idea_id: iB.id });
  assert.equal(moved.idea_id, iB.id);
  const allReqs = await alice("GET", "/api/idea-requests");
  const movedRow = allReqs.find((r) => r.id === acmeReq.id);
  assert.ok(movedRow && movedRow.times === 5 && movedRow.pinned_at && movedRow.idea_title === `Stage B ${runId}`);
  // Moving onto an idea the customer already asked for merges the two.
  const g = (await alice("GET", `/api/ideas/${iA.id}`)).requests.find((r) => r.customer_id === cust2.id);
  await alice("POST", "/api/feature-requests", { customer_id: cust2.id, idea_id: iB.id, note: "for B too" });
  const merged = await alice("PATCH", `/api/idea-requests/${g.id}`, { idea_id: iB.id });
  assert.ok(merged.merged && merged.times === 2);
  // A task made from an idea going done makes it live.
  const convB = await alice("POST", `/api/ideas/${iB.id}/convert`, {});
  await alice("PATCH", `/api/tasks/${convB.task_key}`, { status: "done" });
  const ib = await alice("GET", `/api/ideas/${iB.id}`);
  assert.ok(ib.stage === "live" && ib.live_at);
  assert.equal(ib.requests.find((r) => r.customer_id === cust1.id).status, "live");
  // Bulk archive, then requests can be deleted by whoever logged them (not by others).
  await alice("POST", "/api/ideas/bulk", { ids: [iA.id, iB.id], action: "archived" });
  assert.ok((await alice("GET", "/api/ideas")).ideas.filter((i) => [iA.id, iB.id].includes(i.id)).every((i) => i.stage === "archived"));
  await assert.rejects(bob2("DELETE", `/api/idea-requests/${acmeReq.id}`), /403/);
  await alice("DELETE", `/api/idea-requests/${acmeReq.id}`);
  await assert.rejects(bob2("POST", "/api/ideas/bulk", { ids: [iA.id], action: "delete" }), /403/);
  const bulkDel = await alice("POST", "/api/ideas/bulk", { ids: [iA.id, iB.id], action: "delete" });
  assert.equal(bulkDel.count, 2);
  assert.ok(!(await alice("GET", "/api/ideas")).ideas.some((i) => [iA.id, iB.id].includes(i.id)));
  const listedLive = await tool("list_ideas", { stage: "live" });
  assert.ok(Array.isArray(listedLive));
  pass("stages + cascade, repeat asks counted, edit/move/merge/pin requests, task done → live, bulk pin/archive/delete with permissions");

  step("Tools directory: paste a site → summary and tags; the PM agent researches it; agents write back");
  await alice("PATCH", "/api/workspace", { pm_agent_id: pmAgent.id });
  const toolUrl = `http://127.0.0.1:${HOOK_PORT}/site?utm_source=x`;
  const tl = await alice("POST", "/api/tools", { url: toolUrl });
  assert.equal(tl.url, `http://127.0.0.1:${HOOK_PORT}/site`, "tracking params dropped");
  await assert.rejects(alice("POST", "/api/tools", { url: `127.0.0.1:${HOOK_PORT}/site` }), /409|already/);
  let tlNow;
  for (let i = 0; i < 40; i++) {
    tlNow = (await alice("GET", "/api/tools")).find((x) => x.id === tl.id);
    if (tlNow.enriched_by !== "pending" && tlNow.research_task) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.ok(["ai", "failed"].includes(tlNow.enriched_by) || tlNow.enriched_by === "ai", tlNow.enriched_by);
  assert.ok(/Quillpad/.test(tlNow.name) && /notebook/i.test(tlNow.summary), JSON.stringify(tlNow));
  assert.ok(tlNow.icon_url.endsWith("/fav.svg"));
  assert.ok(tlNow.research_task, "the PM agent got a research task");
  const researchHook = await waitForHook((c) => c.body?.task?.key === tlNow.research_task.key);
  assert.ok(researchHook.body.task.title.startsWith("Research tool:"));
  const wrote = await tool("update_tool", { tool: tl.url, summary: "Shared notebook for product teams.", tags: ["Docs", "#Collaboration", "docs"], pricing: "Freemium" });
  assert.deepEqual(wrote.tags, ["docs", "collaboration"]);
  assert.equal(wrote.enriched_by, "agent");
  assert.ok((await tool("list_tools", { tag: "docs" })).some((x) => x.id === tl.id));
  assert.ok(!(await tool("list_tools", { needs_research: true })).some((x) => x.id === tl.id));
  await assert.rejects(alice("POST", `/api/tools/${tl.id}/research`), /409|already/);
  await assert.rejects(bob2("DELETE", `/api/tools/${tl.id}`), /403/);
  await alice("DELETE", `/api/tools/${tl.id}`);
  await alice("PATCH", "/api/workspace", { pm_agent_id: null });
  pass("site read (title, description, icon), duplicate refused, research task woke the PM, update_tool normalised tags");

  step("Favorite views: each person picks which views show in their sidebar");
  const fv = await alice("POST", "/api/views", { name: `Fav ${runId}`, config: { hideDone: true } });
  assert.equal((await alice("GET", "/api/views")).find((v) => v.id === fv.id).favorite, true, "creator's new view is starred");
  assert.equal((await bob2("GET", "/api/views")).find((v) => v.id === fv.id).favorite, false);
  await bob2("PUT", `/api/views/${fv.id}/favorite`);
  assert.equal((await bob2("GET", "/api/views")).find((v) => v.id === fv.id).favorite, true);
  await alice("DELETE", `/api/views/${fv.id}/favorite`);
  assert.equal((await alice("GET", "/api/views")).find((v) => v.id === fv.id).favorite, false);
  await alice("DELETE", `/api/views/${fv.id}`);
  pass("stars are per person; deleting a starred view works");

  step("Share links: hand a task to an outside AI tool; reply links post back without waking agents");
  const st = await alice("POST", "/api/tasks", { title: `Shareable ${runId}`, description: "Write the **launch** post." });
  await alice("POST", `/api/tasks/${st.key}/entries`, { body: "Keep it under 300 words" });
  const ro = await alice("POST", `/api/tasks/${st.key}/shares`, { mode: "read", expires_in_days: 1, label: "Reader" });
  const rw = await alice("POST", `/api/tasks/${st.key}/shares`, { mode: "reply", expires_in_days: 0, label: "Claude" });
  assert.ok(ro.url.includes("/share/") && rw.expires_at === null);
  const md = await fetch(`${BASE}/share/${ro.url.split("/share/")[1]}.md`).then((r) => r.text());
  assert.ok(md.includes(`# ${st.key}: Shareable ${runId}`) && md.includes("Write the **launch** post.") && md.includes("Keep it under 300 words"));
  assert.ok(!md.includes("Report back"), "read-only link has no reply instructions");
  const html = await fetch(`${BASE}${new URL(ro.url).pathname}`, { headers: { Accept: "text/html" } });
  assert.ok(html.headers.get("content-type").includes("text/html") && (await html.text()).includes("Copy for AI"));
  const rwPath = new URL(rw.url).pathname;
  assert.ok((await fetch(`${BASE}${rwPath}`).then((r) => r.text())).includes("Report back"), "reply link explains how to post back");
  const roPost = await fetch(`${BASE}${new URL(ro.url).pathname}/messages`, { method: "POST", body: "hi" });
  assert.equal(roPost.status, 403);
  const shareHooksBefore = hookCalls.length;
  const posted = await fetch(`${BASE}${rwPath}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body: `Draft done. @${agent.handle} please review`, author: "Claude Code" }),
  });
  assert.equal(posted.status, 201);
  const plain = await fetch(`${BASE}${rwPath}/messages`, { method: "POST", body: "Plain text works too" });
  assert.equal(plain.status, 201);
  const sd = await alice("GET", `/api/tasks/${st.key}`);
  const ext = sd.entries.find((e) => e.body.startsWith("Draft done."));
  assert.ok(ext && ext.type === "update" && ext.data.via_share === "Claude" && ext.data.author_name === "Claude Code");
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(hookCalls.length, shareHooksBefore, "external messages don't wake agents");
  const listedShares = await alice("GET", `/api/tasks/${st.key}/shares`);
  assert.equal(listedShares.length, 2);
  await assert.rejects(bob2("DELETE", `/api/shares/${rw.id}`), /403/);
  await alice("DELETE", `/api/shares/${rw.id}`);
  assert.equal((await fetch(`${BASE}${rwPath}`)).status, 404);
  assert.equal((await fetch(`${BASE}${rwPath}/messages`, { method: "POST", body: "late" })).status, 404);
  await alice("DELETE", `/api/tasks/${st.key}`);
  assert.equal((await fetch(`${BASE}${new URL(ro.url).pathname}`)).status, 404);
  pass("read link serves Markdown/HTML, reply link posts back as External, revoked and deleted links stop working");

  step("Dependencies: blocked-by links, no loops, the dependent task's agent wakes when its blockers are done");
  const blocker = await alice("POST", "/api/tasks", { title: `Design schema ${runId}`, triage: false });
  const dependent = await alice("POST", "/api/tasks", { title: `Build API ${runId}`, assignee_id: agent.id, blocked_by: [blocker.key] });
  await waitForHook((c) => c.body?.event === "assigned" && c.body.task.key === dependent.key);
  await tool("end_run", { task: dependent.key, reason: "waiting on the schema" });
  let depD = await alice("GET", `/api/tasks/${dependent.key}`);
  assert.deepEqual(depD.dependencies.blocked_by.map((t) => t.key), [blocker.key]);
  assert.equal(depD.dependencies.open_blockers, 1);
  assert.equal(depD.task.open_blockers, 1);
  assert.deepEqual((await alice("GET", `/api/tasks/${blocker.key}`)).dependencies.blocking.map((t) => t.key), [dependent.key]);
  await assert.rejects(alice("POST", `/api/tasks/${blocker.key}/dependencies`, { blocked_by: dependent.key }), /409/);
  await assert.rejects(alice("POST", `/api/tasks/${blocker.key}/dependencies`, { blocked_by: blocker.key }), /400/);
  // A dependent task created from the blocker's page ("blocks" side).
  const followOn = await alice("POST", "/api/tasks", { title: `Write docs ${runId}`, blocked_by: [blocker.key], triage: false });
  assert.equal((await alice("GET", `/api/tasks/${blocker.key}`)).dependencies.blocking.length, 2);
  // Agents see dependencies and can add them.
  const viaMcp = await tool("get_task", { task: dependent.key });
  assert.ok(viaMcp.dependencies.note.includes("Blocked"));
  const extra = await alice("POST", "/api/tasks", { title: `Pick a DB ${runId}`, triage: false });
  await tool("set_dependency", { task: dependent.key, blocked_by: extra.key });
  assert.equal((await alice("GET", `/api/tasks/${dependent.key}`)).dependencies.open_blockers, 2);
  const depHooks = hookCalls.length;
  await alice("PATCH", `/api/tasks/${blocker.key}`, { status: "done" });
  await new Promise((r) => setTimeout(r, 1200));
  assert.ok(!hookCalls.slice(depHooks).some((c) => c.body?.task?.key === dependent.key), "still blocked by the other task: no wake");
  await alice("PATCH", `/api/tasks/${extra.key}`, { status: "canceled" });
  const unblockedWake = await waitForHook((c) => c.body?.event === "followup" && c.body.task.key === dependent.key);
  assert.ok(unblockedWake);
  depD = await alice("GET", `/api/tasks/${dependent.key}`);
  assert.equal(depD.dependencies.open_blockers, 0);
  assert.ok(depD.entries.some((e) => e.data.event === "unblocked"));
  await tool("end_run", { task: dependent.key, reason: "test" });
  await alice("DELETE", `/api/tasks/${dependent.key}/dependencies?blocked_by=${extra.key}`);
  assert.equal((await alice("GET", `/api/tasks/${dependent.key}`)).dependencies.blocked_by.length, 1);
  pass("links both ways, loops rejected, agent woken only when the last blocker finishes, links removable");

  step("Reactions on replies: 👍 acknowledges; agents see who acknowledged and can acknowledge too");
  const fb = await tool("post_update", { task: dependent.key, body: "Schema migration is drafted, please check" });
  await alice("POST", `/api/entries/${fb.id}/reactions`, { emoji: "👍" });
  await alice("POST", `/api/entries/${fb.id}/reactions`, { emoji: "🎉" });
  await alice("POST", `/api/entries/${fb.id}/reactions`, { emoji: "🎉" }); // toggles off
  let fe = (await alice("GET", `/api/tasks/${dependent.key}`)).entries.find((e) => e.id === fb.id);
  assert.deepEqual(fe.reactions.map((r) => [r.emoji, r.count]), [["👍", 1]]);
  const seen = (await tool("get_task", { task: dependent.key })).thread.find((e) => e.id === fb.id);
  assert.deepEqual(seen.acknowledged_by, ["Alice"]);
  const humanNote = await alice("POST", `/api/tasks/${dependent.key}/entries`, { body: "Use UUIDs for ids" });
  const ackHooks = hookCalls.length;
  await tool("react", { entry_id: humanNote.id });
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(hookCalls.length, ackHooks, "reactions never wake anyone");
  fe = (await alice("GET", `/api/tasks/${dependent.key}`)).entries.find((e) => e.id === humanNote.id);
  assert.equal(fe.reactions[0].emoji, "👍");
  await assert.rejects(alice("POST", `/api/entries/${fb.id}/reactions`, { emoji: "🚀" }), /400/);
  pass("👍 shows as acknowledged for people and agents; unknown emoji rejected");

  step("Share link previews: title and description in the page's meta tags");
  const sharePrev = await alice("POST", `/api/tasks/${dependent.key}/shares`, { mode: "read", expires_in_days: 1 });
  await alice("PATCH", `/api/tasks/${dependent.key}`, { description: "## Goal\n\nShip the **orders** API with [docs](https://example.com)." });
  const prevPath = new URL(sharePrev.url).pathname;
  const usesBefore = (await alice("GET", `/api/tasks/${dependent.key}/shares`))[0].use_count;
  const bot = await fetch(`${BASE}${prevPath}`, { headers: { "User-Agent": "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)" } });
  const botHtml = await bot.text();
  assert.ok(bot.headers.get("content-type").includes("text/html"), "preview bots get HTML even without Accept: text/html");
  assert.ok(botHtml.includes(`<meta property="og:title" content="${dependent.key}: Build API ${runId}">`));
  assert.ok(botHtml.includes(`<meta property="og:description" content="Goal Ship the orders API with docs.">`), botHtml.match(/og:description[^>]*/)?.[0]);
  assert.ok(botHtml.includes('name="twitter:card"'));
  assert.equal((await alice("GET", `/api/tasks/${dependent.key}/shares`))[0].use_count, usesBefore, "previews don't count as uses");
  const shareMd = await fetch(`${BASE}${prevPath}.md`).then((r) => r.text());
  assert.ok(shareMd.includes("## Dependencies") && shareMd.includes(`- ${blocker.key}: Design schema ${runId} (Done)`));
  assert.ok(shareMd.includes("👍 Acknowledged by Alice"));
  const wa = { "User-Agent": "WhatsApp/2.23.20.0 A" };
  const appLink = `${BASE}/t/${dependent.key}`;
  let waHtml = await fetch(appLink, { headers: wa }).then((r) => r.text());
  assert.ok(!waHtml.includes(`Build API ${runId}`), "app links show nothing by default");
  await assert.rejects(bob2("PATCH", "/api/workspace", { link_previews: "full" }), /403/);
  await alice("PATCH", "/api/workspace", { link_previews: "title" });
  waHtml = await fetch(appLink, { headers: wa }).then((r) => r.text());
  assert.ok(waHtml.includes(`<title>${dependent.key}: Build API ${runId}</title>`), waHtml.slice(0, 600));
  assert.ok(waHtml.includes(`og:title" content="${dependent.key}: Build API ${runId}"`) && !waHtml.includes("orders API"));
  await alice("PATCH", "/api/workspace", { link_previews: "full" });
  waHtml = await fetch(appLink, { headers: wa }).then((r) => r.text());
  assert.ok(waHtml.includes('og:description" content="Goal Ship the orders API with docs."'));
  const person = await fetch(appLink).then((r) => r.text());
  assert.ok(!person.includes(`Build API ${runId}`), "people get the normal app page");
  await alice("PATCH", "/api/workspace", { link_previews: "off" });
  pass("app task links preview the title (and description) only when an admin turns it on");
  await alice("DELETE", `/api/tasks/${followOn.key}`);
  assert.equal((await alice("GET", `/api/tasks/${blocker.key}`)).dependencies.blocking.length, 1, "deleting a task drops its links");
  pass("Slack/WhatsApp-style previews show the task title and description; shared Markdown lists dependencies and acknowledgements");

  step("Archiving a project archives its tasks (API and MCP)");
  const arch = await alice("POST", "/api/projects", { name: `Archive me ${runId}` });
  const archA = await alice("POST", "/api/tasks", { title: `Arch A ${runId}`, project_id: arch.id });
  const archB = await alice("POST", "/api/tasks", { title: `Arch B ${runId}`, project_id: arch.id, status: "done" });
  const archOut = await alice("POST", `/api/projects/${arch.id}/archive`, {});
  assert.equal(archOut.status, "archived");
  assert.equal(archOut.tasks_changed, 2);
  const archListed = await alice("GET", `/api/tasks?q=${encodeURIComponent(`Arch A ${runId}`)}`);
  assert.equal(archListed.length, 0, "archived tasks leave task lists and search");
  assert.equal((await alice("GET", `/api/tasks?q=${encodeURIComponent(`Arch A ${runId}`)}&archived=include`)).length, 1);
  const inProject = await alice("GET", `/api/tasks?project=${arch.id}`);
  assert.equal(inProject.length, 2, "the archived project's own page still lists them");
  assert.ok(inProject.every((t) => t.archived_at));
  assert.ok((await alice("GET", `/api/tasks/${archA.key}`)).task.archived_at);
  await assert.rejects(alice("POST", "/api/tasks", { title: "nope", project_id: arch.id }), /archived/);
  assert.equal((await tool("search_tasks", { query: `Arch A ${runId}` })).length, 0);
  assert.equal((await tool("search_tasks", { query: `Arch A ${runId}`, include_archived: true })).length, 1);
  const restored = await tool("archive_project", { project: `Archive me ${runId}`, archived: false });
  assert.equal(restored.project.status, "active");
  assert.equal(restored.tasks_changed, 2);
  assert.equal((await alice("GET", `/api/tasks?q=${encodeURIComponent(`Arch A ${runId}`)}`)).length, 1, "restore brings tasks back");
  assert.equal((await alice("GET", `/api/tasks/${archB.key}`)).task.status, "done", "status untouched");
  const archViaMcp = await tool("archive_project", { project: arch.id });
  assert.equal(archViaMcp.project.status, "archived");
  await alice("PATCH", `/api/tasks/${archA.key}`, { project_id: null });
  assert.equal((await alice("GET", `/api/tasks/${archA.key}`)).task.archived_at, null, "moving out of an archived project un-archives");
  await alice("POST", `/api/projects/${arch.id}/restore`, {});
  pass("project archive cascades to its tasks, restore brings them back, MCP archive_project works");

  step("Personal API keys and wider MCP coverage");
  const k_keyRes = await alice("POST", "/api/keys", { name: `script ${runId}` });
  assert.ok(k_keyRes.key.startsWith("apm_") && k_keyRes.prefix === k_keyRes.key.slice(0, 8));
  const k_viaKey = (method, path, body) =>
    fetch(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${k_keyRes.key}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  const k_keyTasks = await k_viaKey("GET", "/api/tasks?limit=1");
  assert.equal(k_keyTasks.status, 200);
  const k_keyMade = await (await k_viaKey("POST", "/api/tasks", { title: `Made by key ${runId}` })).json();
  assert.equal(k_keyMade.created_by, (await alice("GET", "/api/me")).member.id, "a key acts as its owner");
  assert.equal((await k_viaKey("POST", "/api/keys", { name: "minted" })).status, 403, "a key can't mint keys");
  assert.equal((await k_viaKey("GET", "/api/keys")).status, 403);
  assert.equal((await fetch(`${BASE}/api/tasks`, { headers: { Authorization: "Bearer apm_not_a_real_key_xxxxxxxxxxxx" } })).status, 401);
  const k_myKeys = await alice("GET", "/api/keys");
  assert.ok(k_myKeys.some((k) => k.id === k_keyRes.id && k.last_used_at), "last use is recorded");
  assert.ok(!JSON.stringify(k_myKeys).includes(k_keyRes.key), "keys are never listed in full");
  await assert.rejects(bob2("DELETE", `/api/keys/${k_keyRes.id}`), /403/);
  await alice("DELETE", `/api/keys/${k_keyRes.id}`);
  assert.equal((await k_viaKey("GET", "/api/tasks?limit=1")).status, 401, "revoked keys stop working");
  pass("API keys act as their owner, can't mint keys, record last use, and stop working when revoked");

  const k_mcpProj = await tool("create_project", { name: `MCP project ${runId}`, description: "made over MCP" });
  assert.equal(k_mcpProj.name, `MCP project ${runId}`);
  const k_projRenamed = await tool("update_project", { project: `MCP project ${runId}`, name: `MCP renamed ${runId}` });
  assert.equal(k_projRenamed.name, `MCP renamed ${runId}`);
  const k_cust = await tool("create_customer", { name: `Cust ${runId}`, plan: "Pro", mrr: 500 });
  assert.equal(k_cust.name, `Cust ${runId}`);
  const k_cust2 = await tool("update_customer", { customer: `Cust ${runId}`, plan: "Enterprise" });
  assert.equal(k_cust2.customer?.plan ?? k_cust2.plan, "Enterprise");
  assert.ok((await tool("list_customers")).some((c) => c.name === `Cust ${runId}`));
  assert.ok(Array.isArray(await tool("list_feature_requests", { customer: `Cust ${runId}` })));
  assert.ok(Array.isArray(await tool("list_views")));
  const k_inboxMcp = await tool("get_inbox");
  assert.ok(Array.isArray(k_inboxMcp.questions));
  const k_shareMcp = await tool("create_share_link", { task: k_keyMade.key, label: "e2e" });
  assert.ok(k_shareMcp.url.includes("/share/"));
  const k_overviewMcp = await tool("get_overview");
  assert.ok(k_overviewMcp && typeof k_overviewMcp === "object");
  await assert.rejects(tool("get_reports", { days: 12 }), /days|Invalid|expected/i);
  assert.ok(await tool("get_reports", { days: 7 }));
  pass("MCP covers projects, customers, feature requests, views, inbox, share links, overview and reports");

  step("Duplicate a task");
  const dupSrc = await alice("POST", "/api/tasks", { title: `Original ${runId}`, description: "Do the thing", priority: "high", status: "done" });
  await alice("POST", `/api/tasks/${dupSrc.key}/checklists`, { title: "Steps", items: ["one", "two"] });
  await alice("POST", `/api/tasks/${dupSrc.key}/notes`, { title: "Context", content: "background" });
  await alice("POST", `/api/tasks/${dupSrc.key}/dependencies`, { blocked_by: k_keyMade.key });
  const dupCopy = await alice("POST", `/api/tasks/${dupSrc.key}/duplicate`, {});
  assert.equal(dupCopy.title, `Original ${runId} (copy)`);
  assert.equal(dupCopy.status, "todo", "a finished original starts the copy at To do");
  assert.equal(dupCopy.priority, "high");
  const dupDetail = await alice("GET", `/api/tasks/${dupCopy.key}`);
  assert.equal(dupDetail.task.description, "Do the thing");
  assert.equal(dupDetail.checklists[0].items.length, 2);
  assert.ok(dupDetail.checklists[0].items.every((i) => !i.done));
  assert.equal(dupDetail.notes[0].title, "Context");
  assert.equal(dupDetail.dependencies.blocked_by[0].key, k_keyMade.key);
  assert.ok(dupDetail.entries.some((e) => e.type === "system" && e.data?.event === "duplicated_from"));
  const dupBare = await alice("POST", `/api/tasks/${dupSrc.key}/duplicate`, { title: "Bare copy", copy_details: false, priority: "low" });
  const bare = await alice("GET", `/api/tasks/${dupBare.key}`);
  assert.equal(bare.task.title, "Bare copy");
  assert.equal(bare.task.priority, "low");
  assert.equal(bare.checklists.length + bare.notes.length + bare.dependencies.blocked_by.length, 0);
  const dupMcp = await tool("duplicate_task", { task: dupSrc.key, title: `MCP copy ${runId}` });
  assert.equal(dupMcp.title, `MCP copy ${runId}`);
  pass("duplicating copies description, fields, checklists (unchecked), notes and blockers; overrides and MCP work");

  step("Sidebar profiles: admins group sidebar choices and assign them; people adjust their own");
  const sb_initial = await bob2("GET", "/api/sidebar");
  assert.deepEqual(sb_initial.hidden, []);
  assert.equal(sb_initial.profile, null);
  await assert.rejects(bob2("POST", "/api/sidebar-profiles", { name: "Nope", hidden: ["tools"] }), /403/);
  await assert.rejects(alice("POST", "/api/sidebar-profiles", { name: "Bad", hidden: ["nonsense"] }), /Unknown sidebar item/);
  await assert.rejects(alice("POST", "/api/sidebar-profiles", { name: "Bots", member_ids: [agent.id] }), /agents have no sidebar/i);
  const sb_sales = await alice("POST", "/api/sidebar-profiles", { name: "Sales", hidden: ["tools", "policies", "reports"], member_ids: [bobMember.id] });
  assert.deepEqual(sb_sales.member_ids, [bobMember.id]);
  let sb_bob = await bob2("GET", "/api/sidebar");
  assert.equal(sb_bob.profile.name, "Sales");
  assert.equal(sb_bob.profile.source, "assigned");
  assert.deepEqual([...sb_bob.hidden].sort(), ["policies", "reports", "tools"]);
  sb_bob = await bob2("PUT", "/api/sidebar", { hidden: ["feed"], shown: ["reports"] });
  assert.deepEqual([...sb_bob.hidden].sort(), ["feed", "policies", "tools"], "personal hide/show layers on the profile");
  await assert.rejects(bob2("PUT", "/api/sidebar", { hidden: ["x"] }), /Unknown sidebar item/);
  const sb_eng = await alice("POST", "/api/sidebar-profiles", { name: "Engineering", hidden: ["customers"], is_default: true });
  assert.equal(sb_eng.is_default, true);
  const sb_alice = await alice("GET", "/api/sidebar");
  assert.equal(sb_alice.profile.name, "Engineering");
  assert.equal(sb_alice.profile.source, "default");
  assert.deepEqual(sb_alice.hidden, ["customers"]);
  await alice("PATCH", `/api/members/${bobMember.id}`, { sidebar_profile_id: sb_eng.id });
  sb_bob = await bob2("GET", "/api/sidebar");
  assert.equal(sb_bob.profile.name, "Engineering");
  assert.deepEqual([...sb_bob.hidden].sort(), ["customers", "feed"]);
  await assert.rejects(bob2("PATCH", `/api/members/${bobMember.id}`, { sidebar_profile_id: null }), /403/);
  sb_bob = await bob2("PUT", "/api/sidebar", { reset: true });
  assert.deepEqual(sb_bob.hidden, ["customers"]);
  await alice("PATCH", `/api/sidebar-profiles/${sb_eng.id}`, { hidden: ["customers", "ideas"], name: "Eng" });
  assert.deepEqual([...(await bob2("GET", "/api/sidebar")).hidden].sort(), ["customers", "ideas"]);
  await alice("DELETE", `/api/sidebar-profiles/${sb_eng.id}`);
  const sb_after = await bob2("GET", "/api/sidebar");
  assert.equal(sb_after.profile, null, "deleting a profile returns its people to the full sidebar");
  assert.deepEqual(sb_after.hidden, []);
  const sb_list = await bob2("GET", "/api/sidebar-profiles");
  assert.deepEqual(sb_list.profiles.map((p) => p.name), ["Sales"]);
  assert.deepEqual(sb_list.profiles[0].member_ids, []);
  pass("profiles hide items for their people or as the default; personal changes layer on top; admins only");

  step("Unreachable agent → run fails and lands in Needs you");
  await alice("PATCH", `/api/members/${agent.id}`, { webhook_url: `http://localhost:${HOOK_PORT}/missing` });
  const t3 = await alice("POST", "/api/tasks", { title: "Will fail", assignee_id: agent.id });
  console.log("  … waiting for 3 failed delivery attempts (seconds with WEBHOOK_RETRY_SECONDS=1, ~2 min otherwise)");
  const deadline = Date.now() + 180_000;
  let failed = false;
  while (Date.now() < deadline) {
    const d = await alice("GET", `/api/tasks/${t3.key}`);
    if (d.runs[0]?.status === "failed") {
      failed = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  assert.ok(failed, "run marked failed");
  const inbox2 = await alice("GET", "/api/inbox");
  assert.ok(inbox2.runs.some((r) => r.task_key === t3.key));
  pass("failed run shows in Needs you");

  console.log("\n✅ All end-to-end checks passed\n");
} catch (err) {
  console.error("\n❌", err.message, "\n");
  process.exitCode = 1;
} finally {
  hookServer.close();
}
