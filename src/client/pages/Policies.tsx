import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Bot, ChevronDown, ChevronRight, FileText, Folder, FolderInput, FolderKanban, FolderPlus, History, Lock, Plus, Users } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "../api";
import { type EditorHandle, RichEditor } from "../editor";
import {
  AttrRow,
  Avatar,
  Button,
  DeleteButton,
  EmptyState,
  IconButton,
  Markdown,
  Menu,
  Modal,
  MultiSelect,
  Tag,
  TopBar,
  attrValue,
  cx,
  inputClass,
  timeAgo,
  useMe,
  useMembers,
  useProjects,
} from "../components";

type Audience = "all" | "agents" | "reference";
export interface PolicyMeta {
  id: string;
  parent_id: string | null;
  kind: "folder" | "doc";
  title: string;
  summary: string;
  audience: Audience;
  agent_ids: string[];
  project_ids: string[];
  required: boolean;
  version: number;
  position: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}
interface PolicyDetail extends PolicyMeta {
  content: string;
  path: string;
  reads: { member_id: string; version: number; read_at: string }[];
  revisions: { id: string; version: number; title: string; author_id: string; created_at: string }[];
}

const AUDIENCE: { value: Audience; label: string; hint: string }[] = [
  { value: "all", label: "Every agent", hint: "Listed for all agents when they're woken" },
  { value: "agents", label: "Specific agents", hint: "Only the agents you pick" },
  { value: "reference", label: "Reference only", hint: "Agents find it by searching" },
];

const usePolicies = () => useQuery({ queryKey: ["policies"], queryFn: () => api.get<PolicyMeta[]>("/api/policies") });

function childrenOf(all: PolicyMeta[], parent: string | null) {
  return all
    .filter((p) => p.parent_id === parent)
    .sort((a, b) => (a.kind === b.kind ? a.position - b.position || a.title.localeCompare(b.title) : a.kind === "folder" ? -1 : 1));
}

function pathTo(all: PolicyMeta[], id: string | null) {
  const out: PolicyMeta[] = [];
  const byId = new Map(all.map((p) => [p.id, p]));
  for (let cur = id ? byId.get(id) : undefined, i = 0; cur && i < 30; cur = cur.parent_id ? byId.get(cur.parent_id) : undefined, i++) out.unshift(cur);
  return out;
}

export function PoliciesPage() {
  const { policyId } = useParams();
  const policies = usePolicies();
  const nav = useNavigate();
  const qc = useQueryClient();
  const all = policies.data ?? [];
  const current = policyId ? all.find((p) => p.id === policyId) : undefined;

  const create = useMutation({
    mutationFn: (b: { kind: "doc" | "folder"; parent_id: string | null }) => api.post<PolicyMeta>("/api/policies", b),
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: ["policies"] });
      nav(`/policies/${p.id}`);
    },
  });
  const newIn = (kind: "doc" | "folder", parent_id: string | null) => create.mutate({ kind, parent_id });
  // New items go in the open folder, or next to the open doc.
  const here = current ? (current.kind === "folder" ? current.id : current.parent_id) : null;

  return (
    <div className="flex h-full flex-col">
      <TopBar
        crumbs={[
          { label: "Policies", to: "/policies", icon: <BookOpen size={15} className="text-ink-3" /> },
          ...pathTo(all, policyId ?? null).map((p) => ({ label: p.title, to: `/policies/${p.id}` })),
        ]}
        actions={
          <>
            <Button size="sm" onClick={() => newIn("folder", here)} disabled={create.isPending}>
              <FolderPlus size={14} /> <span className="hidden sm:inline">New folder</span>
            </Button>
            <Button size="sm" variant="primary" onClick={() => newIn("doc", here)} disabled={create.isPending}>
              <Plus size={14} /> New policy
            </Button>
          </>
        }
      />
      <div className="flex min-h-0 flex-1">
        <aside className={cx("w-full shrink-0 overflow-auto border-r border-line bg-panel/40 p-2 md:block md:w-72", policyId ? "hidden" : "block")}>
          {policies.isLoading ? (
            <div className="p-3 text-[13px] text-ink-3">Loading…</div>
          ) : all.length ? (
            <Tree all={all} parent={null} depth={0} activeId={policyId} onNew={newIn} />
          ) : (
            <p className="p-3 text-[13px] text-ink-3">No policies yet.</p>
          )}
        </aside>
        <main className={cx("min-w-0 flex-1 overflow-auto", !policyId && "hidden md:block")}>
          {!policyId ? (
            <Intro onNew={() => newIn("doc", null)} onFolder={() => newIn("folder", null)} empty={!all.length} />
          ) : policies.isLoading ? null : !current ? (
            <EmptyState icon={<BookOpen size={18} />} title="Policy not found" action={<Link to="/policies" className="text-[13px] text-accent hover:underline">All policies</Link>}>
              It may have been deleted.
            </EmptyState>
          ) : current.kind === "folder" ? (
            <FolderPane key={current.id} folder={current} all={all} onNew={newIn} />
          ) : (
            <DocPane key={current.id} id={current.id} all={all} />
          )}
        </main>
      </div>
    </div>
  );
}

function Intro({ onNew, onFolder, empty }: { onNew: () => void; onFolder: () => void; empty: boolean }) {
  return (
    <div className="mx-auto max-w-xl px-6 py-16">
      <h1 className="text-[20px] font-semibold tracking-[-0.01em]">How work gets done here</h1>
      <p className="mt-2 text-[14px] text-ink-2">
        Write down your SOPs, policies, strategies and team structure. Agents are told which policies apply to them every time they're woken, and they can
        search the rest. Mark a policy <strong>required</strong> and an agent can't change anything on a task until it has read the latest version.
      </p>
      {empty && (
        <div className="mt-6 flex gap-2">
          <Button variant="primary" onClick={onNew}>
            <Plus size={14} /> Write the first policy
          </Button>
          <Button onClick={onFolder}>
            <FolderPlus size={14} /> New folder
          </Button>
        </div>
      )}
      {!empty && <p className="mt-6 text-[13px] text-ink-3">Pick a policy on the left, or create a new one.</p>}
    </div>
  );
}

function Tree({
  all,
  parent,
  depth,
  activeId,
  onNew,
}: {
  all: PolicyMeta[];
  parent: string | null;
  depth: number;
  activeId?: string;
  onNew: (kind: "doc" | "folder", parent: string | null) => void;
}) {
  const [closed, setClosed] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem("policies.closed") ?? "{}");
    } catch {
      return {};
    }
  });
  const toggle = (id: string) =>
    setClosed((c) => {
      const next = { ...c, [id]: !c[id] };
      try {
        localStorage.setItem("policies.closed", JSON.stringify(next));
      } catch {}
      return next;
    });
  return (
    <ul className="flex flex-col gap-px">
      {childrenOf(all, parent).map((p) => {
        const isOpen = p.kind === "folder" && !closed[p.id];
        const count = p.kind === "folder" ? all.filter((x) => x.parent_id === p.id).length : 0;
        return (
          <li key={p.id}>
            <div
              className={cx(
                "group flex h-8 items-center rounded-md pr-1 text-[13px]",
                activeId === p.id ? "bg-active font-medium text-ink" : "text-ink-2 hover:bg-hover hover:text-ink",
              )}
              style={{ paddingLeft: 4 + depth * 14 }}
            >
              {p.kind === "folder" ? (
                <button type="button" aria-label={isOpen ? "Collapse" : "Expand"} className="flex h-6 w-5 items-center justify-center text-ink-3" onClick={() => toggle(p.id)}>
                  {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                </button>
              ) : (
                <span className="w-5" />
              )}
              <Link to={`/policies/${p.id}`} className="flex h-8 min-w-0 flex-1 items-center gap-1.5">
                {p.kind === "folder" ? <Folder size={14} className="shrink-0 text-ink-3" /> : <FileText size={14} className="shrink-0 text-ink-3" />}
                <span className="truncate">{p.title}</span>
                {p.required && <Lock size={11} className="shrink-0 text-[#e5791d]" aria-label="Required" />}
              </Link>
              {p.kind === "folder" && (
                <>
                  {!!count && <span className="mr-1 text-[11px] text-ink-3 group-hover:hidden">{count}</span>}
                  <IconButton label={`New policy in ${p.title}`} className="hidden h-6 w-6 group-hover:flex" onClick={() => onNew("doc", p.id)}>
                    <Plus size={13} />
                  </IconButton>
                </>
              )}
            </div>
            {isOpen && count > 0 && <Tree all={all} parent={p.id} depth={depth + 1} activeId={activeId} onNew={onNew} />}
          </li>
        );
      })}
    </ul>
  );
}

function usePatch(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: Record<string, unknown>) => api.patch<PolicyDetail>(`/api/policies/${id}`, b),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["policies"] });
      qc.invalidateQueries({ queryKey: ["policy", id] });
    },
  });
}

function TitleInput({ value, onSave, placeholder }: { value: string; onSave: (v: string) => void; placeholder: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <textarea
      rows={1}
      value={v}
      placeholder={placeholder}
      aria-label="Title"
      onChange={(e) => setV(e.target.value.replace(/\n/g, ""))}
      onBlur={() => v.trim() && v.trim() !== value && onSave(v.trim())}
      onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), (e.target as HTMLTextAreaElement).blur())}
      className="-mx-1 w-full resize-none rounded-md bg-transparent px-1 text-[28px] leading-tight font-semibold tracking-[-0.02em] outline-none [field-sizing:content] hover:bg-hover focus:bg-transparent"
    />
  );
}

function MoveMenu({ item, all, onMove }: { item: PolicyMeta; all: PolicyMeta[]; onMove: (parent: string | null) => void }) {
  // Folders it can move into: any folder that isn't itself or inside it.
  const inside = (f: PolicyMeta) => pathTo(all, f.id).some((x) => x.id === item.id);
  const folders = all.filter((f) => f.kind === "folder" && !inside(f));
  const options = [
    { value: "__root", label: "Top level", icon: <BookOpen size={14} /> },
    ...folders.map((f) => ({ value: f.id, label: pathTo(all, f.id).map((x) => x.title).join(" / "), icon: <Folder size={14} /> })),
  ];
  return (
    <Menu
      label="Move to"
      width="w-72"
      searchable={folders.length > 6}
      value={item.parent_id ?? "__root"}
      options={options}
      onChange={(v) => onMove(v === "__root" ? null : v)}
      trigger={
        <span className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-line-strong bg-canvas px-2 text-[12px] font-medium shadow-btn hover:bg-hover">
          <FolderInput size={13} /> Move
        </span>
      }
    />
  );
}

function FolderPane({ folder, all, onNew }: { folder: PolicyMeta; all: PolicyMeta[]; onNew: (kind: "doc" | "folder", parent: string | null) => void }) {
  const patch = usePatch(folder.id);
  const nav = useNavigate();
  const qc = useQueryClient();
  const me = useMe().data?.member;
  const kids = childrenOf(all, folder.id);
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 md:px-10">
      <Link to="/policies" className="mb-3 inline-block text-[13px] text-ink-3 hover:text-ink md:hidden">
        ← All policies
      </Link>
      <div className="flex items-center gap-2 text-ink-3">
        <Folder size={18} />
        <span className="text-[13px]">Folder</span>
      </div>
      <TitleInput value={folder.title} placeholder="Folder name" onSave={(title) => patch.mutate({ title })} />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => onNew("doc", folder.id)}>
          <Plus size={13} /> New policy here
        </Button>
        <Button size="sm" onClick={() => onNew("folder", folder.id)}>
          <FolderPlus size={13} /> New subfolder
        </Button>
        <MoveMenu item={folder} all={all} onMove={(parent_id) => patch.mutate({ parent_id })} />
        {(me?.role === "admin" || folder.created_by === me?.id) && (
          <DeleteButton
            what="folder"
            name={folder.title}
            detail={kids.length ? "Everything inside it (subfolders and policies) is deleted too." : undefined}
            onDelete={() => api.del(`/api/policies/${folder.id}`)}
            onDone={() => {
              qc.invalidateQueries({ queryKey: ["policies"] });
              nav(folder.parent_id ? `/policies/${folder.parent_id}` : "/policies");
            }}
          />
        )}
      </div>
      {patch.error && <p className="mt-2 text-[12px] text-danger">{(patch.error as Error).message}</p>}
      <ul className="mt-6 divide-y divide-line rounded-[10px] border border-line">
        {kids.map((k) => (
          <li key={k.id}>
            <Link to={`/policies/${k.id}`} className="flex items-start gap-2.5 px-3.5 py-3 hover:bg-hover">
              {k.kind === "folder" ? <Folder size={15} className="mt-0.5 text-ink-3" /> : <FileText size={15} className="mt-0.5 text-ink-3" />}
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-[14px] font-medium">
                  {k.title}
                  {k.required && <Tag tone="orange">Required</Tag>}
                </span>
                {k.summary && <span className="mt-0.5 block text-[13px] text-ink-3">{k.summary}</span>}
              </span>
              <span className="shrink-0 text-[12px] text-ink-3">{timeAgo(k.updated_at)}</span>
            </Link>
          </li>
        ))}
        {!kids.length && <li className="px-3.5 py-6 text-center text-[13px] text-ink-3">This folder is empty.</li>}
      </ul>
    </div>
  );
}

function DocPane({ id, all }: { id: string; all: PolicyMeta[] }) {
  const q = useQuery({ queryKey: ["policy", id], queryFn: () => api.get<PolicyDetail>(`/api/policies/${id}`) });
  const patch = usePatch(id);
  const members = useMembers().data ?? [];
  const projects = useProjects().data ?? [];
  const me = useMe().data?.member;
  const nav = useNavigate();
  const qc = useQueryClient();
  const editor = useRef<EditorHandle>(null);
  const [saveState, setSaveState] = useState<"idle" | "dirty" | "saving" | "saved">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastSaved = useRef<string | null>(null);
  const latest = useRef<string | null>(null);
  const [revision, setRevision] = useState<string | null>(null);
  const [showReaders, setShowReaders] = useState(false);
  const [showVersions, setShowVersions] = useState(false);

  const p = q.data;
  useEffect(() => {
    if (p && lastSaved.current === null) lastSaved.current = p.content;
  }, [p]);

  // Autosave the body a moment after typing stops (and when leaving the page).
  const save = async () => {
    clearTimeout(timer.current);
    const md = editor.current?.getMarkdown() ?? latest.current ?? undefined;
    if (md === undefined || md === lastSaved.current) return setSaveState((s) => (s === "dirty" ? "idle" : s));
    setSaveState("saving");
    try {
      await patch.mutateAsync({ content: md });
      lastSaved.current = md;
      setSaveState("saved");
    } catch {
      setSaveState("dirty");
    }
  };
  useEffect(() => () => void save(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const agents = useMemo(() => members.filter((m) => m.kind === "agent" && m.active), [members]);
  if (q.isLoading || !p) return <div className="p-8 text-[13px] text-ink-3">Loading…</div>;

  const followers = p.audience === "all" ? agents : p.audience === "agents" ? agents.filter((a) => p.agent_ids.includes(a.id)) : [];
  const readOf = new Map(p.reads.map((r) => [r.member_id, r]));
  const upToDate = followers.filter((a) => (readOf.get(a.id)?.version ?? 0) >= p.version).length;
  const name = (mid: string) => members.find((m) => m.id === mid)?.name ?? "someone";

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 md:px-10">
      <Link to={p.parent_id ? `/policies/${p.parent_id}` : "/policies"} className="mb-3 inline-block text-[13px] text-ink-3 hover:text-ink md:hidden">
        ← Back
      </Link>
      <TitleInput value={p.title} placeholder="Untitled" onSave={(title) => patch.mutate({ title })} />
      <input
        key={p.summary}
        defaultValue={p.summary}
        maxLength={300}
        placeholder="When should an agent use this? e.g. “Before publishing any blog post”"
        onBlur={(e) => e.target.value.trim() !== p.summary && patch.mutate({ summary: e.target.value })}
        className="-mx-1 mt-1 w-full rounded-md bg-transparent px-1 py-1 text-[14px] text-ink-2 outline-none placeholder:text-ink-3 hover:bg-hover focus:bg-transparent"
      />

      <div className="mt-4 border-y border-line py-2">
        <AttrRow icon={<Users size={14} />} label="Followed by">
          <div className="flex flex-wrap items-center gap-1">
            <Menu
              label="Who follows this"
              width="w-72"
              value={p.audience}
              options={AUDIENCE.map((a) => ({ value: a.value, label: a.label, hint: a.hint }))}
              onChange={(audience) => patch.mutate({ audience })}
              trigger={<span className={attrValue}>{AUDIENCE.find((a) => a.value === p.audience)?.label}</span>}
            />
            {p.audience === "agents" && (
              <MultiSelect
                label="Agents"
                searchable
                value={p.agent_ids}
                onChange={(agent_ids) => patch.mutate({ agent_ids })}
                options={agents.map((a) => ({ value: a.id, label: a.name, icon: <Avatar member={a} size={16} /> }))}
                trigger={
                  <span className={cx(attrValue, "text-ink-2")}>
                    {p.agent_ids.length ? `${p.agent_ids.length} agent${p.agent_ids.length === 1 ? "" : "s"}` : "Pick agents…"}
                  </span>
                }
              />
            )}
          </div>
        </AttrRow>
        <AttrRow icon={<FolderKanban size={14} />} label="Projects">
          <MultiSelect
            label="Only for tasks in"
            searchable
            value={p.project_ids}
            onChange={(project_ids) => patch.mutate({ project_ids })}
            options={projects.filter((x) => x.status === "active" || p.project_ids.includes(x.id)).map((x) => ({ value: x.id, label: x.name }))}
            trigger={
              <span className={cx(attrValue, "text-ink-2")}>
                {p.project_ids.length ? p.project_ids.map((pid) => projects.find((x) => x.id === pid)?.name ?? "…").join(", ") : "All work"}
              </span>
            }
          />
        </AttrRow>
        <AttrRow icon={<Lock size={14} />} label="Required">
          <label className={cx(attrValue, "cursor-pointer", p.audience === "reference" && "pointer-events-none opacity-50")}>
            <input type="checkbox" checked={p.required} disabled={p.audience === "reference"} onChange={(e) => patch.mutate({ required: e.target.checked })} />
            <span className="text-ink-2">Agents must read the latest version before working</span>
          </label>
        </AttrRow>
        <AttrRow icon={<Folder size={14} />} label="Folder">
          <div className="flex items-center gap-2">
            <span className="truncate text-ink-2">{pathTo(all, p.parent_id).map((x) => x.title).join(" / ") || "Top level"}</span>
            <MoveMenu item={p} all={all} onMove={(parent_id) => patch.mutate({ parent_id })} />
          </div>
        </AttrRow>
      </div>
      {patch.error && <p className="mt-2 text-[12px] text-danger">{(patch.error as Error).message}</p>}

      <div className="mt-5 min-h-[40vh] text-[15px]">
        <RichEditor
          ref={editor}
          initial={p.content}
          placeholder="Write the steps, rules and examples agents should follow…"
          onChange={(md) => {
            latest.current = md;
            if (md === lastSaved.current) return;
            setSaveState("dirty");
            clearTimeout(timer.current);
            timer.current = setTimeout(save, 1200);
          }}
          onSubmit={save}
        />
      </div>

      <div className="mt-8 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-3 text-[12px] text-ink-3">
        <span>
          Version {p.version} · edited by {name(p.updated_by)} {timeAgo(p.updated_at)}
        </span>
        <span aria-live="polite">{saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : saveState === "dirty" ? "Unsaved changes" : ""}</span>
        <span className="ml-auto flex gap-2">
          {(me?.role === "admin" || p.created_by === me?.id) && (
            <DeleteButton
              what="policy"
              name={p.title}
              onDelete={() => api.del(`/api/policies/${p.id}`)}
              onDone={() => {
                qc.invalidateQueries({ queryKey: ["policies"] });
                nav(p.parent_id ? `/policies/${p.parent_id}` : "/policies");
              }}
            />
          )}
        </span>
      </div>

      {p.audience !== "reference" && (
        <section className="mt-6">
          <button
            type="button"
            aria-expanded={showReaders}
            onClick={() => setShowReaders((v) => !v)}
            className="-mx-1.5 flex w-[calc(100%+12px)] items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[13px] hover:bg-hover"
          >
            {showReaders ? <ChevronDown size={14} className="text-ink-3" /> : <ChevronRight size={14} className="text-ink-3" />}
            <Bot size={14} className="text-ink-3" />
            <span className="font-medium">Agents following this</span>
            <span className="text-ink-3">
              {followers.length
                ? `· ${upToDate} of ${followers.length} read the latest version`
                : "· none picked yet"}
            </span>
          </button>
          {!showReaders ? null : followers.length ? (
            <ul className="mt-2 divide-y divide-line rounded-[10px] border border-line">
              {followers.map((a) => {
                const r = readOf.get(a.id);
                return (
                  <li key={a.id} className="flex items-center gap-2 px-3 py-2 text-[13px]">
                    <Avatar member={a} size={18} />
                    <span className="flex-1 truncate">{a.name}</span>
                    {!r ? (
                      <Tag tone={p.required ? "orange" : "gray"}>Not read yet</Tag>
                    ) : r.version >= p.version ? (
                      <Tag tone="green">Read latest · {timeAgo(r.read_at)}</Tag>
                    ) : (
                      <Tag tone="amber">Read v{r.version} · outdated</Tag>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="mt-1 text-[13px] text-ink-3">No agents picked yet.</p>
          )}
        </section>
      )}

      {!!p.revisions.length && (
        <section className="mt-6">
          <button
            type="button"
            aria-expanded={showVersions}
            onClick={() => setShowVersions((v) => !v)}
            className="-mx-1.5 flex w-[calc(100%+12px)] items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[13px] hover:bg-hover"
          >
            {showVersions ? <ChevronDown size={14} className="text-ink-3" /> : <ChevronRight size={14} className="text-ink-3" />}
            <History size={14} className="text-ink-3" />
            <span className="font-medium">Earlier versions</span>
            <span className="text-ink-3">· {p.revisions.length}</span>
          </button>
          {showVersions && (
          <ul className="mt-1 flex flex-col gap-0.5">
            {p.revisions.map((r) => (
              <li key={r.id}>
                <button type="button" onClick={() => setRevision(r.id)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-hover">
                  <span className="font-medium">v{r.version}</span>
                  <span className="truncate text-ink-2">{r.title}</span>
                  <span className="ml-auto shrink-0 text-[12px] text-ink-3">
                    {name(r.author_id)} · {timeAgo(r.created_at)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          )}
        </section>
      )}
      <RevisionModal id={revision} onClose={() => setRevision(null)} />
    </div>
  );
}

function RevisionModal({ id, onClose }: { id: string | null; onClose: () => void }) {
  const q = useQuery({
    queryKey: ["policy-revision", id],
    queryFn: () => api.get<{ version: number; title: string; content: string }>(`/api/policy-revisions/${id}`),
    enabled: !!id,
  });
  return (
    <Modal open={!!id} onClose={onClose} wide title={q.data ? `v${q.data.version}: ${q.data.title}` : "Earlier version"}>
      <div className="max-h-[65vh] overflow-auto px-5 py-4 text-[14px]">{q.data ? <Markdown text={q.data.content || "_Empty._"} /> : "Loading…"}</div>
    </Modal>
  );
}
