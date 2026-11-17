/**
 * Link previews for app task links (/t/IMP-12). The app itself is a static single-page app, so
 * WhatsApp, Slack and similar preview bots would only ever see the generic title. When an admin turns
 * on "link previews", bots get the same page with the task's key and title (and, on "full", a short
 * description) in the title/description tags. People always get the normal app, signed in or not.
 *
 * Bots aren't signed in, so this is opt-in: anything shown here is readable by anyone who guesses a key.
 */
import { Hono } from "hono";
import { ensureWorkspace, getTaskByRef, taskKey } from "./domain";
import { PREVIEW_BOTS, esc, previewText } from "./shares";
import type { AppEnv } from "./util";

export const previewRoutes = new Hono<{ Bindings: AppEnv }>();

const STATUS: Record<string, string> = {
  backlog: "Backlog",
  todo: "To do",
  in_progress: "In progress",
  waiting_on_human: "Waiting on a person",
  done: "Done",
  canceled: "Canceled",
};

previewRoutes.get("/t/:key", async (c, next) => {
  if (!PREVIEW_BOTS.test(c.req.header("user-agent") ?? "")) return next();
  const ws = await ensureWorkspace(c.env);
  if (ws.link_previews !== "title" && ws.link_previews !== "full") return next();
  const task = await getTaskByRef(c.env, ws.id, c.req.param("key")).catch(() => null);
  if (!task) return next();

  const title = `${taskKey(ws, task)}: ${task.title}`;
  const description =
    ws.link_previews === "full" && task.description.trim()
      ? previewText(task.description)
      : `${STATUS[task.status] ?? task.status} · ${ws.name}`;
  const url = `${c.env.PUBLIC_URL.replace(/\/$/, "")}/t/${taskKey(ws, task)}`;

  const page = await c.env.ASSETS.fetch(new Request(new URL("/", c.req.url)));
  const tags =
    `<meta property="og:type" content="article"><meta property="og:site_name" content="${esc(ws.name)}">` +
    `<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}">` +
    `<meta property="og:url" content="${esc(url)}"><meta name="twitter:card" content="summary">` +
    `<meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(description)}">`;
  const res = new HTMLRewriter()
    .on("title", { element: (el) => void el.setInnerContent(title) })
    .on('meta[name="description"]', { element: (el) => void el.setAttribute("content", description) })
    .on("head", { element: (el) => void el.append(tags, { html: true }) })
    .transform(page);
  const out = new Response(res.body, res);
  out.headers.set("Cache-Control", "no-store");
  out.headers.set("X-Robots-Tag", "noindex, nofollow");
  return out;
});
