import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { api } from "./api";
import { sharePublicRoutes } from "./shares";
import { previewRoutes } from "./previews";
import { authRoutes } from "./auth";
import { handleAuthorize } from "./authorize";
import { mcpHandler } from "./mcp";
import { type DispatchMessage, handleDispatch, sweepStaleRuns } from "./orchestrator";
import type { AppEnv } from "./util";

export { Realtime } from "./realtime";

const app = new Hono<{ Bindings: AppEnv }>();
app.get("/authorize", handleAuthorize);
app.post("/authorize", handleAuthorize);
app.route("/", sharePublicRoutes);
app.route("/", previewRoutes);
app.route("/", authRoutes);
app.route("/", api);
app.all("*", (c) => (c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.notFound()));

let provider: OAuthProvider<AppEnv> | null = null;
let providerFor = "";

function getProvider(env: AppEnv) {
  const base = env.PUBLIC_URL.replace(/\/$/, "");
  if (!provider || providerFor !== base) {
    providerFor = base;
    provider = new OAuthProvider<AppEnv>({
      apiRoute: "/mcp",
      apiHandler: mcpHandler as any,
      defaultHandler: { fetch: (req: Request, e: AppEnv, ctx: ExecutionContext) => app.fetch(req, e, ctx) } as any,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      scopesSupported: ["tasks", "offline_access"],
      resourceMetadata: { resource: `${base}/mcp`, authorization_servers: [base] },
      accessTokenTTL: 3600,
    });
  }
  return provider;
}

export default {
  fetch(request: Request, env: AppEnv, ctx: ExecutionContext) {
    return getProvider(env).fetch(request, env, ctx);
  },
  async queue(batch: MessageBatch<DispatchMessage>, env: AppEnv) {
    for (const msg of batch.messages) {
      try {
        await handleDispatch(env, msg);
      } catch (err) {
        console.error("dispatch failed", err);
        msg.retry({ delaySeconds: 60 });
      }
    }
  },
  async scheduled(_event: ScheduledController, env: AppEnv) {
    const n = await sweepStaleRuns(env);
    if (n) console.log(`marked ${n} runs stale`);
  },
} satisfies ExportedHandler<AppEnv, DispatchMessage>;
