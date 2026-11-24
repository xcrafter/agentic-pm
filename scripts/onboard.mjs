#!/usr/bin/env node
/**
 * Set up Agentic PM for a new company on its own Cloudflare account, in one command.
 *
 * Plain-language guide: docs/SETUP.md
 *
 *   npx wrangler login                      # as someone in the company's Cloudflare account
 *   npm run onboard -- --name "Acme" --domain acme.com
 *
 * Options:
 *   --name "Acme"            workspace name (required)
 *   --domain acme.com        restricts sign-ups to this email domain; comma-separate several (required)
 *   --key ACME               task-key prefix (default: from the name)
 *   --url https://…          address people will use (default: https://agentic-pm.<subdomain>.workers.dev)
 *   --account <id>           which Cloudflare account, if your login has several
 *   --check                  look only: report what exists and what would be done, change nothing
 *
 * What it does (safe to run again; it reuses what already exists):
 *   1. Finds or creates the database, sign-in store, file bucket and queue.
 *   2. Deploys the app once, with the database schema (skipped if the Worker already exists).
 *   3. Generates SESSION_SECRET and WEBHOOK_KEY_ENCRYPTION_KEY if missing. Values are never shown.
 *   4. Prints the build variables to paste when connecting the repo, so later releases deploy themselves.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, renameSync } from "node:fs";

const WORKER = "agentic-pm";
const WIN = process.platform === "win32"; // npm/npx are .cmd files on Windows
const NAMES = { d1: WORKER, kv: `${WORKER}-oauth`, r2: `${WORKER}-files`, queue: `${WORKER}-dispatch` };

// ---------- arguments ----------
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const k = a.slice(2);
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith("--")) args[k] = true;
  else args[k] = next, i++;
}
const check = !!args.check;
const die = (msg) => (console.error(`\n✖ ${msg}\n`), process.exit(1));
if (!args.name || args.name === true) die('Pass --name "Company name"');
if (!args.domain || args.domain === true) die("Pass --domain company.com: sign-ups are restricted to email addresses on this domain");
const domains = String(args.domain).split(/[\s,]+/).map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
if (!domains.every((d) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d))) die(`--domain doesn't look like a domain: ${args.domain}`);
const key = (args.key && args.key !== true ? String(args.key) : String(args.name).replace(/[^A-Za-z]/g, "").slice(0, 4) || "TASK").toUpperCase();

// ---------- Cloudflare API (with your wrangler login) ----------
const wrangler = (argv, opts = {}) => execFileSync("npx", ["wrangler", ...argv], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: WIN, ...opts });
let token;
try {
  token = wrangler(["auth", "token"]).trim().split("\n").pop().trim();
} catch {
  die("Not logged in. Run: npx wrangler login");
}
async function cf(method, path, body) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.success) {
    const err = new Error(`${method} ${path}: ${(data.errors ?? []).map((e) => e.message).join("; ") || res.status}`);
    err.status = res.status;
    throw err;
  }
  return data.result;
}

const accounts = await cf("GET", "/accounts?per_page=50");
let account = args.account && args.account !== true ? accounts.find((a) => a.id === args.account || a.name === args.account) : null;
if (!account && accounts.length === 1) account = accounts[0];
if (!account) {
  console.error("\nYour login can reach several Cloudflare accounts. Pick one with --account:\n");
  for (const a of accounts) console.error(`  --account ${a.id}   (${a.name})`);
  process.exit(1);
}
const A = `/accounts/${account.id}`;
const step = (s) => console.log(`\n▸ ${s}`);
const blockers = [];
const note = (s) => console.log(`  ${s}`);
console.log(`\nAgentic PM onboarding for "${args.name}" on Cloudflare account "${account.name}"${check ? "  (check only, nothing will change)" : ""}`);

// ---------- 1. resources ----------
step("Database, sign-in store, file bucket, queue");
const scripts = await cf("GET", `${A}/workers/scripts`);
const exists = scripts.some((s) => s.id === WORKER);
// For an existing deployment, use exactly what it's bound to today.
let bound = {};
if (exists) {
  const settings = await cf("GET", `${A}/workers/scripts/${WORKER}/settings`);
  for (const b of settings.bindings ?? []) {
    if (b.type === "d1" && b.name === "DB") bound.d1 = b.id ?? b.database_id;
    if (b.type === "kv_namespace" && b.name === "OAUTH_KV") bound.kv = b.namespace_id;
    if (b.type === "r2_bucket" && b.name === "FILES") bound.r2 = b.bucket_name;
    if (b.type === "queue" && b.name === "DISPATCH_QUEUE") bound.queue = b.queue_name;
  }
}

async function ensure(label, findFn, createFn) {
  const found = await findFn();
  if (found) return note(`✓ ${label}: using existing ${found.name}`), found.id;
  if (check) return note(`• ${label}: would create`), `<new ${label}>`;
  const made = await createFn();
  note(`✓ ${label}: created ${made.name}`);
  return made.id;
}

const d1Id = await ensure(
  "database",
  async () => {
    const list = await cf("GET", `${A}/d1/database?per_page=100`);
    const db = list.find((d) => (bound.d1 ? d.uuid === bound.d1 : d.name === NAMES.d1));
    return db && { id: db.uuid, name: db.name };
  },
  async () => {
    const db = await cf("POST", `${A}/d1/database`, { name: NAMES.d1 });
    return { id: db.uuid, name: db.name };
  },
);
const kvId = await ensure(
  "sign-in store",
  async () => {
    const list = await cf("GET", `${A}/storage/kv/namespaces?per_page=100`);
    const ns = list.find((n) => (bound.kv ? n.id === bound.kv : n.title === NAMES.kv));
    return ns && { id: ns.id, name: ns.title };
  },
  async () => {
    const ns = await cf("POST", `${A}/storage/kv/namespaces`, { title: NAMES.kv });
    return { id: ns.id, name: ns.title };
  },
);
const r2Name = bound.r2 ?? NAMES.r2;
await ensure(
  "file bucket",
  async () => {
    const list = await cf("GET", `${A}/r2/buckets`).catch((e) => {
      if (!/enable R2/i.test(e.message)) throw e;
      if (!check) die("R2 (file storage) isn't turned on for this account. In the dashboard open R2 → Get started (free to start), then run this again.");
      blockers.push("Turn on R2 (file storage): dashboard → R2 → Get started. It's free to start.");
      return { buckets: [], blocked: true };
    });
    if (list.blocked) return null;
    return list.buckets.some((b) => b.name === r2Name) && { id: r2Name, name: r2Name };
  },
  async () => {
    try {
      await cf("POST", `${A}/r2/buckets`, { name: r2Name });
    } catch (e) {
      if (/R2|enable|subscription|10042/i.test(e.message)) die("R2 isn't enabled on this account yet. Turn it on in the dashboard (R2 → Get started; it's free to start), then run this again.");
      throw e;
    }
    return { id: r2Name, name: r2Name };
  },
);
const queueName = bound.queue ?? NAMES.queue;
await ensure(
  "queue",
  async () => {
    const list = await cf("GET", `${A}/queues`);
    return list.some((q) => q.queue_name === queueName) && { id: queueName, name: queueName };
  },
  async () => {
    await cf("POST", `${A}/queues`, { queue_name: queueName });
    return { id: queueName, name: queueName };
  },
);

for (const b of blockers) note(`! Before running for real: ${b}`);

// ---------- address ----------
let url = args.url && args.url !== true ? String(args.url).replace(/\/$/, "") : null;
if (!url) {
  const sub = await cf("GET", `${A}/workers/subdomain`).catch(() => null);
  if (!sub?.subdomain) die("This account has no workers.dev subdomain yet. Open Workers & Pages once in the dashboard to pick one, or pass --url https://your-domain");
  url = `https://${WORKER}.${sub.subdomain}.workers.dev`;
}
if (!/^https:\/\/[^/]+$/.test(url)) die(`--url must look like https://tasks.acme.com (got ${url})`);

const buildVars = {
  APM_PUBLIC_URL: url,
  APM_ALLOWED_EMAIL_DOMAINS: domains.join(","),
  APM_D1_DATABASE_ID: d1Id,
  APM_KV_NAMESPACE_ID: kvId,
  APM_WORKSPACE_NAME: String(args.name),
  APM_WORKSPACE_KEY: key,
  ...(r2Name !== NAMES.r2 && { APM_R2_BUCKET: r2Name }),
  ...(queueName !== NAMES.queue && { APM_QUEUE: queueName }),
};

// ---------- 2. first deploy ----------
step("First deploy");
const childEnv = { ...process.env, ...buildVars, CLOUDFLARE_ACCOUNT_ID: account.id, WORKERS_CI: "" };
if (exists) note("✓ The app is already deployed here; skipping. Updates arrive through the repo connection below.");
else if (check) note(`• would build, create the database tables, and deploy to ${url}`);
else {
  // configure.mjs writes the company's values into wrangler.jsonc; put the template back afterwards.
  copyFileSync("wrangler.jsonc", "wrangler.jsonc.onboard-backup");
  try {
    const run = (cmd, argv) => {
      const r = spawnSync(cmd, argv, { stdio: "inherit", env: childEnv, shell: WIN });
      if (r.status !== 0) die(`${cmd} ${argv.join(" ")} failed (see above)`);
    };
    run("npm", ["run", "build"]);
    run("npx", ["wrangler", "deploy"]);
    run("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--remote"]);
    note(`✓ Deployed to ${url}`);
  } finally {
    renameSync("wrangler.jsonc.onboard-backup", "wrangler.jsonc");
    // Leave dist/ built with the template, so local tools don't point at this company's resources.
    spawnSync("npm", ["run", "build"], { stdio: "ignore", env: { ...process.env, WORKERS_CI: "" }, shell: WIN });
  }
}

// ---------- 3. secrets ----------
step("Secrets");
const haveSecrets = exists || !check ? (await cf("GET", `${A}/workers/scripts/${WORKER}/secrets`).catch(() => [])).map((s) => s.name) : [];
const wanted = {
  SESSION_SECRET: () => randomBytes(32).toString("hex"),
  WEBHOOK_KEY_ENCRYPTION_KEY: () => randomBytes(32).toString("base64"),
};
for (const [name, gen] of Object.entries(wanted)) {
  if (haveSecrets.includes(name)) note(`✓ ${name} is set`);
  else if (check) note(`• would generate ${name}`);
  else {
    await cf("PUT", `${A}/workers/scripts/${WORKER}/secrets`, { name, text: gen(), type: "secret_text" });
    note(`✓ ${name} generated and stored (not shown)`);
  }
}
note("Google sign-in is optional: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET later if you want it.");

// ---------- 4. connect the repo ----------
step("Last step: connect the repo so releases deploy themselves (about 2 minutes)");
console.log(`
  In the Cloudflare dashboard (account "${account.name}"):
  Workers & Pages → ${WORKER} → Settings → Build → Connect

    Repository       xcrafter/agentic-pm   (let Cloudflare's GitHub app access it)
    Branch           release
    Build command    npm run build
    Deploy command   npm run deploy:ci

  Then, under "Build variables and secrets", add:
`);
const w = Math.max(...Object.keys(buildVars).map((k) => k.length));
for (const [k, v] of Object.entries(buildVars)) console.log(`    ${k.padEnd(w)}  ${v}`);
console.log(
  exists ? `\n  Then retry the latest build in Deployments, or push to release.\n` : `\n  Finally open ${url}. The first person to visit becomes the admin.\n`,
);
