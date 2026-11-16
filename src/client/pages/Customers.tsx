import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building, Lightbulb, MessageSquareQuote, Plus, Search, Trash2, UserPlus, Users, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { type Customer, type CustomerRequest, type Idea, type IdeaRequest, api } from "../api";
import { Button, EmptyState, IconButton, Modal, ModalFooter, Tag, TopBar, canDelete, cx, inputClass, textareaClass, timeAgo, useMe, useMembers } from "../components";

export const useCustomers = () => useQuery({ queryKey: ["customers"], queryFn: () => api.get<(Customer & { requests: number })[]>("/api/customers") });
const today = () => new Date().toISOString().slice(0, 10);
export const money = (n: number | null | undefined) => (n == null ? "" : `$${n >= 1000 ? `${Math.round(n / 100) / 10}k` : Math.round(n)}`);

type Picked = { id?: string; name: string } | null;

/** Pick an existing customer or type a new name (created when the request is saved). */
export function CustomerPicker({ value, onChange, autoFocus }: { value: Picked; onChange: (v: Picked) => void; autoFocus?: boolean }) {
  const customers = useCustomers();
  const [q, setQ] = useState(value?.name ?? "");
  const [open, setOpen] = useState(false);
  const text = q.trim().toLowerCase();
  const matches = (customers.data ?? []).filter((c) => !text || c.name.toLowerCase().includes(text) || (c.domain ?? "").includes(text)).slice(0, 6);
  const exact = (customers.data ?? []).find((c) => c.name.toLowerCase() === text);
  return (
    <div>
      <input
        autoFocus={autoFocus}
        className={inputClass}
        value={q}
        placeholder="Search customers or type a new one"
        aria-label="Customer"
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          const t = e.target.value.trim();
          const hit = (customers.data ?? []).find((c) => c.name.toLowerCase() === t.toLowerCase());
          onChange(t ? (hit ? { id: hit.id, name: hit.name } : { name: t }) : null);
        }}
      />
      {open && (matches.length > 0 || (text && !exact)) && (
        <div className="mt-1 overflow-hidden rounded-lg border border-line bg-canvas">
          {matches.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => (onChange({ id: c.id, name: c.name }), setQ(c.name), setOpen(false))}
              className={cx("flex h-9 w-full items-center gap-2 px-2.5 text-left text-[13px] hover:bg-hover", value?.id === c.id && "bg-active")}
            >
              <Building size={13} className="shrink-0 text-ink-3" />
              <span className="truncate font-medium">{c.name}</span>
              {c.plan && <span className="text-[12px] text-ink-3">{c.plan}</span>}
              <span className="ml-auto text-[12px] text-ink-3">{c.domain}</span>
            </button>
          ))}
          {text && !exact && (
            <button
              type="button"
              onClick={() => (onChange({ name: q.trim() }), setOpen(false))}
              className="flex h-9 w-full items-center gap-2 border-t border-line px-2.5 text-left text-[13px] text-accent hover:bg-hover"
            >
              <UserPlus size={13} /> Add new customer “{q.trim()}”
            </button>
          )}
        </div>
      )}
      {value && !value.id && !open && <p className="mt-1 text-[12px] text-ink-3">A new customer “{value.name}” will be added.</p>}
    </div>
  );
}

type Feature = { id?: string; title: string } | null;

function FeaturePicker({ value, onChange }: { value: Feature; onChange: (v: Feature) => void }) {
  const ideas = useQuery({ queryKey: ["ideas"], queryFn: () => api.get<{ labels: string[]; ideas: Idea[] }>("/api/ideas") });
  const [q, setQ] = useState(value?.title ?? "");
  const [open, setOpen] = useState(false);
  const words = q.trim().toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const all = ideas.data?.ideas ?? [];
  const matches = (words.length ? all.filter((i) => words.some((w) => i.title.toLowerCase().includes(w))) : all)
    .sort((a, b) => b.request_count - a.request_count)
    .slice(0, 6);
  return (
    <div>
      <input
        className={inputClass}
        value={q}
        placeholder="Search existing ideas, or describe a new feature"
        aria-label="Feature"
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          onChange(e.target.value.trim() ? { title: e.target.value.trim() } : null);
        }}
      />
      {open && (matches.length > 0 || q.trim()) && (
        <div className="mt-1 overflow-hidden rounded-lg border border-line bg-canvas">
          {matches.map((i) => (
            <button
              key={i.id}
              type="button"
              onClick={() => (onChange({ id: i.id, title: i.title }), setQ(i.title), setOpen(false))}
              className={cx("flex min-h-9 w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] hover:bg-hover", value?.id === i.id && "bg-active")}
            >
              <Lightbulb size={13} className="shrink-0 text-ink-3" />
              <span className="min-w-0 flex-1 truncate">{i.title}</span>
              {i.request_count > 0 && <span className="shrink-0 text-[12px] text-ink-3">{i.request_count} asked</span>}
            </button>
          ))}
          {q.trim() && (
            <button
              type="button"
              onClick={() => (onChange({ title: q.trim() }), setOpen(false))}
              className="flex h-9 w-full items-center gap-2 border-t border-line px-2.5 text-left text-[13px] text-accent hover:bg-hover"
            >
              <Plus size={13} /> New idea: “{q.trim().slice(0, 60)}”
            </button>
          )}
        </div>
      )}
      {value && !value.id && !open && <p className="mt-1 text-[12px] text-ink-3">A new idea will be added and labelled automatically.</p>}
    </div>
  );
}

/** "A customer asked for X": customer (existing or new) + feature (existing idea or new). */
export function LogRequestModal({ open, onClose, ideaId, onLogged }: { open: boolean; onClose: () => void; ideaId?: string; onLogged?: (ideaId: string) => void }) {
  const qc = useQueryClient();
  const [customer, setCustomer] = useState<Picked>(null);
  const [feature, setFeature] = useState<Feature>(null);
  const [note, setNote] = useState("");
  const [date, setDate] = useState(today());
  useEffect(() => {
    if (open) {
      setCustomer(null);
      setFeature(null);
      setNote("");
      setDate(today());
    }
  }, [open]);
  const save = useMutation({
    mutationFn: () =>
      api.post<{ idea: Idea; already_requested: boolean }>("/api/feature-requests", {
        customer_id: customer?.id,
        customer_name: customer?.name,
        idea_id: ideaId ?? feature?.id,
        title: ideaId ? undefined : feature?.title,
        note,
        requested_at: date,
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["ideas"] });
      qc.invalidateQueries({ queryKey: ["idea"] });
      qc.invalidateQueries({ queryKey: ["customers"] });
      onLogged?.(r.idea.id);
      onClose();
    },
  });
  const ready = !!customer && (ideaId || feature);
  return (
    <Modal open={open} onClose={onClose} wide title={<><MessageSquareQuote size={16} className="text-ink-3" /> Log a feature request</>}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) save.mutate();
        }}
      >
        <div className="max-h-[70vh] space-y-4 overflow-y-auto p-4">
          <label className="block">
            <span className="mb-1.5 block text-[13px] font-medium">Customer</span>
            <CustomerPicker value={customer} onChange={setCustomer} autoFocus />
          </label>
          {!ideaId && (
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-medium">What they asked for</span>
              <FeaturePicker value={feature} onChange={setFeature} />
            </label>
          )}
          <label className="block">
            <span className="mb-1.5 block text-[13px] font-medium">In their words (optional)</span>
            <textarea className={textareaClass} rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="“We'd switch from GRIN if we could pay creators here.”" />
          </label>
          <label className="block w-44">
            <span className="mb-1.5 block text-[13px] font-medium">Requested on</span>
            <input type="date" className={inputClass} value={date} max={today()} onChange={(e) => setDate(e.target.value)} />
          </label>
          {save.error && <p className="text-[13px] text-danger">{(save.error as Error).message}</p>}
        </div>
        <ModalFooter hint="The same customer asking again updates their request instead of counting twice.">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ready || save.isPending}>
            {save.isPending ? "Saving…" : "Log request"}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

/** "Requested by" list on an idea, with add/remove. */
export function RequestsSection({ idea }: { idea: Idea }) {
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ["idea", idea.id], queryFn: () => api.get<Idea>(`/api/ideas/${idea.id}`) });
  const members = useMembers();
  const [adding, setAdding] = useState(false);
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/idea-requests/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ideas"] });
      qc.invalidateQueries({ queryKey: ["idea", idea.id] });
      qc.invalidateQueries({ queryKey: ["customers"] });
    },
  });
  const reqs: IdeaRequest[] = detail.data?.requests ?? [];
  return (
    <div className="mt-5 border-t border-line pt-4">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-[13px] font-semibold">Requested by</h3>
        {reqs.length > 0 && (
          <span className="text-[12px] text-ink-3">
            {reqs.length} customer{reqs.length > 1 ? "s" : ""}
            {idea.request_mrr ? ` · ${money(idea.request_mrr)} MRR` : ""}
          </span>
        )}
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setAdding(true)}>
          <Plus size={13} /> Add customer
        </Button>
      </div>
      {!reqs.length && <p className="text-[12px] text-ink-3">No customer has asked for this yet. Add one when a customer requests it.</p>}
      <ul className="space-y-1.5">
        {reqs.map((r) => (
          <li key={r.id} className="group rounded-lg border border-line px-3 py-2">
            <div className="flex items-center gap-2 text-[13px]">
              <Link to={`/customers?c=${r.customer_id}`} className="truncate font-medium hover:underline">
                {r.customer_name}
              </Link>
              {r.plan && <Tag>{r.plan}</Tag>}
              <span className="ml-auto shrink-0 text-[12px] text-ink-3" title={`Added by ${members.data?.find((m) => m.id === r.added_by)?.name ?? "someone"}`}>
                {r.requested_at}
              </span>
              <IconButton label={`Remove ${r.customer_name}'s request`} className="h-6 w-6 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-danger" onClick={() => remove.mutate(r.id)}>
                <X size={12} />
              </IconButton>
            </div>
            {r.note && <p className="mt-1 text-[13px] leading-relaxed text-ink-2">“{r.note}”</p>}
          </li>
        ))}
      </ul>
      <LogRequestModal open={adding} onClose={() => setAdding(false)} ideaId={idea.id} />
    </div>
  );
}

// ---------- Customers page ----------

export function CustomersPage() {
  const [params, setParams] = useSearchParams();
  const selected = params.get("c");
  const customers = useCustomers();
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [logging, setLogging] = useState(false);
  const text = q.trim().toLowerCase();
  const rows = (customers.data ?? []).filter((c) => !text || c.name.toLowerCase().includes(text) || (c.domain ?? "").includes(text) || (c.plan ?? "").toLowerCase().includes(text));
  const pick = (id: string | null) => setParams(id ? { c: id } : {}, { replace: true });
  const cell = "h-11 border-r border-b border-line px-3 text-[13px] whitespace-nowrap";

  return (
    <div className="flex h-full flex-col">
      <TopBar
        crumbs={[{ label: "Customers", icon: <Users size={15} className="text-ink-3" /> }]}
        actions={
          <>
            <Button onClick={() => setLogging(true)}>
              <MessageSquareQuote size={14} /> Log request
            </Button>
            <Button variant="primary" onClick={() => setAdding(true)}>
              <Plus size={15} /> Add customer
            </Button>
          </>
        }
      />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-line px-3 py-2 md:px-5">
            <label className="flex h-7 w-60 items-center gap-1.5 rounded-lg border border-line-strong bg-canvas px-2 text-[12px] focus-within:border-accent/50">
              <Search size={13} className="shrink-0 text-ink-3" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, domain or plan" aria-label="Search customers" className="w-full min-w-0 bg-transparent outline-none placeholder:text-ink-3" />
            </label>
            <span className="ml-auto text-[12px] text-ink-3 tabular-nums">{rows.length} customers</span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {customers.isLoading ? (
              <p className="p-6 text-[13px] text-ink-3">Loading…</p>
            ) : !rows.length ? (
              <EmptyState
                icon={<Users size={18} />}
                title={customers.data?.length ? "No customers match" : "No customers yet"}
                action={
                  <Button variant="primary" onClick={() => setLogging(true)}>
                    <MessageSquareQuote size={14} /> Log a request
                  </Button>
                }
              >
                Add customers as their requests come in. You can see what each one asked for, and which features most customers want.
              </EmptyState>
            ) : (
              <table className="w-full min-w-[720px] border-separate border-spacing-0">
                <thead className="sticky top-0 z-10 bg-canvas">
                  <tr>
                    {["Customer", "Plan", "MRR", "Requests", "Last request"].map((h, i) => (
                      <th key={h} className={cx("h-9 border-r border-b border-line px-3 text-[12px] font-medium text-ink-3", i === 2 || i === 3 ? "text-right" : "text-left")}>
                        {h}
                      </th>
                    ))}
                    <th className="border-b border-line" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.id} onClick={() => pick(c.id)} className={cx("cursor-pointer hover:bg-hover", selected === c.id && "bg-active")}>
                      <td className={cx(cell, "max-w-[280px]")}>
                        <div className="truncate font-medium">{c.name}</div>
                      </td>
                      <td className={cell}>{c.plan ? <Tag>{c.plan}</Tag> : <span className="text-ink-3">—</span>}</td>
                      <td className={cx(cell, "text-right tabular-nums")}>{c.mrr != null ? money(c.mrr) : <span className="text-ink-3">—</span>}</td>
                      <td className={cx(cell, "text-right tabular-nums")}>{c.requests || <span className="text-ink-3">0</span>}</td>
                      <td className={cx(cell, "text-ink-3")}>{c.last_request ?? "—"}</td>
                      <td className="border-b border-line" />
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
        {selected && <CustomerPanel key={selected} id={selected} onClose={() => pick(null)} />}
      </div>
      <CustomerModal open={adding} onClose={() => setAdding(false)} onSaved={(c) => pick(c.id)} />
      <LogRequestModal open={logging} onClose={() => setLogging(false)} />
    </div>
  );
}

function CustomerModal({ open, onClose, onSaved, customer }: { open: boolean; onClose: () => void; onSaved?: (c: Customer) => void; customer?: Customer }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ name: "", domain: "", email: "", plan: "", mrr: "", notes: "" });
  useEffect(() => {
    if (open)
      setF({
        name: customer?.name ?? "",
        domain: customer?.domain ?? "",
        email: customer?.email ?? "",
        plan: customer?.plan ?? "",
        mrr: customer?.mrr != null ? String(customer.mrr) : "",
        notes: customer?.notes ?? "",
      });
  }, [open, customer]);
  const save = useMutation({
    mutationFn: () => (customer ? api.patch<Customer>(`/api/customers/${customer.id}`, f) : api.post<Customer>("/api/customers", f)),
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["customer"] });
      onSaved?.(c);
      onClose();
    },
  });
  const field = (k: keyof typeof f, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-medium">{label}</span>
      <input className={inputClass} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} {...props} />
    </label>
  );
  return (
    <Modal open={open} onClose={onClose} title={customer ? `Edit ${customer.name}` : "Add customer"}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (f.name.trim()) save.mutate();
        }}
      >
        <div className="space-y-3 p-4">
          {field("name", "Name", { autoFocus: true, placeholder: "Brand or company", required: true })}
          <div className="grid grid-cols-2 gap-3">
            {field("domain", "Store or website", { placeholder: "brand.myshopify.com" })}
            {field("email", "Contact email", { type: "email" })}
            {field("plan", "Plan", { placeholder: "Growth" })}
            {field("mrr", "MRR", { inputMode: "decimal", placeholder: "99" })}
          </div>
          <label className="block">
            <span className="mb-1.5 block text-[13px] font-medium">Notes</span>
            <textarea className={textareaClass} rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
          </label>
          {save.error && <p className="text-[13px] text-danger">{(save.error as Error).message}</p>}
        </div>
        <ModalFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!f.name.trim() || save.isPending}>
            {save.isPending ? "Saving…" : customer ? "Save" : "Add customer"}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

function CustomerPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const me = useMe().data?.member;
  const q = useQuery({ queryKey: ["customer", id], queryFn: () => api.get<Customer & { requests: CustomerRequest[] }>(`/api/customers/${id}`) });
  const [editing, setEditing] = useState(false);
  const [logging, setLogging] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const del = useMutation({
    mutationFn: () => api.del(`/api/customers/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["ideas"] });
      onClose();
    },
  });
  const c = q.data;
  return (
    <aside className="fixed inset-0 z-40 flex flex-col bg-canvas md:static md:z-auto md:w-[420px] md:shrink-0 md:border-l md:border-line">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
        <Building size={15} className="text-ink-3" />
        <span className="truncate text-[14px] font-semibold">{c?.name ?? "Customer"}</span>
        <IconButton label="Close" className="ml-auto" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </div>
      {!c ? (
        <p className="p-4 text-[13px] text-ink-3">{q.error ? (q.error as Error).message : "Loading…"}</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
          <dl className="grid grid-cols-[110px_1fr] gap-y-2 text-[13px]">
            <dt className="text-ink-3">Store / site</dt>
            <dd className="truncate">{c.domain ? <a className="text-accent hover:underline" href={`https://${c.domain}`} target="_blank" rel="noreferrer noopener">{c.domain}</a> : "—"}</dd>
            <dt className="text-ink-3">Email</dt>
            <dd className="truncate">{c.email ?? "—"}</dd>
            <dt className="text-ink-3">Plan</dt>
            <dd>{c.plan ? <Tag>{c.plan}</Tag> : "—"}</dd>
            <dt className="text-ink-3">MRR</dt>
            <dd>{c.mrr != null ? money(c.mrr) : "—"}</dd>
            <dt className="text-ink-3">Added</dt>
            <dd className="text-ink-2">{timeAgo(c.created_at)}</dd>
          </dl>
          {c.notes && <p className="mt-3 rounded-lg bg-panel px-3 py-2 text-[13px] text-ink-2">{c.notes}</p>}
          <div className="mt-3 flex gap-2">
            <Button size="sm" onClick={() => setEditing(true)}>
              Edit details
            </Button>
            <Button size="sm" variant="primary" onClick={() => setLogging(true)}>
              <MessageSquareQuote size={13} /> Log a request
            </Button>
          </div>

          <h3 className="mt-6 mb-2 text-[13px] font-semibold">
            What they've asked for <span className="font-normal text-ink-3">({c.requests.length})</span>
          </h3>
          {!c.requests.length && <p className="text-[12px] text-ink-3">No requests yet.</p>}
          <ul className="space-y-1.5">
            {c.requests.map((r) => (
              <li key={r.id} className="rounded-lg border border-line px-3 py-2">
                <div className="flex items-center gap-2 text-[13px]">
                  <Link to={`/ideas?idea=${r.idea_id}&status=all`} className="min-w-0 flex-1 truncate font-medium hover:underline">
                    {r.idea_title}
                  </Link>
                  {r.idea_status === "converted" && <Tag tone="green">Task created</Tag>}
                  <span className="shrink-0 text-[12px] text-ink-3">{r.requested_at}</span>
                </div>
                {r.note && <p className="mt-1 text-[13px] leading-relaxed text-ink-2">“{r.note}”</p>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {c && canDelete(me, c.created_by) && (
        <div className="flex shrink-0 justify-end border-t border-line px-4 py-2">
          {confirm ? (
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-ink-2">Delete {c.name} and their {c.requests.length} request(s)?</span>
              <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
                Cancel
              </Button>
              <Button size="sm" variant="danger" onClick={() => del.mutate()} disabled={del.isPending}>
                Delete
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="ghost" className="hover:text-danger" onClick={() => setConfirm(true)}>
              <Trash2 size={13} /> Delete customer
            </Button>
          )}
        </div>
      )}
      {c && <CustomerModal open={editing} onClose={() => setEditing(false)} customer={c} />}
      {c && <LogRequestModalForCustomer open={logging} onClose={() => setLogging(false)} customer={c} />}
    </aside>
  );
}

/** Log a request for a known customer (customer pre-filled). */
function LogRequestModalForCustomer({ open, onClose, customer }: { open: boolean; onClose: () => void; customer: Customer }) {
  const qc = useQueryClient();
  const [feature, setFeature] = useState<Feature>(null);
  const [note, setNote] = useState("");
  const [date, setDate] = useState(today());
  useEffect(() => {
    if (open) (setFeature(null), setNote(""), setDate(today()));
  }, [open]);
  const save = useMutation({
    mutationFn: () => api.post("/api/feature-requests", { customer_id: customer.id, idea_id: feature?.id, title: feature?.id ? undefined : feature?.title, note, requested_at: date }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ideas"] });
      qc.invalidateQueries({ queryKey: ["customer", customer.id] });
      qc.invalidateQueries({ queryKey: ["customers"] });
      onClose();
    },
  });
  return (
    <Modal open={open} onClose={onClose} wide title={`What did ${customer.name} ask for?`}>
      <form onSubmit={(e) => (e.preventDefault(), feature && save.mutate())}>
        <div className="space-y-4 p-4">
          <FeaturePicker value={feature} onChange={setFeature} />
          <textarea className={textareaClass} rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="In their words (optional)" aria-label="Note" />
          <input type="date" className={cx(inputClass, "w-44")} value={date} max={today()} onChange={(e) => setDate(e.target.value)} aria-label="Requested on" />
          {save.error && <p className="text-[13px] text-danger">{(save.error as Error).message}</p>}
        </div>
        <ModalFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!feature || save.isPending}>
            Log request
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
