/**
 * Customers and feature requests. A feature request = a customer linked to an idea, with what they
 * said and when. Several customers can request the same idea; each customer counts once per idea.
 */
import { Hono } from "hono";
import type { Actor, MemberRow, WorkspaceRow } from "./domain";
import { logActivity, notify } from "./domain";
import { createIdea, getIdea } from "./ideas";
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
  await getIdea(env, ws, ideaId);
  const date = requestedAt && /^\d{4}-\d{2}-\d{2}$/.test(requestedAt) ? requestedAt : today();
  const text = (note ?? "").trim().slice(0, 2000);
  const existing = await env.DB.prepare("SELECT id FROM idea_requests WHERE idea_id = ? AND customer_id = ?").bind(ideaId, customer.id).first<{ id: string }>();
  if (existing) {
    await env.DB.prepare("UPDATE idea_requests SET note = CASE WHEN ? = '' THEN note ELSE ? END, requested_at = ? WHERE id = ?")
      .bind(text, text, date, existing.id)
      .run();
  } else {
    await env.DB.prepare("INSERT INTO idea_requests (id, idea_id, customer_id, note, requested_at, added_by, created_at) VALUES (?,?,?,?,?,?,?)")
      .bind(newId(), ideaId, customer.id, text, date, actor.member.id, nowIso())
      .run();
  }
  await logActivity(env, ws.id, actor, "idea", ideaId, "requested", undefined, { customer: customer.name, note: text });
  await notify(env, ws.id, { type: "ideas" });
  return { already: !!existing };
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
    `SELECT c.*, COUNT(r.id) AS requests, MAX(r.requested_at) AS last_request
     FROM customers c LEFT JOIN idea_requests r ON r.customer_id = c.id
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
    `SELECT r.id, r.idea_id, r.note, r.requested_at, r.added_by, i.title AS idea_title, i.status AS idea_status, i.labels AS idea_labels
     FROM idea_requests r JOIN ideas i ON i.id = r.idea_id WHERE r.customer_id = ? ORDER BY r.requested_at DESC, r.created_at DESC`,
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

customerRoutes.delete("/api/idea-requests/:id", async (c) => {
  const ws = c.get("ws");
  const r = await c.env.DB.prepare(
    "SELECT r.*, c.name AS customer_name FROM idea_requests r JOIN customers c ON c.id = r.customer_id WHERE r.id = ? AND c.workspace_id = ?",
  )
    .bind(c.req.param("id"), ws.id)
    .first<{ id: string; idea_id: string; customer_name: string; added_by: string }>();
  if (!r) throw notFound("Request");
  await c.env.DB.prepare("DELETE FROM idea_requests WHERE id = ?").bind(r.id).run();
  await logActivity(c.env, ws.id, c.get("actor"), "idea", r.idea_id, "request_removed", { customer: r.customer_name });
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
