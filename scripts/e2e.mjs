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
  const setup = await authPost("/auth/setup", { name: "Alice", email: "alice@impulze.ai", password: PASSWORD });
  assert.equal(setup.res.status, 200, `setup: ${JSON.stringify(setup.data)}`);
  const alice = webApi(setup.jar);
  const me = await alice("GET", "/api/me");
  assert.equal(me.member.role, "admin");
  pass(`signed up as ${me.member.name} (${me.member.role})`);
  const again = await authPost("/auth/setup", { name: "Mallory", email: "mallory@impulze.ai", password: "whatever123" });
  assert.equal(again.res.status, 403);
  pass("setup is closed once the first person exists");
  const outsider = await authPost("/auth/setup", { email: "x@gmail.com", password: "whatever123" });
  assert.notEqual(outsider.res.status, 200);
  const devGone = await fetch(`${BASE}/auth/dev`, { method: "POST", body: new URLSearchParams({ email: "eve@impulze.ai" }), redirect: "manual" });
  assert.notEqual(devGone.status, 302);
  pass("passwordless developer sign-in no longer exists");

  step("Password sign-in");
  const wrong = await authPost("/auth/login", { email: "alice@impulze.ai", password: "nope-nope" });
  assert.equal(wrong.res.status, 401);
  const unknown = await authPost("/auth/login", { email: "nobody@impulze.ai", password: PASSWORD });
  assert.equal(unknown.res.status, 401);
  const formPost = await fetch(`${BASE}/auth/login`, { method: "POST", body: new URLSearchParams({ email: "alice@impulze.ai", password: PASSWORD }) });
  assert.equal(formPost.status, 415);
  pass("wrong password, unknown email and cross-site form posts are refused");
  const good = await authPost("/auth/login", { email: "alice@impulze.ai", password: PASSWORD });
  assert.equal(good.res.status, 200);
  const aliceJar = good.jar;
  pass("correct password signs in");

  step("Admin invites a teammate; they set their own password");
  const invite = await alice("POST", "/api/invites", { email: "bob@impulze.ai", name: "Bob" });
  const token = invite.url.split("/invite/")[1];
  const info = await (await fetch(`${BASE}/auth/invite/${token}`)).json();
  assert.equal(info.email, "bob@impulze.ai");
  const accept = await authPost(`/auth/invite/${token}`, { name: "Bob", password: "bobs-password" });
  assert.equal(accept.res.status, 200, JSON.stringify(accept.data));
  const bobJar = accept.jar;
  const bob = webApi(bobJar);
  assert.equal((await bob("GET", "/api/me")).member.role, "member");
  const reuse = await authPost(`/auth/invite/${token}`, { name: "Eve", password: "eves-password" });
  assert.equal(reuse.res.status, 404);
  pass("invite link signs Bob up as a member and can't be reused");
  const bobMember = (await alice("GET", "/api/members")).find((m) => m.email === "bob@impulze.ai");
  const resetLink = await alice("POST", `/api/members/${bobMember.id}/reset-link`);
  const reset = await authPost(`/auth/invite/${resetLink.url.split("/invite/")[1]}`, { password: "bobs-new-password" });
  assert.equal(reset.res.status, 200);
  assert.equal((await fetch(`${BASE}/api/me`, { headers: { Cookie: cookieHeader(bobJar) } }).then((r) => r.json())).member, null);
  assert.equal((await authPost("/auth/login", { email: "bob@impulze.ai", password: "bobs-new-password" })).res.status, 200);
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
  // The pending mention from earlier triggers a follow-up run once the agent's run ends.
  const followup = await waitForHook((c) => c.body?.event === "followup" && c.body.task.key === task.key);
  pass(`queued mention produced a follow-up wake (run ${followup.body.run_id})`);
  await tool("end_run", { task: task.key, reason: "Noted Hooli; still waiting on the private-companies question." });

  step("Human answers → agent is woken with event=answered");
  await alice("POST", `/api/tasks/${task.key}/entries`, { body: "Yes, include private ones.", reply_to_id: q.id });
  const answeredHook = await waitForHook((c) => c.body?.event === "answered" && c.body.task.key === task.key);
  pass(`webhook called: event=answered run=${answeredHook.body.run_id}`);
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

  step("Unreachable agent → run fails and lands in Needs you");
  await alice("PATCH", `/api/members/${agent.id}`, { webhook_url: `http://localhost:${HOOK_PORT}/missing` });
  const t3 = await alice("POST", "/api/tasks", { title: "Will fail", assignee_id: agent.id });
  console.log("  … waiting for retries (≈1–2 min in dev)");
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
