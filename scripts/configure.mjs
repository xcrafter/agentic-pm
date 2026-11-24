#!/usr/bin/env node
/**
 * Fill in wrangler.jsonc for one company's deployment from environment variables, so a single repo
 * can deploy to many Cloudflare accounts. Each account's Workers Builds sets these as
 * "Build variables" (Settings → Build → Build variables and secrets).
 *
 *   Required on Workers Builds:
 *     APM_PUBLIC_URL            https://tasks.acme.com
 *     APM_ALLOWED_EMAIL_DOMAINS acme.com: restricts sign-ups to these email domains (comma-separated)
 *     APM_D1_DATABASE_ID        from `wrangler d1 create agentic-pm`
 *     APM_KV_NAMESPACE_ID       from `wrangler kv namespace create OAUTH_KV`
 *   Optional:
 *     APM_WORKSPACE_NAME, APM_WORKSPACE_KEY   only used when the workspace is first created
 *     APM_EMAIL_FROM            notifications@acme.com: turns on email notifications (the domain must be
 *                               onboarded to Cloudflare Email Sending, which needs the Workers Paid plan)
 *     APM_WORKER_NAME, APM_D1_DATABASE_NAME, APM_R2_BUCKET, APM_QUEUE   if you changed the defaults
 *
 * With none of these set (local development), the file is left untouched. On Workers Builds
 * (WORKERS_CI=1) a missing required value fails the build, so a company never gets the placeholders.
 */
import { readFileSync, writeFileSync } from "node:fs";

const env = process.env;
const v = (k) => (env[k] ?? "").trim();
const REQUIRED = ["APM_PUBLIC_URL", "APM_ALLOWED_EMAIL_DOMAINS", "APM_D1_DATABASE_ID", "APM_KV_NAMESPACE_ID"];
const ALL = [...REQUIRED, "APM_WORKSPACE_NAME", "APM_WORKSPACE_KEY", "APM_EMAIL_FROM", "APM_WORKER_NAME", "APM_D1_DATABASE_NAME", "APM_R2_BUCKET", "APM_QUEUE"];

const onCi = env.WORKERS_CI === "1";
const given = ALL.filter((k) => v(k));
if (!given.length && !onCi) process.exit(0);

const missing = REQUIRED.filter((k) => !v(k));
if (missing.length) {
  console.error(`configure: set these build variables for this deployment: ${missing.join(", ")}`);
  console.error("  (Cloudflare dashboard → your Worker → Settings → Build → Build variables and secrets)");
  process.exit(1);
}
if (!/^https?:\/\/[^/]+/.test(v("APM_PUBLIC_URL"))) {
  console.error("configure: APM_PUBLIC_URL must be a full address like https://tasks.acme.com");
  process.exit(1);
}

if (v("APM_EMAIL_FROM") && !/^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(v("APM_EMAIL_FROM"))) {
  console.error("configure: APM_EMAIL_FROM must be a plain address like notifications@acme.com");
  process.exit(1);
}

const path = new URL("../wrangler.jsonc", import.meta.url);
// wrangler.jsonc may hold // comments; strip them (outside strings) before parsing.
const raw = readFileSync(path, "utf8").replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str ?? "");
const cfg = JSON.parse(raw);

cfg.vars = { ...cfg.vars, PUBLIC_URL: v("APM_PUBLIC_URL").replace(/\/$/, ""), ALLOWED_EMAIL_DOMAINS: v("APM_ALLOWED_EMAIL_DOMAINS") };
if (v("APM_WORKSPACE_NAME")) cfg.vars.WORKSPACE_NAME = v("APM_WORKSPACE_NAME");
if (v("APM_WORKSPACE_KEY")) cfg.vars.WORKSPACE_KEY = v("APM_WORKSPACE_KEY").toUpperCase();
if (v("APM_WORKER_NAME")) cfg.name = v("APM_WORKER_NAME");
if (v("APM_EMAIL_FROM")) {
  cfg.vars.EMAIL_FROM = v("APM_EMAIL_FROM").toLowerCase();
  cfg.send_email = [{ name: "EMAIL" }];
}

const db = cfg.d1_databases.find((d) => d.binding === "DB");
db.database_id = v("APM_D1_DATABASE_ID");
if (v("APM_D1_DATABASE_NAME")) db.database_name = v("APM_D1_DATABASE_NAME");
cfg.kv_namespaces.find((k) => k.binding === "OAUTH_KV").id = v("APM_KV_NAMESPACE_ID");
if (v("APM_R2_BUCKET")) cfg.r2_buckets.find((b) => b.binding === "FILES").bucket_name = v("APM_R2_BUCKET");
if (v("APM_QUEUE")) {
  cfg.queues.producers.find((q) => q.binding === "DISPATCH_QUEUE").queue = v("APM_QUEUE");
  cfg.queues.consumers[0].queue = v("APM_QUEUE");
}

writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
console.log(
  `configure: ${cfg.name} → ${cfg.vars.PUBLIC_URL} (domains: ${cfg.vars.ALLOWED_EMAIL_DOMAINS}; email: ${cfg.vars.EMAIL_FROM ?? "off"})`,
);
