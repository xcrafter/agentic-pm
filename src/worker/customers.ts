/**
 * Customers and feature requests. A feature request = a customer linked to an idea, with what they
 * said and when. Several customers can request the same idea; each customer counts once per idea.
 */
import { Hono } from "hono";
import type { Actor, MemberRow, WorkspaceRow } from "./domain";
import { logActivity, notify } from "./domain";
import { type RequestStatus, REQUEST_STATUSES, createIdea, getIdea, requestStatusFor } from "./ideas";
import { type AppEnv, HttpError, badRequest, forbidden, newId, notFound, nowIso } from "./util";

export interface CustomerRow {
  id: string;
  workspace_id: string;
  name: string;
  domain: string | null;
  email: string | null;
  plan: string | null;
  mrr: number | null;
  notes: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface CustomerInput {
  name?: string;
  domain?: string | null;
  email?: string | null;
  plan?: string | null;
  mrr?: number | string | null;
  notes?: string;
}

const today = () => new Date().toISOString().slice(0, 10);

function cleanFields(input: CustomerInput) {
  const out: Partial<CustomerRow> = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name || name.length > 120) throw badRequest("Customer name must be 1–120 characters");
    out.name = name;
  }
  if (input.domain !== undefined) {
    const d = (input.domain ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (d && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) throw badRequest("Domain looks wrong, e.g. brand.com or brand.myshopify.com");
    out.domain = d || null;
  }
  if (input.email !== undefined) {
    const e = (input.email ?? "").trim().toLowerCase();
    if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw badRequest("Email looks wrong");
    out.email = e || null;
  }
  if (input.plan !== undefined) out.plan = (input.plan ?? "").trim().slice(0, 40) || null;
  if (input.mrr !== undefined) {
    if (input.mrr === null || input.mrr === "") out.mrr = null;
    else {
      const n = Number(input.mrr);
      if (!Number.isFinite(n) || n < 0) throw badRequest("MRR must be a positive number");
      out.mrr = Math.round(n * 100) / 100;
    }
  }
  if (input.notes !== undefined) out.notes = (input.notes ?? "").slice(0, 5000);
  return out;
}

export async function createCustomer(env: AppEnv, ws: WorkspaceRow, actor: Actor, input: CustomerInput) {
  const f = cleanFields(input);
  if (!f.name) throw badRequest("Customer name is required");
  const dup = await env.DB.prepare("SELECT id FROM customers WHERE workspace_id = ? AND name = ? COLLATE NOCASE").bind(ws.id, f.name).first();
  if (dup) throw new HttpError(409, `There's already a customer called “${f.name}”`);
  const now = nowIso();
  const id = newId();
  await env.DB.prepare(
    "INSERT INTO customers (id, workspace_id, name, domain, email, plan, mrr, notes, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(id, ws.id, f.name, f.domain ?? null, f.email ?? null, f.plan ?? null, f.mrr ?? null, f.notes ?? "", actor.member.id, now, now)
    .run();
  await logActivity(env, ws.id, actor, "customer", id, "created", undefined, { name: f.name });
  await notify(env, ws.id, { type: "customers" });
  return (await env.DB.prepare("SELECT * FROM customers WHERE id = ?").bind(id).first<CustomerRow>())!;
}

/** Find a customer by id, or by name (case-insensitive), creating it when `create` is set. */
export async function resolveCustomer(env: AppEnv, ws: WorkspaceRow, actor: Actor, ref: { id?: string | null; name?: string | null } & CustomerInput, create = true) {
  if (ref.id) {
    const c = await env.DB.prepare("SELECT * FROM customers WHERE id = ? AND workspace_id = ?").bind(ref.id, ws.id).first<CustomerRow>();
    if (!c) throw notFound("Customer");
    return { customer: c, created: false };
  }
  const name = ref.name?.trim();
  if (!name) throw badRequest("Pick a customer or type a new customer's name");
  const c = await env.DB.prepare("SELECT * FROM customers WHERE workspace_id = ? AND name = ? COLLATE NOCASE").bind(ws.id, name).first<CustomerRow>();
  if (c) return { customer: c, created: false };
  if (!create) throw notFound(`Customer “${name}”`);
  return { customer: await createCustomer(env, ws, actor, { ...ref, name }), created: true };
}

/** Link a customer to an idea. Asking again updates the note/date instead of double-counting. */
export async function addRequest(env: AppEnv, ws: WorkspaceRow, actor: Actor, ideaId: string, customer: CustomerRow, note?: string, requestedAt?: string) {
  const idea = await getIdea(env, ws, ideaId);
  const date = requestedAt && /^\d{4}-\d{2}-\d{2}$/.test(requestedAt) ? requestedAt : today();
  const text = (note ?? "").trim().slice(0, 2000);
  const existing = await env.DB.prepare("SELECT id, times, status, requested_at FROM idea_requests WHERE idea_id = ? AND customer_id = ?")
    .bind(ideaId, customer.id)
    .first<{ id: string; times: number; status: RequestStatus; requested_at: string }>();
  const now = nowIso();
  if (existing) {
    // Asked again: count it, keep the latest date and what they said this time. An archived request reopens.
    await env.DB.prepare(
      `UPDATE idea_requests SET times = times + 1, note = CASE WHEN ? = '' THEN note ELSE ? END, requested_at = MAX(requested_at, ?),
       status = CASE WHEN status = 'archived' THEN ? ELSE status END, updated_at = ? WHERE id = ?`,
    )
      .bind(text, text, date, requestStatusFor(idea.stage === "archived" ? "backlog" : idea.stage), now, existing.id)
      .run();
  } else {
    await env.DB.prepare(
      "INSERT INTO idea_requests (id, idea_id, customer_id, note, requested_at, added_by, created_at, status, times) VALUES (?,?,?,?,?,?,?,?,1)",
    )
      .bind(newId(), ideaId, customer.id, text, date, actor.member.id, now, requestStatusFor(idea.stage === "archived" ? "backlog" : idea.stage))
      .run();
  }
  await logActivity(env, ws.id, actor, "idea", ideaId, "requested", undefined, { customer: customer.name, note: text, again: !!existing });
  await notify(env, ws.id, { type: "ideas" });
  return { already: !!existing, times: (existing?.times ?? 0) + 1 };
}

/** One step: customer (existing or new) + feature (existing idea or a new one). */
export async function logFeatureRequest(
  env: AppEnv,
  ws: WorkspaceRow,
  actor: Actor,
  input: { customer: { id?: string | null; name?: string | null } & CustomerInput; ideaId?: string | null; title?: string; body?: string; note?: string; requestedAt?: string },
  defer?: (p: Promise<unknown>) => void,
) {
  const { customer, created: customerCreated } = await resolveCustomer(env, ws, actor, input.customer);
  let ideaId = input.ideaId ?? null;
  let ideaCreated = false;
  if (!ideaId) {
    const title = input.title?.trim();
    if (!title) throw badRequest("Pick an existing feature or describe a new one");
    // Reuse an idea with the same title rather than creating a duplicate.
    const same = await env.DB.prepare("SELECT id FROM ideas WHERE workspace_id = ? AND title = ? COLLATE NOCASE").bind(ws.id, title).first<{ id: string }>();
    if (same) ideaId = same.id;
    else {
      ideaId = (await createIdea(env, ws, actor, { title, body: input.body }, defer)).id;
      ideaCreated = true;
    }
  }
  const r = await addRequest(env, ws, actor, ideaId, customer, input.note, input.requestedAt);
  return { idea: await getIdea(env, ws, ideaId), customer, customer_created: customerCreated, idea_created: ideaCreated, already_requested: r.already };
}

export async function listCustomers(env: AppEnv, ws: WorkspaceRow) {
  const rows = await env.DB.prepare(
    `SELECT c.*, COUNT(r.id) AS requests, SUM(CASE WHEN r.status = 'open' THEN 1 ELSE 0 END) AS open_requests, MAX(r.requested_at) AS last_request
     FROM customers c LEFT JOIN idea_requests r ON r.customer_id = c.id AND r.status != 'archived'
     WHERE c.workspace_id = ? GROUP BY c.id ORDER BY c.name COLLATE NOCASE`,
  )
    .bind(ws.id)
    .all<CustomerRow & { requests: number; last_request: string | null }>();
  return rows.results;
}

export async function getCustomer(env: AppEnv, ws: WorkspaceRow, id: string) {
  const c = await env.DB.prepare("SELECT * FROM customers WHERE id = ? AND workspace_id = ?").bind(id, ws.id).first<CustomerRow>();
  if (!c) throw notFound("Customer");
  const reqs = await env.DB.prepare(
    `SELECT r.id, r.idea_id, r.customer_id, r.note, r.requested_at, r.added_by, r.times, r.status, r.pinned_at,
            i.title AS idea_title, i.status AS idea_status, i.stage AS idea_stage, i.labels AS idea_labels
     FROM idea_requests r JOIN ideas i ON i.id = r.idea_id WHERE r.customer_id = ?
     ORDER BY (r.pinned_at IS NULL), CASE r.status WHEN 'open' THEN 0 WHEN 'live' THEN 1 ELSE 2 END, r.requested_at DESC, r.created_at DESC`,
  )
    .bind(id)
    .all<{ id: string; idea_id: string; note: string; requested_at: string; added_by: string; idea_title: string; idea_status: string; idea_labels: string }>();
  return { ...c, requests: reqs.results.map((r) => ({ ...r, idea_labels: JSON.parse(r.idea_labels || "[]") })) };
}

// ---------- HTTP (signed-in people) ----------

type Vars = { me: MemberRow; ws: WorkspaceRow; actor: Actor };
export const customerRoutes = new Hono<{ Bindings: AppEnv; Variables: Vars }>();

customerRoutes.get("/api/customers", async (c) => c.json(await listCustomers(c.env, c.get("ws"))));
customerRoutes.get("/api/customers/:id", async (c) => c.json(await getCustomer(c.env, c.get("ws"), c.req.param("id"))));

customerRoutes.post("/api/customers", async (c) => c.json(await createCustomer(c.env, c.get("ws"), c.get("actor"), await c.req.json<CustomerInput>()), 201));

customerRoutes.patch("/api/customers/:id", async (c) => {
  const ws = c.get("ws");
  const id = c.req.param("id");
  await getCustomer(c.env, ws, id);
  const f = cleanFields(await c.req.json<CustomerInput>());
  if (f.name) {
    const dup = await c.env.DB.prepare("SELECT id FROM customers WHERE workspace_id = ? AND name = ? COLLATE NOCASE AND id != ?").bind(ws.id, f.name, id).first();
    if (dup) throw new HttpError(409, `There's already a customer called “${f.name}”`);
  }
  const cols = Object.keys(f);
  if (cols.length) {
    await c.env.DB.prepare(`UPDATE customers SET ${cols.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
      .bind(...cols.map((k) => (f as Record<string, unknown>)[k]), nowIso(), id)
      .run();
    await notify(c.env, ws.id, { type: "customers" });
  }
  return c.json(await getCustomer(c.env, ws, id));
});

customerRoutes.delete("/api/customers/:id", async (c) => {
  const me = c.get("me");
  const ws = c.get("ws");
  const cust = await getCustomer(c.env, ws, c.req.param("id"));
  if (me.role !== "admin" && cust.created_by !== me.id) throw forbidden("Only admins or whoever added this customer can delete it");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM idea_requests WHERE customer_id = ?").bind(cust.id),
    c.env.DB.prepare("DELETE FROM customers WHERE id = ?").bind(cust.id),
  ]);
  await logActivity(c.env, ws.id, c.get("actor"), "customer", cust.id, "deleted", { name: cust.name, requests: cust.requests.length });
  await notify(c.env, ws.id, { type: "customers" });
  await notify(c.env, ws.id, { type: "ideas" });
  return c.json({ ok: true });
});

// Add a customer to an idea ("they asked for this too").
customerRoutes.post("/api/ideas/:id/requests", async (c) => {
  const ws = c.get("ws");
  const b = await c.req.json<{ customer_id?: string; customer_name?: string; note?: string; requested_at?: string }>();
  const { customer } = await resolveCustomer(c.env, ws, c.get("actor"), { id: b.customer_id, name: b.customer_name });
  const r = await addRequest(c.env, ws, c.get("actor"), c.req.param("id"), customer, b.note, b.requested_at);
  return c.json({ ...r, idea: await getIdea(c.env, ws, c.req.param("id")) });
});

type ReqRow = {
  id: string;
  idea_id: string;
  customer_id: string;
  customer_name: string;
  note: string;
  requested_at: string;
  added_by: string;
  times: number;
  status: RequestStatus;
  pinned_at: string | null;
};

async function getRequest(env: AppEnv, ws: WorkspaceRow, id: string) {
  const r = await env.DB.prepare(
    "SELECT r.*, c.name AS customer_name FROM idea_requests r JOIN customers c ON c.id = r.customer_id WHERE r.id = ? AND c.workspace_id = ?",
  )
    .bind(id, ws.id)
    .first<ReqRow>();
  if (!r) throw notFound("Request");
  return r;
}

// Every customer request, with its customer and feature (the Requests tab).
customerRoutes.get("/api/idea-requests", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT r.id, r.idea_id, r.customer_id, r.note, r.requested_at, r.added_by, r.times, r.status, r.pinned_at, r.created_at,
            c.name AS customer_name, c.plan, c.mrr, i.title AS idea_title, i.stage AS idea_stage, i.status AS idea_status
     FROM idea_requests r JOIN customers c ON c.id = r.customer_id JOIN ideas i ON i.id = r.idea_id
     WHERE c.workspace_id = ? ORDER BY (r.pinned_at IS NULL), r.requested_at DESC, r.created_at DESC LIMIT 2000`,
  )
    .bind(c.get("ws").id)
    .all();
  return c.json(rows.results);
});

// Edit a request: what they said, when, how many times, open/live/archived, pinned, or which feature it's for.
customerRoutes.patch("/api/idea-requests/:id", async (c) => {
  const ws = c.get("ws");
  const r = await getRequest(c.env, ws, c.req.param("id"));
  const b = await c.req.json<{ note?: string; requested_at?: string; times?: number; status?: RequestStatus; pinned?: boolean; idea_id?: string }>();
  const next = { ...r };
  if (b.note !== undefined) next.note = String(b.note).trim().slice(0, 2000);
  if (b.requested_at !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.requested_at)) throw badRequest("Date must be YYYY-MM-DD");
    next.requested_at = b.requested_at;
  }
  if (b.times !== undefined) {
    const t = Math.round(Number(b.times));
    if (!(t >= 1 && t <= 9999)) throw badRequest("Times asked must be 1 or more");
    next.times = t;
  }
  if (b.status !== undefined) {
    if (!REQUEST_STATUSES.includes(b.status)) throw badRequest("Status must be open, live or archived");
    next.status = b.status;
  }
  if (b.pinned !== undefined) next.pinned_at = b.pinned ? (r.pinned_at ?? nowIso()) : null;
  const now = nowIso();
  if (b.idea_id && b.idea_id !== r.idea_id) {
    await getIdea(c.env, ws, b.idea_id);
    const clash = await c.env.DB.prepare("SELECT * FROM idea_requests WHERE idea_id = ? AND customer_id = ?").bind(b.idea_id, r.customer_id).first<ReqRow>();
    if (clash) {
      // This customer already asked for that feature: merge the two into one.
      await c.env.DB.batch([
        c.env.DB.prepare("UPDATE idea_requests SET times = ?, note = ?, requested_at = ?, updated_at = ? WHERE id = ?").bind(
          clash.times + next.times,
          [clash.note, next.note].filter(Boolean).join("\n\n"),
          clash.requested_at > next.requested_at ? clash.requested_at : next.requested_at,
          now,
          clash.id,
        ),
        c.env.DB.prepare("DELETE FROM idea_requests WHERE id = ?").bind(r.id),
      ]);
      await logActivity(c.env, ws.id, c.get("actor"), "idea", b.idea_id, "request_merged", { from_idea: r.idea_id }, { customer: r.customer_name });
      await notify(c.env, ws.id, { type: "ideas" });
      return c.json({ ...(await getRequest(c.env, ws, clash.id)), merged: true });
    }
    next.idea_id = b.idea_id;
  }
  await c.env.DB.prepare(
    "UPDATE idea_requests SET idea_id = ?, note = ?, requested_at = ?, times = ?, status = ?, pinned_at = ?, updated_at = ? WHERE id = ?",
  )
    .bind(next.idea_id, next.note, next.requested_at, next.times, next.status, next.pinned_at, now, r.id)
    .run();
  await logActivity(c.env, ws.id, c.get("actor"), "idea", next.idea_id, "request_updated", { status: r.status, times: r.times, idea_id: r.idea_id }, {
    customer: r.customer_name,
    status: next.status,
    times: next.times,
    idea_id: next.idea_id,
  });
  await notify(c.env, ws.id, { type: "ideas" });
  return c.json(await getRequest(c.env, ws, r.id));
});

customerRoutes.delete("/api/idea-requests/:id", async (c) => {
  const ws = c.get("ws");
  const me = c.get("me");
  const r = await getRequest(c.env, ws, c.req.param("id"));
  if (me.role !== "admin" && r.added_by !== me.id) throw forbidden("Only admins or whoever logged this request can delete it");
  await c.env.DB.prepare("DELETE FROM idea_requests WHERE id = ?").bind(r.id).run();
  await logActivity(c.env, ws.id, c.get("actor"), "idea", r.idea_id, "request_removed", { customer: r.customer_name, note: r.note, times: r.times });
  await notify(c.env, ws.id, { type: "ideas" });
  return c.json({ ok: true });
});

// Customer + feature in one go (creates either when new).
customerRoutes.post("/api/feature-requests", async (c) => {
  const b = await c.req.json<{
    customer_id?: string;
    customer_name?: string;
    customer?: CustomerInput;
    idea_id?: string;
    title?: string;
    body?: string;
    note?: string;
    requested_at?: string;
  }>();
  const out = await logFeatureRequest(
    c.env,
    c.get("ws"),
    c.get("actor"),
    {
      customer: { ...(b.customer ?? {}), id: b.customer_id, name: b.customer_name ?? b.customer?.name },
      ideaId: b.idea_id,
      title: b.title,
      body: b.body,
      note: b.note,
      requestedAt: b.requested_at,
    },
    (p) => c.executionCtx.waitUntil(p),
  );
  return c.json(out, 201);
});
