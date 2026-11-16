/**
 * Workspace settings: name, website, logo (found on the website or uploaded) and allowed sign-in domains.
 */
import { Hono } from "hono";
import { type MemberRow, type WorkspaceRow, ensureWorkspace, logActivity, notify, publicMember } from "./domain";
import { applyAgentProfile } from "./agents";
import { testPing } from "./orchestrator";
import { parseDomains } from "./auth";
import { type AppEnv, HttpError, badRequest, forbidden, nowIso } from "./util";

const LOGO_KEY = "workspace/logo";
const MAX_LOGO_BYTES = 1024 * 1024;
const MAX_HTML_BYTES = 2 * 1024 * 1024;

export function workspaceInfo(env: AppEnv, ws: WorkspaceRow) {
  const custom = ws.allowed_domains !== null;
  return {
    id: ws.id,
    name: ws.name,
    key_prefix: ws.key_prefix,
    website: ws.website,
    logo_url: ws.logo_key ? `/api/logo?v=${encodeURIComponent(ws.logo_updated_at ?? "")}` : null,
    allowed_domains: parseDomains(custom ? ws.allowed_domains : env.ALLOWED_EMAIL_DOMAINS),
    allowed_domains_source: custom ? ("workspace" as const) : ("default" as const),
    pm_agent_id: ws.pm_agent_id,
    pm_triage: !!ws.pm_triage,
  };
}

function normalizeWebsite(raw: string) {
  let s = raw.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw badRequest("Enter a valid website, e.g. impulze.ai");
  }
  if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) throw badRequest("Enter a valid website, e.g. impulze.ai");
  return u.origin;
}

export async function readCapped(res: Response, max: number) {
  const len = Number(res.headers.get("content-length") || 0);
  if (len > max) throw new HttpError(422, "File is too large");
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new HttpError(422, "File is too large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) (out.set(c, o), (o += c.byteLength));
  return out;
}

type IconCandidate = { href: string; score: number };

/** Find the best logo/icon the website declares. Returns absolute URLs, best first. */
async function findIconUrls(origin: string): Promise<string[]> {
  const candidates: IconCandidate[] = [];
  let base = origin;
  try {
    const res = await fetch(origin, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AgenticPM/1.0)", Accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
    base = res.url || origin;
    if (res.ok && (res.headers.get("content-type") || "").includes("html")) {
      const html = new TextDecoder().decode(await readCapped(res, MAX_HTML_BYTES).catch(() => new Uint8Array()));
      await new HTMLRewriter()
        .on("link[rel][href]", {
          element(el) {
            const rel = (el.getAttribute("rel") || "").toLowerCase();
            const href = el.getAttribute("href") || "";
            if (!href || href.startsWith("data:")) return;
            const sizes = el.getAttribute("sizes") || "";
            const type = (el.getAttribute("type") || "").toLowerCase();
            const px = Math.max(0, ...sizes.split(/\s+/).map((s) => Number(s.split("x")[0]) || 0));
            let score = -1;
            if (rel.includes("apple-touch-icon")) score = 300 + Math.min(px || 180, 512);
            else if (rel.split(/\s+/).includes("icon")) score = (type.includes("svg") || href.endsWith(".svg") ? 250 : 100) + Math.min(px, 512);
            if (score >= 0) candidates.push({ href, score });
          },
        })
        .on('meta[property="og:logo"], meta[itemprop="logo"]', {
          element(el) {
            const href = el.getAttribute("content");
            if (href) candidates.push({ href, score: 400 });
          },
        })
        .transform(new Response(html))
        .text();
    }
  } catch {
    // Site unreachable or not HTML; fall back to /favicon.ico below.
  }
  const urls = candidates
    .sort((a, b) => b.score - a.score)
    .map((c) => {
      try {
        return new URL(c.href, base).toString();
      } catch {
        return null;
      }
    })
    .filter((u): u is string => !!u && /^https?:/.test(u));
  urls.push(new URL("/favicon.ico", base).toString());
  return [...new Set(urls)];
}

function sniffImageType(bytes: Uint8Array, declared: string) {
  const b = bytes;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return "image/webp";
  if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return "image/x-icon";
  const head = new TextDecoder().decode(b.slice(0, 512)).trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
  if (declared.startsWith("image/") && declared !== "image/svg+xml") return null; // claims image but isn't one we know
  return null;
}

async function storeLogo(env: AppEnv, ws: WorkspaceRow, bytes: Uint8Array, contentType: string) {
  await env.FILES.put(LOGO_KEY, bytes, { httpMetadata: { contentType } });
  const now = nowIso();
  await env.DB.prepare("UPDATE workspaces SET logo_key = ?, logo_updated_at = ? WHERE id = ?").bind(LOGO_KEY, now, ws.id).run();
  return { ...ws, logo_key: LOGO_KEY, logo_updated_at: now };
}

export async function fetchLogoFromWebsite(env: AppEnv, ws: WorkspaceRow, website: string) {
  const urls = await findIconUrls(website);
  for (const url of urls.slice(0, 6)) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; AgenticPM/1.0)", Accept: "image/*" },
        redirect: "follow",
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const bytes = await readCapped(res, MAX_LOGO_BYTES);
      if (bytes.byteLength < 64) continue;
      const type = sniffImageType(bytes, (res.headers.get("content-type") || "").toLowerCase());
      if (!type) continue;
      return { ws: await storeLogo(env, ws, bytes, type), source: url };
    } catch {
      continue;
    }
  }
  throw new HttpError(422, `Couldn't find a logo on ${new URL(website).hostname}. Upload one instead.`);
}

type Vars = { me: MemberRow; ws: WorkspaceRow };
export const workspaceRoutes = new Hono<{ Bindings: AppEnv; Variables: Vars }>();

const requireAdmin = (me: MemberRow) => {
  if (me.role !== "admin") throw forbidden("Only admins can change workspace settings");
};

workspaceRoutes.get("/api/workspace", (c) => c.json(workspaceInfo(c.env, c.get("ws"))));

workspaceRoutes.patch("/api/workspace", async (c) => {
  const me = c.get("me");
  requireAdmin(me);
  let ws = c.get("ws");
  const body = await c.req.json<{
    name?: string;
    website?: string | null;
    allowed_domains?: string[] | string | null;
    pm_agent_id?: string | null;
    pm_triage?: boolean;
  }>();
  const sets: string[] = [];
  const binds: unknown[] = [];
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const set = (col: keyof WorkspaceRow, v: unknown) => {
    sets.push(`${col} = ?`);
    binds.push(v);
    before[col] = ws[col];
    after[col] = v;
  };

  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name || name.length > 60) throw badRequest("Workspace name must be 1–60 characters");
    set("name", name);
  }
  let websiteChanged = false;
  if (body.website !== undefined) {
    const website = body.website ? normalizeWebsite(body.website) : null;
    websiteChanged = website !== ws.website;
    set("website", website);
  }
  if (body.allowed_domains !== undefined) {
    if (body.allowed_domains === null) {
      set("allowed_domains", null); // back to the deployment default
    } else {
      const list = parseDomains(Array.isArray(body.allowed_domains) ? body.allowed_domains.join(",") : body.allowed_domains);
      for (const d of list) {
        if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) throw badRequest(`"${d}" isn't a valid domain`);
      }
      const mine = (me.email ?? "").split("@")[1];
      if (list.length && mine && !list.includes(mine)) {
        throw badRequest(`Keep ${mine} in the list, or you'd block your own address`);
      }
      set("allowed_domains", list.join(","));
    }
  }
  if (body.pm_agent_id !== undefined) {
    if (body.pm_agent_id) {
      const pm = await c.env.DB.prepare("SELECT id FROM members WHERE id = ? AND workspace_id = ? AND kind = 'agent' AND active = 1")
        .bind(body.pm_agent_id, ws.id)
        .first();
      if (!pm) throw badRequest("Choose an active agent as the PM");
    }
    set("pm_agent_id", body.pm_agent_id || null);
  }
  if (body.pm_triage !== undefined) set("pm_triage", body.pm_triage ? 1 : 0);
  if (sets.length) {
    await c.env.DB.prepare(`UPDATE workspaces SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, ws.id).run();
    await logActivity(c.env, ws.id, { member: me, via: "web" }, "workspace", ws.id, "updated", before, after);
    ws = await ensureWorkspace(c.env);
  }

  // A new website with no logo yet: try to pick one up automatically.
  let logo: { found: boolean; error?: string } | undefined;
  if (websiteChanged && ws.website && !ws.logo_key) {
    try {
      ws = (await fetchLogoFromWebsite(c.env, ws, ws.website)).ws;
      logo = { found: true };
    } catch (err) {
      logo = { found: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  await notify(c.env, ws.id, { type: "workspace" });
  return c.json({ ...workspaceInfo(c.env, ws), logo });
});

/** The workspace-level webhook is the PM agent's webhook: read and set it here. */
async function getPm(c: { env: AppEnv; get: (k: "ws") => WorkspaceRow }) {
  const ws = c.get("ws");
  if (!ws.pm_agent_id) throw badRequest("Choose a PM agent first");
  const pm = await c.env.DB.prepare("SELECT * FROM members WHERE id = ?").bind(ws.pm_agent_id).first<MemberRow>();
  if (!pm) throw badRequest("Choose a PM agent first");
  return pm;
}

workspaceRoutes.patch("/api/workspace/pm-webhook", async (c) => {
  const me = c.get("me");
  requireAdmin(me);
  const pm = await getPm(c);
  const body = await c.req.json<{ webhook_url?: string; webhook_key?: string }>();
  if (body.webhook_url && !/^https:\/\//.test(body.webhook_url) && !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(body.webhook_url)) {
    throw badRequest("Webhook URL must start with https://");
  }
  const fresh = await applyAgentProfile(c.env, { member: me, via: "web" }, pm, {
    webhook_url: body.webhook_url,
    webhook_key: body.webhook_key || undefined,
  });
  return c.json(publicMember(fresh));
});

workspaceRoutes.post("/api/workspace/pm-webhook/test", async (c) => {
  requireAdmin(c.get("me"));
  return c.json(await testPing(c.env, await getPm(c)));
});

workspaceRoutes.post("/api/workspace/logo/fetch", async (c) => {
  requireAdmin(c.get("me"));
  const ws = c.get("ws");
  const body = await c.req.json<{ website?: string }>().catch(() => ({}) as { website?: string });
  const website = body.website ? normalizeWebsite(body.website) : ws.website;
  if (!website) throw badRequest("Add the workspace website first");
  const { ws: fresh, source } = await fetchLogoFromWebsite(c.env, ws, website);
  await notify(c.env, ws.id, { type: "workspace" });
  return c.json({ ...workspaceInfo(c.env, fresh), logo_source: source });
});

workspaceRoutes.post("/api/workspace/logo", async (c) => {
  requireAdmin(c.get("me"));
  const ws = c.get("ws");
  const form = await c.req.formData();
  const file = form.get("file");
  if (!file || typeof file === "string") throw badRequest("Choose an image file");
  if (file.size > MAX_LOGO_BYTES) throw badRequest("Logo must be 1 MB or smaller");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffImageType(bytes, file.type);
  if (!type) throw badRequest("Use a PNG, JPG, GIF, WebP, ICO or SVG image");
  const fresh = await storeLogo(c.env, ws, bytes, type);
  await notify(c.env, ws.id, { type: "workspace" });
  return c.json(workspaceInfo(c.env, fresh));
});

workspaceRoutes.delete("/api/workspace/logo", async (c) => {
  requireAdmin(c.get("me"));
  const ws = c.get("ws");
  await c.env.FILES.delete(LOGO_KEY);
  await c.env.DB.prepare("UPDATE workspaces SET logo_key = NULL, logo_updated_at = ? WHERE id = ?").bind(nowIso(), ws.id).run();
  await notify(c.env, ws.id, { type: "workspace" });
  return c.json(workspaceInfo(c.env, await ensureWorkspace(c.env)));
});

/** Public (shown on the sign-in page too). */
export async function serveLogo(env: AppEnv) {
  const ws = await ensureWorkspace(env);
  if (!ws.logo_key) return new Response("No logo", { status: 404 });
  const obj = await env.FILES.get(ws.logo_key);
  if (!obj) return new Response("No logo", { status: 404 });
  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
}
