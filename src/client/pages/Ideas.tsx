import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, ExternalLink, Lightbulb, MessageSquareQuote, Plus, Search, Sparkles, Trash2, Users, Wand2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { type Idea, type IdeaStatus, type Member, api } from "../api";
import {
  AgentBadge,
  Avatar,
  Button,
  EmptyState,
  IconButton,
  Markdown,
  MemberChip,
  Menu,
  MultiSelect,
  Tag,
  TopBar,
  assigneeOptions,
  canDelete,
  cx,
  inputClass,
  timeAgo,
  useMe,
  useMembers,
} from "../components";
import { type EditorHandle, RichEditor } from "../editor";
import { LogRequestModal, RequestsSection, money } from "./Customers";

type Tone = "gray" | "blue" | "green" | "amber" | "orange" | "red" | "violet" | "teal" | "pink";
const LABEL_TONE: Record<string, Tone> = {
  feature: "blue",
  improvement: "teal",
  ai: "violet",
  integration: "gray",
  analytics: "amber",
  marketing: "pink",
  sales: "orange",
  content: "green",
  pricing: "red",
  operations: "gray",
  research: "amber",
  ux: "teal",
};
const LABEL_NAME: Record<string, string> = {
  feature: "Feature",
  improvement: "Improvement",
  ai: "AI",
  integration: "Integration",
  analytics: "Analytics",
  marketing: "Marketing",
  sales: "Sales",
  content: "Content",
  pricing: "Pricing",
  operations: "Operations",
  research: "Research",
  ux: "UX",
};
const STATUS: Record<IdeaStatus, { label: string; tone: Tone }> = {
  new: { label: "New", tone: "gray" },
  exploring: { label: "Exploring", tone: "blue" },
  planned: { label: "Planned", tone: "violet" },
  converted: { label: "Task created", tone: "green" },
  parked: { label: "Parked", tone: "amber" },
};
type StatusFilter = "open" | "all" | IdeaStatus;

export function IdeaLabel({ label }: { label: string }) {
  return <Tag tone={LABEL_TONE[label] ?? "gray"}>{LABEL_NAME[label] ?? label}</Tag>;
}

/** Product ideas: log concepts, let AI label them and suggest an owner, filter, and convert to tasks. */
export function IdeasPage() {
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("idea");
  const labelsParam = params.get("labels");
  const labels = labelsParam ? labelsParam.split(",") : [];
  const status = (params.get("status") as StatusFilter) || "open";
  const owner = params.get("owner");
  const requestedOnly = params.get("requested") === "1";
  const sort = (params.get("sort") as "new" | "requests" | "mrr") || "new";
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [logging, setLogging] = useState(false);
  const members = useMembers();
  const byId = new Map((members.data ?? []).map((m) => [m.id, m]));
  const ideas = useQuery({ queryKey: ["ideas"], queryFn: () => api.get<{ labels: string[]; ideas: Idea[] }>("/api/ideas") });
  const all = ideas.data?.ideas ?? [];
  const allLabels = ideas.data?.labels ?? [];
  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  const byStatus = all.filter((i) =>
    status === "all" ? true : status === "open" ? i.status === "new" || i.status === "exploring" || i.status === "planned" : i.status === status,
  );
  const text = q.trim().toLowerCase();
  const list = byStatus.filter(
    (i) =>
      (!requestedOnly || i.request_count > 0) &&
      (!labels.length || labels.every((l) => i.labels.includes(l))) &&
      (!owner || (owner === "none" ? !i.suggested_owner_id : i.suggested_owner_id === owner)) &&
      (!text || i.title.toLowerCase().includes(text) || i.body.toLowerCase().includes(text)),
  );
  if (sort === "requests") list.sort((a, b) => b.request_count - a.request_count || b.request_mrr - a.request_mrr);
  if (sort === "mrr") list.sort((a, b) => b.request_mrr - a.request_mrr || b.request_count - a.request_count);
  const labelCounts = new Map(allLabels.map((l) => [l, byStatus.filter((i) => i.labels.includes(l)).length]));
  const selected = all.find((i) => i.id === selectedId) ?? null;
  const ownerName = owner === "none" ? "No owner" : owner ? byId.get(owner)?.name : null;

  return (
    <div className="flex h-full flex-col">
      <TopBar
        crumbs={[{ label: "Ideas", icon: <Lightbulb size={15} className="text-ink-3" /> }]}
        actions={
          <>
            <Button onClick={() => setLogging(true)}>
              <MessageSquareQuote size={14} /> <span className="hidden sm:inline">Log customer request</span>
              <span className="sm:hidden">Request</span>
            </Button>
            <Button variant="primary" onClick={() => setAdding(true)}>
              <Plus size={15} /> New idea
            </Button>
          </>
        }
      />
      <LogRequestModal open={logging} onClose={() => setLogging(false)} onLogged={(id) => setParam("idea", id)} />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="space-y-2 border-b border-line px-3 py-2 md:px-5">
            <div className="scroll-row flex flex-wrap items-center gap-2">
              <div className="flex rounded-lg border border-line-strong bg-subtle p-0.5">
                {(
                  [
                    ["open", "Open"],
                    ["converted", "Task created"],
                    ["parked", "Parked"],
                    ["all", "All"],
                  ] as [StatusFilter, string][]
                ).map(([v, label]) => (
                  <button
                    key={v}
                    aria-pressed={status === v}
                    onClick={() => setParam("status", v === "open" ? null : v)}
                    className={cx("h-6 rounded-md px-2 text-[12px] font-medium", status === v ? "bg-canvas text-ink shadow-btn" : "text-ink-3 hover:text-ink-2")}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <label className="flex h-7 w-52 items-center gap-1.5 rounded-lg border border-line-strong bg-canvas px-2 text-[12px] focus-within:border-accent/50">
                <Search size={13} className="shrink-0 text-ink-3" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search ideas" aria-label="Search ideas" className="w-full min-w-0 bg-transparent outline-none placeholder:text-ink-3" />
              </label>
              <Menu
                searchable
                label="Filter by suggested owner"
                trigger={
                  <span className={cx("inline-flex h-7 items-center gap-1.5 rounded-lg border px-2 text-[12px] font-medium", owner ? "border-accent/30 bg-accent-soft text-accent" : "border-line-strong bg-canvas text-ink-2 shadow-btn hover:bg-hover")}>
                    {ownerName ? `Owner: ${ownerName}` : "Suggested owner"}
                  </span>
                }
                value={owner ?? "any"}
                onChange={(v) => setParam("owner", v === "any" ? null : v)}
                options={[{ value: "any", label: "Anyone" }, ...assigneeOptions(members.data).map((o) => (o.value === "none" ? { ...o, label: "No owner" } : o))]}
              />
              <button
                aria-pressed={requestedOnly}
                onClick={() => setParam("requested", requestedOnly ? null : "1")}
                className={cx(
                  "inline-flex h-7 items-center gap-1.5 rounded-lg border px-2 text-[12px] font-medium",
                  requestedOnly ? "border-accent/30 bg-accent-soft text-accent" : "border-line-strong bg-canvas text-ink-2 shadow-btn hover:bg-hover",
                )}
              >
                <Users size={13} /> Requested by customers
              </button>
              <Menu
                label="Sort ideas"
                align="right"
                width="w-52"
                trigger={
                  <span className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-line-strong bg-canvas px-2 text-[12px] font-medium text-ink-2 shadow-btn hover:bg-hover">
                    {sort === "requests" ? "Most requested" : sort === "mrr" ? "Most MRR asking" : "Newest"}
                  </span>
                }
                value={sort}
                onChange={(v) => setParam("sort", v === "new" ? null : v)}
                options={[
                  { value: "new", label: "Newest" },
                  { value: "requests", label: "Most requested" },
                  { value: "mrr", label: "Most MRR asking" },
                ]}
              />
              <span className="text-[12px] text-ink-3 tabular-nums md:ml-auto">
                {list.length} {list.length === 1 ? "idea" : "ideas"}
              </span>
            </div>
            <div className="scroll-row flex flex-wrap items-center gap-1.5">
              {allLabels.map((l) => {
                const on = labels.includes(l);
                const n = labelCounts.get(l) ?? 0;
                return (
                  <button
                    key={l}
                    aria-pressed={on}
                    onClick={() => setParam("labels", (on ? labels.filter((x) => x !== l) : [...labels, l]).join(",") || null)}
                    className={cx(
                      "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[12px] font-medium",
                      on ? "border-accent/40 bg-accent-soft text-accent" : n ? "border-line text-ink-2 hover:bg-hover" : "border-line text-ink-3 opacity-60 hover:opacity-100",
                    )}
                  >
                    {LABEL_NAME[l] ?? l}
                    <span className="tabular-nums text-ink-3">{n}</span>
                  </button>
                );
              })}
              {labels.length > 0 && (
                <button onClick={() => setParam("labels", null)} className="h-6 px-1.5 text-[12px] text-ink-3 hover:text-ink">
                  Clear labels
                </button>
              )}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            {adding && <NewIdea onDone={(id) => (setAdding(false), id && setParam("idea", id))} />}
            {ideas.isLoading ? (
              <p className="p-6 text-[13px] text-ink-3">Loading…</p>
            ) : !list.length ? (
              <EmptyState
                icon={<Lightbulb size={18} />}
                title={all.length ? "No ideas match" : "No ideas yet"}
                action={
                  !adding && (
                    <Button variant="primary" onClick={() => setAdding(true)}>
                      <Plus size={15} /> New idea
                    </Button>
                  )
                }
              >
                {all.length
                  ? "Try other labels or statuses."
                  : "Log feature ideas, concepts and strategies. They're labelled automatically and can become tasks when you're ready. Agents can add them with log_idea."}
              </EmptyState>
            ) : (
              <ul className="divide-y divide-line">
                {list.map((i) => {
                  const o = i.suggested_owner_id ? byId.get(i.suggested_owner_id) : undefined;
                  return (
                    <li key={i.id}>
                      <button
                        onClick={() => setParam("idea", i.id)}
                        className={cx("flex w-full items-start gap-4 px-3 py-3 text-left hover:bg-hover md:px-5", selectedId === i.id && "bg-active")}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-[14px] font-medium">{i.title}</span>
                            {i.status !== "new" && <Tag tone={STATUS[i.status].tone}>{STATUS[i.status].label}</Tag>}
                            {i.request_count > 0 && (
                              <span
                                title={`Requested by ${i.requested_by.map((c) => c.name).join(", ")}`}
                                className="inline-flex h-[22px] shrink-0 items-center gap-1 rounded-[6px] bg-accent-soft px-1.5 text-[12px] font-medium text-accent"
                              >
                                <Users size={12} /> {i.request_count}
                                {i.request_mrr ? <span className="font-normal opacity-80">· {money(i.request_mrr)}</span> : null}
                              </span>
                            )}
                          </div>
                          {i.body && <p className="mt-0.5 line-clamp-2 text-[13px] text-ink-2">{plain(i.body)}</p>}
                          <div className="mt-1.5 flex flex-wrap items-center gap-1">
                            {i.labels_by === "pending" ? (
                              <span className="inline-flex items-center gap-1 text-[12px] text-agent">
                                <Sparkles size={12} className="animate-pulse" /> Labelling…
                              </span>
                            ) : (
                              i.labels.map((l) => <IdeaLabel key={l} label={l} />)
                            )}
                          </div>
                        </div>
                        <div className="hidden w-44 shrink-0 pt-0.5 sm:block">
                          {o ? <MemberChip member={o} size={18} /> : <span className="text-[12px] text-ink-3">No owner yet</span>}
                        </div>
                        <span className="hidden w-16 shrink-0 pt-0.5 text-right text-[12px] text-ink-3 md:block">{timeAgo(i.created_at)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        {selected && <IdeaPanel key={selected.id} idea={selected} byId={byId} members={members.data ?? []} labels={allLabels} onClose={() => setParam("idea", null)} />}
      </div>
    </div>
  );
}

const plain = (md: string) =>
  md
    .replace(/[#*_`>]+/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

function NewIdea({ onDone }: { onDone: (id?: string) => void }) {
  const [title, setTitle] = useState("");
  const editor = useRef<EditorHandle>(null);
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: () => api.post<Idea>("/api/ideas", { title, body: editor.current?.getMarkdown() ?? "" }),
    onSuccess: (idea) => {
      qc.invalidateQueries({ queryKey: ["ideas"] });
      onDone(idea.id);
    },
  });
  return (
    <div className="border-b border-line bg-panel px-3 py-4 md:px-5">
      <div className="rounded-xl border border-line-strong bg-canvas p-3.5 shadow-card">
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && onDone()}
          placeholder="Idea in one line, e.g. Let merchants pay creators inside the app"
          aria-label="Idea title"
          maxLength={200}
          className="w-full bg-transparent text-[15px] font-semibold outline-none placeholder:font-normal placeholder:text-ink-3"
        />
        <div className="mt-2 text-[14px]">
          <RichEditor ref={editor} placeholder="The problem, the idea, and why it matters (optional)" onSubmit={() => title.trim() && create.mutate()} />
        </div>
        <div className="mt-3 flex items-center gap-2">
          <span className="flex items-center gap-1 text-[12px] text-ink-3">
            <Sparkles size={12} className="text-agent" /> Labels and a suggested owner are added automatically.
          </span>
          {create.error && <span className="truncate text-[12px] text-danger">{(create.error as Error).message}</span>}
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => onDone()}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={() => create.mutate()} disabled={!title.trim() || create.isPending}>
            {create.isPending ? "Adding…" : "Add idea"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function IdeaPanel({ idea, byId, members, labels, onClose }: { idea: Idea; byId: Map<string, Member>; members: Member[]; labels: string[]; onClose: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const me = useMe().data?.member;
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(idea.title);
  const editor = useRef<EditorHandle>(null);
  const [assign, setAssign] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => setTitle(idea.title), [idea.title]);
  const refresh = () => qc.invalidateQueries({ queryKey: ["ideas"] });
  const patch = useMutation({ mutationFn: (b: Record<string, unknown>) => api.patch<Idea>(`/api/ideas/${idea.id}`, b), onSuccess: refresh });
  const relabel = useMutation({ mutationFn: () => api.post<Idea>(`/api/ideas/${idea.id}/relabel`), onSuccess: refresh });
  const convert = useMutation({
    mutationFn: () => api.post<{ task_key: string }>(`/api/ideas/${idea.id}/convert`, { assign }),
    onSuccess: (r) => {
      refresh();
      qc.invalidateQueries({ queryKey: ["tasks"] });
      nav(`/t/${r.task_key}`);
    },
  });
  const del = useMutation({
    mutationFn: () => api.del(`/api/ideas/${idea.id}`),
    onSuccess: () => (refresh(), onClose()),
  });
  const owner = idea.suggested_owner_id ? byId.get(idea.suggested_owner_id) : undefined;
  const author = byId.get(idea.created_by);
  const err = patch.error || relabel.error || convert.error || del.error;

  return (
    <aside className="fixed inset-0 z-40 flex flex-col bg-canvas md:static md:z-auto md:w-[440px] md:shrink-0 md:border-l md:border-line">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
        <Lightbulb size={15} className="text-ink-3" />
        <Tag tone={STATUS[idea.status].tone}>{STATUS[idea.status].label}</Tag>
        <span className="truncate text-[12px] text-ink-3">
          Added by {author?.name ?? "someone"} {timeAgo(idea.created_at)}
        </span>
        <IconButton label="Close" className="ml-auto" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
        {editing ? (
          <>
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} className={cx(inputClass, "text-[15px] font-semibold")} aria-label="Title" />
            <div className="mt-2 rounded-lg border border-line px-3 py-2 text-[14px]">
              <RichEditor ref={editor} initial={idea.body} autoFocus />
            </div>
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                variant="primary"
                onClick={() => patch.mutate({ title, body: editor.current?.getMarkdown() ?? idea.body }, { onSuccess: () => setEditing(false) })}
              >
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </>
        ) : (
          <button onClick={() => setEditing(true)} className="block w-full rounded-lg text-left hover:bg-hover/60" title="Click to edit">
            <h2 className="text-[17px] font-semibold tracking-[-0.01em]">{idea.title}</h2>
            <div className="mt-2 text-[14px]">{idea.body ? <Markdown text={idea.body} /> : <span className="text-ink-3">Add details…</span>}</div>
          </button>
        )}
        {idea.source_url && (
          <a href={idea.source_url} target="_blank" rel="noreferrer noopener" className="mt-3 inline-flex max-w-full items-center gap-1.5 text-[12px] text-accent hover:underline">
            <ExternalLink size={12} /> <span className="truncate">{idea.source_url.replace(/^https?:\/\//, "")}</span>
          </a>
        )}

        <div className="mt-5 space-y-3 border-t border-line pt-4">
          <div className="flex items-start gap-3">
            <span className="w-28 shrink-0 pt-1 text-[13px] text-ink-3">Labels</span>
            <div className="min-w-0 flex-1">
              <MultiSelect
                label="Edit labels"
                width="w-56"
                trigger={
                  <span className="flex min-h-7 flex-wrap items-center gap-1 rounded-md px-1 py-0.5 hover:bg-hover">
                    {idea.labels_by === "pending" ? (
                      <span className="inline-flex items-center gap-1 text-[12px] text-agent">
                        <Sparkles size={12} className="animate-pulse" /> Labelling…
                      </span>
                    ) : idea.labels.length ? (
                      idea.labels.map((l) => <IdeaLabel key={l} label={l} />)
                    ) : (
                      <span className="text-[13px] text-ink-3">Add labels</span>
                    )}
                  </span>
                }
                value={idea.labels}
                onChange={(next) => patch.mutate({ labels: next })}
                options={labels.map((l) => ({ value: l, label: LABEL_NAME[l] ?? l }))}
              />
              <div className="mt-1 flex items-center gap-2 text-[12px] text-ink-3">
                {idea.labels_by === "ai" && (
                  <span className="inline-flex items-center gap-1">
                    <Sparkles size={11} className="text-agent" /> Suggested by AI
                  </span>
                )}
                {idea.labels_by === "fallback" && <span>Matched by keywords</span>}
                {idea.labels_by === "agent" && <span>Set by an agent</span>}
                <button onClick={() => relabel.mutate()} disabled={relabel.isPending} className="inline-flex items-center gap-1 hover:text-ink">
                  <Wand2 size={11} /> {relabel.isPending ? "Asking AI…" : "Ask AI again"}
                </button>
              </div>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <span className="w-28 shrink-0 pt-1 text-[13px] text-ink-3">Suggested owner</span>
            <div className="min-w-0 flex-1">
              <Menu
                searchable
                label="Suggested owner"
                trigger={
                  <span className="flex h-7 items-center gap-1.5 rounded-md px-1 hover:bg-hover">
                    <MemberChip member={owner} />
                    {owner?.kind === "agent" && <AgentBadge />}
                  </span>
                }
                value={idea.suggested_owner_id ?? "none"}
                onChange={(id) => patch.mutate({ suggested_owner_id: id === "none" ? null : id })}
                options={assigneeOptions(members).map((o) => (o.value === "none" ? { ...o, label: "No owner" } : o))}
              />
              {idea.owner_reason && <p className="mt-1 text-[12px] leading-relaxed text-ink-3">{idea.owner_reason}</p>}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="w-28 shrink-0 text-[13px] text-ink-3">Status</span>
            {idea.status === "converted" ? (
              <Tag tone="green">Task created</Tag>
            ) : (
              <Menu
                label="Status"
                trigger={
                  <span className="flex h-7 items-center rounded-md px-1 hover:bg-hover">
                    <Tag tone={STATUS[idea.status].tone}>{STATUS[idea.status].label}</Tag>
                  </span>
                }
                value={idea.status}
                onChange={(st: IdeaStatus) => patch.mutate({ status: st })}
                options={(["new", "exploring", "planned", "parked"] as IdeaStatus[]).map((st) => ({ value: st, label: STATUS[st].label }))}
              />
            )}
          </div>
        </div>

        <RequestsSection idea={idea} />

        <div className="mt-5 rounded-xl border border-line bg-panel p-3.5">
          {idea.task ? (
            <div className="flex items-center gap-2 text-[13px]">
              <span className="text-ink-2">This idea is now</span>
              <Link to={`/t/${idea.task.key}`} className="inline-flex items-center gap-1 font-medium text-accent hover:underline">
                {idea.task.key} <ArrowRight size={13} />
              </Link>
            </div>
          ) : (
            <>
              <div className="text-[13px] font-medium">Ready to work on it?</div>
              {owner && (
                <label className="mt-2 flex items-center gap-2 text-[13px]">
                  <input type="checkbox" checked={assign} onChange={(e) => setAssign(e.target.checked)} />
                  Assign to {owner.name}
                  {owner.kind === "agent" && <span className="text-[12px] text-agent">(wakes it)</span>}
                </label>
              )}
              <Button variant="primary" className="mt-3 w-full" onClick={() => convert.mutate()} disabled={convert.isPending}>
                {convert.isPending ? "Creating task…" : "Convert to task"}
              </Button>
            </>
          )}
        </div>
        {err && <p className="mt-3 text-[13px] text-danger">{(err as Error).message}</p>}
      </div>
      {canDelete(me, idea.created_by) && (
        <div className="flex shrink-0 justify-end border-t border-line px-4 py-2">
          {confirmDelete ? (
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-ink-2">Delete this idea?</span>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
              <Button size="sm" variant="danger" onClick={() => del.mutate()} disabled={del.isPending}>
                Delete
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="ghost" className="hover:text-danger" onClick={() => setConfirmDelete(true)}>
              <Trash2 size={13} /> Delete idea
            </Button>
          )}
        </div>
      )}
    </aside>
  );
}
