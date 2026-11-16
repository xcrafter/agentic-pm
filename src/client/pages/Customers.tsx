import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building, Lightbulb, MessageSquareQuote, Pencil, Pin, PinOff, Plus, Search, Trash2, UserPlus, Users, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { type Customer, type CustomerRequest, type Idea, type IdeaRequest, type RequestListItem, type RequestStatus, api } from "../api";
import {
  Button,
  DeleteButton,
  EmptyState,
  IconButton,
  Menu,
  Modal,
  ModalFooter,
  Tag,
  TopBar,
  canDelete,
  cx,
  inputClass,
  textareaClass,
  timeAgo,
  useMe,
  useMembers,
} from "../components";

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

function FeaturePicker({ value, onChange, existingOnly }: { value: Feature; onChange: (v: Feature) => void; existingOnly?: boolean }) {
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
        placeholder={existingOnly ? "Search ideas" : "Search existing ideas, or describe a new feature"}
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
          {q.trim() && !existingOnly && (
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
        <ModalFooter hint="If this customer already asked for it, this counts as another ask on their request.">
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

export const REQ_STATUS: Record<RequestStatus, { label: string; tone: "blue" | "green" | "gray" }> = {
  open: { label: "Open", tone: "blue" },
  live: { label: "Live", tone: "green" },
  archived: { label: "Archived", tone: "gray" },
};

function useRequestActions() {
  const qc = useQueryClient();
  const refresh = () => {
    for (const k of ["ideas", "idea", "customers", "customer", "idea-requests"]) qc.invalidateQueries({ queryKey: [k] });
  };
  const patch = useMutation({ mutationFn: ({ id, ...b }: { id: string } & Record<string, unknown>) => api.patch(`/api/idea-requests/${id}`, b), onSettled: refresh });
  return { patch, refresh };
}

type RequestLike = Pick<IdeaRequest, "id" | "idea_id" | "note" | "requested_at" | "added_by" | "times" | "status" | "pinned_at"> & {
  customer_name?: string;
  idea_title?: string;
};

export function RequestStatusMenu({ r, onChange }: { r: RequestLike; onChange: (s: RequestStatus) => void }) {
  return (
    <Menu
      label="Request status"
      width="w-48"
      value={r.status}
      onChange={onChange}
      options={(["open", "live", "archived"] as RequestStatus[]).map((v) => ({ value: v, label: REQ_STATUS[v].label }))}
      trigger={
        <span className="flex h-6 items-center rounded-md px-0.5 hover:bg-hover">
          <Tag tone={REQ_STATUS[r.status].tone}>{REQ_STATUS[r.status].label}</Tag>
        </span>
      }
    />
  );
}

/** One customer request with pin, status, edit and delete. `title` is the customer (on an idea) or the feature (on a customer). */
function RequestItem({ r, title, plan }: { r: RequestLike; title: ReactNode; plan?: string | null }) {
  const me = useMe().data?.member;
  const members = useMembers();
  const { patch, refresh } = useRequestActions();
  const [editing, setEditing] = useState(false);
  return (
    <li className={cx("group rounded-lg border px-3 py-2", r.pinned_at ? "border-[#e5a00d]/40 bg-[#fff8e6] dark:bg-[#e5a00d]/10" : "border-line", r.status === "archived" && "opacity-70")}>
      <div className="flex items-center gap-1.5 text-[13px]">
        {r.pinned_at && <Pin size={12} className="shrink-0 text-[#e5a00d]" fill="currentColor" aria-label="Pinned" />}
        <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
        {plan && <Tag>{plan}</Tag>}
        {r.times > 1 && (
          <span className="shrink-0 rounded-[6px] bg-accent-soft px-1.5 text-[12px] leading-5 font-medium text-accent" title={`Asked ${r.times} times`}>
            {r.times}×
          </span>
        )}
        <RequestStatusMenu r={r} onChange={(status) => patch.mutate({ id: r.id, status })} />
      </div>
      {r.note && <p className="mt-1 text-[13px] leading-relaxed whitespace-pre-line text-ink-2">“{r.note}”</p>}
      <div className="mt-1 flex items-center gap-1 text-[12px] text-ink-3">
        <span title={`Logged by ${members.data?.find((m) => m.id === r.added_by)?.name ?? "someone"}`}>Last asked {r.requested_at}</span>
        <span className="ml-auto flex items-center gap-0.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
          <IconButton label={r.pinned_at ? "Unpin request" : "Pin request"} className="h-6 w-6" onClick={() => patch.mutate({ id: r.id, pinned: !r.pinned_at })}>
            {r.pinned_at ? <PinOff size={12} /> : <Pin size={12} />}
          </IconButton>
          <IconButton label="Edit request" className="h-6 w-6" onClick={() => setEditing(true)}>
            <Pencil size={12} />
          </IconButton>
          {canDelete(me, r.added_by) && (
            <DeleteButton icon what="request" name={typeof title === "string" ? title : undefined} onDelete={() => api.del(`/api/idea-requests/${r.id}`)} onDone={refresh} />
          )}
        </span>
      </div>
      <EditRequestModal open={editing} onClose={() => setEditing(false)} request={r} />
    </li>
  );
}

export function EditRequestModal({ open, onClose, request }: { open: boolean; onClose: () => void; request: RequestLike }) {
  const { patch } = useRequestActions();
  const [note, setNote] = useState(request.note);
  const [date, setDate] = useState(request.requested_at);
  const [times, setTimes] = useState(String(request.times));
  const [status, setStatus] = useState<RequestStatus>(request.status);
  const [feature, setFeature] = useState<Feature>(null);
  useEffect(() => {
    if (open) {
      setNote(request.note);
      setDate(request.requested_at);
      setTimes(String(request.times));
      setStatus(request.status);
      setFeature(null);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const moving = feature?.id && feature.id !== request.idea_id;
  return (
    <Modal open={open} onClose={onClose} title={<><Pencil size={15} className="text-ink-3" /> Edit request{request.customer_name ? ` from ${request.customer_name}` : ""}</>}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          patch.mutate(
            { id: request.id, note, requested_at: date, times: Number(times), status, ...(moving ? { idea_id: feature!.id } : {}) },
            { onSuccess: onClose },
          );
        }}
      >
        <div className="max-h-[70vh] space-y-4 overflow-y-auto p-4">
          <label className="block">
            <span className="mb-1.5 block text-[13px] font-medium">In their words</span>
            <textarea className={textareaClass} rows={4} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <div className="flex flex-wrap gap-3">
            <label className="block w-44">
              <span className="mb-1.5 block text-[13px] font-medium">Last asked</span>
              <input type="date" className={inputClass} value={date} max={today()} onChange={(e) => setDate(e.target.value)} />
            </label>
            <label className="block w-28">
              <span className="mb-1.5 block text-[13px] font-medium">Times asked</span>
              <input type="number" min={1} max={9999} className={inputClass} value={times} onChange={(e) => setTimes(e.target.value)} />
            </label>
          </div>
          <div>
            <span className="mb-1.5 block text-[13px] font-medium">Status</span>
            <div className="flex w-fit rounded-lg border border-line-strong bg-subtle p-0.5">
              {(["open", "live", "archived"] as RequestStatus[]).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={status === v}
                  onClick={() => setStatus(v)}
                  className={cx("h-7 rounded-md px-3 text-[12px] font-medium", status === v ? "bg-canvas text-ink shadow-btn" : "text-ink-3 hover:text-ink-2")}
                >
                  {REQ_STATUS[v].label}
                </button>
              ))}
            </div>
          </div>
          <label className="block">
            <span className="mb-1.5 block text-[13px] font-medium">Move to another feature (optional)</span>
            <FeaturePicker value={feature} onChange={setFeature} existingOnly />
            {request.idea_title && <span className="mt-1 block text-[12px] text-ink-3">Now: {request.idea_title}</span>}
            {moving && <span className="mt-1 block text-[12px] text-ink-3">If they already asked for that feature, the two requests are merged.</span>}
          </label>
          {patch.error && <p className="text-[13px] text-danger">{(patch.error as Error).message}</p>}
        </div>
        <ModalFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={patch.isPending || !(Number(times) >= 1)}>
            {patch.isPending ? "Saving…" : "Save changes"}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

/** "Requested by" list on an idea: customers who asked, how often, and whether it's open/live/archived for them. */
export function RequestsSection({ idea }: { idea: Idea }) {
  const detail = useQuery({ queryKey: ["idea", idea.id], queryFn: () => api.get<Idea>(`/api/ideas/${idea.id}`) });
  const [adding, setAdding] = useState(false);
  const reqs: IdeaRequest[] = detail.data?.requests ?? [];
  const active = reqs.filter((r) => r.status !== "archived");
  return (
    <div className="mt-5 border-t border-line pt-4">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-[13px] font-semibold">Requested by</h3>
        {active.length > 0 && (
          <span className="text-[12px] text-ink-3">
            {active.length} customer{active.length > 1 ? "s" : ""}
            {idea.request_times > active.length ? ` · asked ${idea.request_times}×` : ""}
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
          <RequestItem
            key={r.id}
            r={r}
            plan={r.plan}
            title={
              <Link to={`/customers?c=${r.customer_id}`} className="hover:underline">
                {r.customer_name}
              </Link>
            }
          />
        ))}
      </ul>
      <LogRequestModal open={adding} onClose={() => setAdding(false)} ideaId={idea.id} />
    </div>
  );
}

/** Every customer request, filterable by open / live / archived. */
function RequestsTab() {
  const [params, setParams] = useSearchParams();
  const status = (params.get("rs") as RequestStatus | "all" | null) ?? "open";
  const [q, setQ] = useState("");
  const all = useQuery({ queryKey: ["idea-requests"], queryFn: () => api.get<RequestListItem[]>("/api/idea-requests") });
  const { patch, refresh } = useRequestActions();
  const me = useMe().data?.member;
  const [editing, setEditing] = useState<RequestListItem | null>(null);
  const text = q.trim().toLowerCase();
  const rows = (all.data ?? []).filter(
    (r) => (status === "all" || r.status === status) && (!text || `${r.customer_name} ${r.idea_title} ${r.note}`.toLowerCase().includes(text)),
  );
  const count = (s: RequestStatus) => (all.data ?? []).filter((r) => r.status === s).length;
  const setStatus = (v: string) => {
    const next = new URLSearchParams(params);
    if (v === "open") next.delete("rs");
    else next.set("rs", v);
    setParams(next, { replace: true });
  };
  const cell = "h-11 border-r border-b border-line px-3 text-[13px] whitespace-nowrap";
  return (
    <>
      <div className="scroll-row flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 md:px-5">
        <div className="flex rounded-lg border border-line-strong bg-subtle p-0.5">
          {([["open", "Open"], ["live", "Live"], ["archived", "Archived"], ["all", "All"]] as const).map(([v, label]) => (
            <button
              key={v}
              aria-pressed={status === v}
              onClick={() => setStatus(v)}
              className={cx("h-6 rounded-md px-2 text-[12px] font-medium", status === v ? "bg-canvas text-ink shadow-btn" : "text-ink-3 hover:text-ink-2")}
            >
              {label}
              {v !== "all" && <span className="ml-1 tabular-nums text-ink-3">{count(v)}</span>}
            </button>
          ))}
        </div>
        <label className="flex h-7 w-60 items-center gap-1.5 rounded-lg border border-line-strong bg-canvas px-2 text-[12px] focus-within:border-accent/50">
          <Search size={13} className="shrink-0 text-ink-3" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search customer, feature or note" aria-label="Search requests" className="w-full min-w-0 bg-transparent outline-none placeholder:text-ink-3" />
        </label>
        <span className="text-[12px] text-ink-3 tabular-nums md:ml-auto">{rows.length} requests</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {all.isLoading ? (
          <p className="p-6 text-[13px] text-ink-3">Loading…</p>
        ) : !rows.length ? (
          <EmptyState icon={<MessageSquareQuote size={18} />} title={all.data?.length ? "No requests here" : "No requests yet"}>
            {status === "live" ? "When a requested idea goes live, its requests move here so you know who to tell." : "Log what customers ask for and it shows up here."}
          </EmptyState>
        ) : (
          <table className="w-full min-w-[860px] border-separate border-spacing-0">
            <thead className="sticky top-0 z-10 bg-canvas">
              <tr>
                {["", "Customer", "Feature", "Asked", "Status", "Last asked", ""].map((h, i) => (
                  <th key={i} className={cx("h-9 border-b border-line px-3 text-left text-[12px] font-medium text-ink-3", i > 0 && i < 6 && "border-r", i === 3 && "text-right")}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={cx("group hover:bg-hover", r.status === "archived" && "text-ink-2")}>
                  <td className="w-9 border-b border-line pl-2">
                    <IconButton
                      label={r.pinned_at ? "Unpin request" : "Pin request"}
                      className={cx("h-6 w-6", r.pinned_at ? "text-[#e5a00d]" : "opacity-0 group-hover:opacity-100 focus:opacity-100")}
                      onClick={() => patch.mutate({ id: r.id, pinned: !r.pinned_at })}
                    >
                      <Pin size={13} fill={r.pinned_at ? "currentColor" : "none"} />
                    </IconButton>
                  </td>
                  <td className={cx(cell, "max-w-[200px]")}>
                    <Link to={`/customers?c=${r.customer_id}`} className="block truncate font-medium hover:underline">
                      {r.customer_name}
                    </Link>
                  </td>
                  <td className={cx(cell, "max-w-[360px]")}>
                    <Link to={`/ideas?idea=${r.idea_id}&stage=all`} className="block truncate hover:underline" title={r.note || undefined}>
                      {r.idea_title}
                    </Link>
                  </td>
                  <td className={cx(cell, "text-right tabular-nums")}>{r.times}×</td>
                  <td className={cell}>
                    <RequestStatusMenu r={r} onChange={(st) => patch.mutate({ id: r.id, status: st })} />
                  </td>
                  <td className={cx(cell, "text-ink-3")}>{r.requested_at}</td>
                  <td className="w-20 border-b border-line px-1">
                    <span className="flex items-center gap-0.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
                      <IconButton label="Edit request" className="h-6 w-6" onClick={() => setEditing(r)}>
                        <Pencil size={12} />
                      </IconButton>
                      {canDelete(me, r.added_by) && (
                        <DeleteButton icon what="request" name={`${r.customer_name}: ${r.idea_title}`} onDelete={() => api.del(`/api/idea-requests/${r.id}`)} onDone={refresh} />
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {editing && <EditRequestModal open onClose={() => setEditing(null)} request={editing} />}
    </>
  );
}

// ---------- Customers page ----------

export function CustomersPage() {
  const [params, setParams] = useSearchParams();
  const selected = params.get("c");
  const tab = params.get("tab") === "requests" ? "requests" : "customers";
  const customers = useCustomers();
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [logging, setLogging] = useState(false);
  const text = q.trim().toLowerCase();
  const rows = (customers.data ?? []).filter((c) => !text || c.name.toLowerCase().includes(text) || (c.domain ?? "").includes(text) || (c.plan ?? "").toLowerCase().includes(text));
  const pick = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set("c", id);
    else next.delete("c");
    setParams(next, { replace: true });
  };
  const setTab = (t: string) => setParams(t === "requests" ? { tab: "requests" } : {}, { replace: true });
  const cell = "h-11 border-r border-b border-line px-3 text-[13px] whitespace-nowrap";

  return (
    <div className="flex h-full flex-col">
      <TopBar
        crumbs={[{ label: "Customers", icon: <Users size={15} className="text-ink-3" /> }]}
        actions={
          <>
            <Button onClick={() => setLogging(true)} aria-label="Log request">
              <MessageSquareQuote size={14} /> <span className="hidden sm:inline">Log request</span>
            </Button>
            <Button variant="primary" onClick={() => setAdding(true)} aria-label="Add customer">
              <Plus size={15} /> <span className="hidden sm:inline">Add customer</span>
            </Button>
          </>
        }
      />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-10 shrink-0 items-end gap-4 border-b border-line px-3 md:px-5" role="tablist">
            {([["customers", "Customers"], ["requests", "Requests"]] as const).map(([v, label]) => (
              <button
                key={v}
                role="tab"
                aria-selected={tab === v}
                onClick={() => setTab(v)}
                className={cx("-mb-px h-9 border-b-2 px-0.5 text-[13px] font-medium", tab === v ? "border-ink text-ink" : "border-transparent text-ink-3 hover:text-ink-2")}
              >
                {label}
              </button>
            ))}
          </div>
          {tab === "requests" ? (
            <RequestsTab />
          ) : (
          <>
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
          </>
          )}
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
            What they've asked for <span className="font-normal text-ink-3">({c.requests.filter((r) => r.status === "open").length} open of {c.requests.length})</span>
          </h3>
          {!c.requests.length && <p className="text-[12px] text-ink-3">No requests yet.</p>}
          <ul className="space-y-1.5">
            {c.requests.map((r) => (
              <RequestItem
                key={r.id}
                r={{ ...r, customer_name: c.name }}
                title={
                  <Link to={`/ideas?idea=${r.idea_id}&stage=all`} className="hover:underline">
                    {r.idea_title}
                  </Link>
                }
              />
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
