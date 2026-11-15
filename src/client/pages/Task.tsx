import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import {
  type Checklist,
  type Entry,
  type Member,
  type Note,
  type Priority,
  type Run,
  type Status,
  type TaskDetail,
  PRIORITIES,
  PRIORITY_LABEL,
  STATUSES,
  STATUS_LABEL,
  api,
} from "../api";
import {
  AgentBadge,
  Avatar,
  Button,
  Markdown,
  Menu,
  PriorityIcon,
  StatusIcon,
  assigneeOptions,
  cx,
  formatBytes,
  timeAgo,
  useMe,
  useMembers,
  useProjects,
} from "../components";
import { type EditorHandle, RichEditor } from "../editor";

export function TaskPage() {
  const { taskKey } = useParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["task", taskKey], queryFn: () => api.get<TaskDetail>(`/api/tasks/${taskKey}`) });
  const members = useMembers();
  const byId = new Map((members.data ?? []).map((m) => [m.id, m]));
  const [replyTo, setReplyTo] = useState<Entry | null>(null);

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/api/tasks/${taskKey}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["task", taskKey] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
    },
  });

  if (q.isLoading) return <div className="p-8 text-zinc-400">Loading…</div>;
  if (q.error || !q.data) return <div className="p-8 text-red-600">{(q.error as Error)?.message ?? "Not found"}</div>;
  const { task, entries, notes, checklists, attachments, runs } = q.data;
  const openQuestions = entries.filter((e) => e.type === "question" && e.data.state === "open");

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-zinc-200 px-4 py-2.5 text-[13px] md:px-6 dark:border-zinc-800">
        <Link to={task.project ? `/projects/${task.project.id}` : "/"} className="text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
          {task.project?.name ?? "All tasks"}
        </Link>
        <span className="text-zinc-300">›</span>
        <span className="font-medium">{task.key}</span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="min-w-0 flex-1 overflow-auto">
          <div className="mx-auto max-w-3xl px-4 py-6 md:px-8">
            <TitleEditor value={task.title} onSave={(title) => patch.mutate({ title })} />
            <DescriptionEditor key={task.id} value={task.description} onSave={(description) => patch.mutate({ description })} />

            {(notes.length > 0 || checklists.length > 0) && (
              <div className="mt-6 space-y-3">
                {checklists.map((c) => (
                  <ChecklistCard key={c.id} checklist={c} taskKey={task.key} byId={byId} />
                ))}
                {notes.map((n) => (
                  <NoteCard key={n.id} note={n} taskKey={task.key} byId={byId} />
                ))}
              </div>
            )}

            <h2 className="mt-10 mb-3 text-[13px] font-semibold text-zinc-500">Activity</h2>
            <Thread entries={entries} byId={byId} onReply={setReplyTo} attachments={attachments} />

            {openQuestions.length > 0 && !replyTo && (
              <div className="mt-4 rounded-lg border border-orange-200 bg-orange-50 p-3 text-sm dark:border-orange-500/30 dark:bg-orange-500/10">
                <div className="font-medium text-orange-800 dark:text-orange-200">
                  {openQuestions.length === 1 ? "An agent is waiting for your answer" : `${openQuestions.length} open questions`}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {openQuestions.map((qe) => (
                    <Button key={qe.id} onClick={() => setReplyTo(qe)}>
                      Answer {byId.get(qe.author_id)?.name ?? "agent"}
                    </Button>
                  ))}
                </div>
              </div>
            )}
            <Composer taskKey={task.key} replyTo={replyTo} onClearReply={() => setReplyTo(null)} byId={byId} />
          </div>
        </div>
        <Sidebar detail={q.data} members={members.data ?? []} onPatch={(b) => patch.mutate(b)} runs={runs} />
      </div>
    </div>
  );
}

function TitleEditor({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <textarea
      value={v}
      rows={1}
      onChange={(e) => setV(e.target.value.replace(/\n/g, ""))}
      onBlur={() => v.trim() && v !== value && onSave(v.trim())}
      onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), (e.target as HTMLTextAreaElement).blur())}
      className="w-full resize-none bg-transparent text-2xl font-semibold outline-none [field-sizing:content]"
    />
  );
}

function DescriptionEditor({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const ref = useRef<EditorHandle>(null);
  const [dirty, setDirty] = useState(false);
  return (
    <div className="mt-3 rounded-md">
      <RichEditor
        ref={ref}
        initial={value}
        placeholder="Add a description…"
        onChange={(md) => setDirty(md !== value)}
        onSubmit={() => {
          onSave(ref.current!.getMarkdown());
          setDirty(false);
        }}
      />
      {dirty && (
        <div className="mt-2 flex gap-2">
          <Button
            variant="primary"
            onClick={() => {
              onSave(ref.current!.getMarkdown());
              setDirty(false);
            }}
          >
            Save description
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              ref.current?.setMarkdown(value);
              setDirty(false);
            }}
          >
            Discard
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------- Sidebar ----------

function Sidebar({
  detail,
  members,
  onPatch,
  runs,
}: {
  detail: TaskDetail;
  members: Member[];
  onPatch: (b: Record<string, unknown>) => void;
  runs: Run[];
}) {
  const { task } = detail;
  const projects = useProjects();
  const qc = useQueryClient();
  const assignee = members.find((m) => m.id === task.assignee?.id);
  const wake = useMutation({
    mutationFn: () => api.post(`/api/tasks/${task.key}/wake`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["task"] }),
  });
  const runAction = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "retry" | "dismiss" }) => api.post(`/api/runs/${id}/${action}`),
    onSuccess: () => qc.invalidateQueries(),
  });
  const row = (label: string, child: ReactNode) => (
    <div className="flex items-center gap-3 py-1.5">
      <span className="w-20 shrink-0 text-xs text-zinc-500">{label}</span>
      <div className="min-w-0 flex-1 text-[13px]">{child}</div>
    </div>
  );
  const btn = "flex items-center gap-1.5 rounded px-1.5 py-1 hover:bg-zinc-100 dark:hover:bg-zinc-800";
  const activeRuns = runs.filter((r) => !r.dismissed && r.status !== "ended");

  return (
    <aside className="shrink-0 border-t border-zinc-200 bg-zinc-50/60 px-5 py-5 lg:w-80 lg:overflow-auto lg:border-t-0 lg:border-l dark:border-zinc-800 dark:bg-zinc-900/30">
      {row(
        "Status",
        <Menu
          trigger={
            <span className={btn}>
              <StatusIcon status={task.status} /> {STATUS_LABEL[task.status]}
            </span>
          }
          value={task.status}
          onChange={(s: Status) => onPatch({ status: s })}
          options={STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s], icon: <StatusIcon status={s} /> }))}
        />,
      )}
      {row(
        "Priority",
        <Menu
          trigger={
            <span className={btn}>
              <PriorityIcon priority={task.priority} /> {PRIORITY_LABEL[task.priority]}
            </span>
          }
          value={task.priority}
          onChange={(p: Priority) => onPatch({ priority: p })}
          options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p], icon: <PriorityIcon priority={p} /> }))}
        />,
      )}
      {row(
        "Assignee",
        <Menu
          searchable
          trigger={
            <span className={btn}>
              <Avatar member={assignee} size={18} /> {assignee?.name ?? "Unassigned"}
              {assignee?.kind === "agent" && <AgentBadge />}
            </span>
          }
          value={task.assignee?.id ?? "none"}
          onChange={(id) => onPatch({ assignee_id: id === "none" ? null : id })}
          options={assigneeOptions(members)}
        />,
      )}
      {row(
        "Project",
        <Menu
          searchable
          trigger={<span className={btn}>{task.project?.name ?? <span className="text-zinc-400">No project</span>}</span>}
          value={task.project?.id ?? "none"}
          onChange={(id) => onPatch({ project_id: id === "none" ? null : id })}
          options={[
            { value: "none", label: "No project" },
            ...(projects.data ?? []).filter((p) => p.status === "active").map((p) => ({ value: p.id, label: p.name })),
          ]}
        />,
      )}
      {row(
        "Due",
        <input
          type="date"
          value={task.due_date ?? ""}
          onChange={(e) => onPatch({ due_date: e.target.value || null })}
          className="rounded bg-transparent px-1.5 py-1 text-[13px] outline-none hover:bg-zinc-100 dark:hover:bg-zinc-800"
        />,
      )}

      {assignee?.kind === "agent" && (
        <div className="mt-5 rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-500">Agent runs</span>
            <Button variant="ghost" className="px-1.5 py-0.5 text-xs" onClick={() => wake.mutate()} disabled={wake.isPending}>
              Wake {assignee.name}
            </Button>
          </div>
          {!assignee.has_webhook && (
            <p className="mt-2 text-xs text-amber-600">
              This agent has no webhook yet. <Link to="/members" className="underline">Set it up</Link>.
            </p>
          )}
          {runs.length === 0 && <p className="mt-2 text-xs text-zinc-400">No runs yet.</p>}
          <ul className="mt-2 space-y-1.5">
            {runs.slice(0, 5).map((r) => (
              <li key={r.id} className="text-xs">
                <div className="flex items-center gap-2">
                  <RunStatus status={r.status} />
                  <span className="text-zinc-500">{r.trigger}</span>
                  <span className="ml-auto text-zinc-400">{timeAgo(r.created_at)}</span>
                </div>
                {r.last_error && (r.status === "failed" || r.status === "queued") && (
                  <div className="mt-0.5 truncate text-red-600" title={r.last_error}>
                    {r.last_error}
                  </div>
                )}
                {(r.status === "failed" || r.status === "stale") && !r.dismissed && (
                  <div className="mt-1 flex gap-1">
                    <Button className="px-1.5 py-0.5 text-xs" onClick={() => runAction.mutate({ id: r.id, action: "retry" })}>
                      Retry
                    </Button>
                    <Button variant="ghost" className="px-1.5 py-0.5 text-xs" onClick={() => runAction.mutate({ id: r.id, action: "dismiss" })}>
                      Dismiss
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          {activeRuns.length > 0 && <p className="mt-2 text-[11px] text-zinc-400">New messages are queued for the agent while it works.</p>}
        </div>
      )}

      {detail.attachments.length > 0 && (
        <div className="mt-5">
          <div className="mb-1.5 text-xs font-medium text-zinc-500">Attachments</div>
          <ul className="space-y-1">
            {detail.attachments.map((a) => (
              <li key={a.id}>
                <a href={`/api/attachments/${a.id}`} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded px-1.5 py-1 text-[13px] hover:bg-zinc-100 dark:hover:bg-zinc-800">
                  <span className="truncate">{a.filename}</span>
                  <span className="ml-auto shrink-0 text-xs text-zinc-400">{formatBytes(a.size)}</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-6 text-[11px] text-zinc-400">
        Created {timeAgo(task.created_at)} · Updated {timeAgo(task.updated_at)}
      </div>
    </aside>
  );
}

function RunStatus({ status }: { status: Run["status"] }) {
  const color: Record<Run["status"], string> = {
    queued: "bg-zinc-400",
    dispatched: "bg-sky-500",
    active: "bg-emerald-500 animate-pulse",
    ended: "bg-zinc-300 dark:bg-zinc-600",
    failed: "bg-red-500",
    stale: "bg-amber-500",
  };
  return (
    <span className="flex items-center gap-1.5">
      <span className={cx("h-1.5 w-1.5 rounded-full", color[status])} />
      <span className="capitalize">{status}</span>
    </span>
  );
}

// ---------- Thread ----------

const SYSTEM_TEXT: Record<string, (d: any, byId: Map<string, Member>) => string> = {
  created: () => "created the task",
  assigned: (d) => `assigned to ${d.to_name ?? "someone"}`,
  unassigned: () => "removed the assignee",
  status_changed: (d) => `moved from ${STATUS_LABEL[d.from as Status] ?? d.from} to ${STATUS_LABEL[d.to as Status] ?? d.to}`,
  priority_changed: (d) => `set priority to ${PRIORITY_LABEL[d.to as Priority] ?? d.to}`,
  title_changed: (d) => `renamed to “${d.to}”`,
  project_changed: (d) => (d.to_name ? `moved to project ${d.to_name}` : "removed from project"),
  due_date_changed: (d) => (d.to ? `set due date to ${d.to}` : "cleared the due date"),
  agent_woken: (d) => `was woken (${d.trigger})`,
  agent_not_configured: () => "couldn't be woken: no webhook configured",
  run_failed: (d) => `couldn't be reached: ${d.error ?? "unknown error"}`,
  run_stale: (d) => `has gone quiet (${d.reason})`,
};

function Thread({
  entries,
  byId,
  onReply,
  attachments,
}: {
  entries: Entry[];
  byId: Map<string, Member>;
  onReply: (e: Entry) => void;
  attachments: TaskDetail["attachments"];
}) {
  const entryById = new Map(entries.map((e) => [e.id, e]));
  const attById = new Map(attachments.map((a) => [a.id, a]));
  return (
    <ol className="relative space-y-3 before:absolute before:top-2 before:bottom-2 before:left-[11px] before:w-px before:bg-zinc-200 dark:before:bg-zinc-800">
      {entries.map((e) => {
        const author = byId.get(e.author_id);
        if (e.type === "system" || e.type === "note_created" || e.type === "checklist_created" || e.type === "attachment_added") {
          let text = "";
          if (e.type === "system") text = (SYSTEM_TEXT[e.data.event] ?? (() => e.data.event))(e.data, byId);
          if (e.type === "note_created") text = `added note “${e.data.title}”`;
          if (e.type === "checklist_created") text = `added checklist “${e.data.title}”`;
          const att = e.type === "attachment_added" ? attById.get(e.data.attachment_id) : undefined;
          const isProblem = e.data.event === "run_failed" || e.data.event === "run_stale" || e.data.event === "agent_not_configured";
          return (
            <li key={e.id} className="relative flex items-start gap-2 pl-[3px] text-xs text-zinc-500">
              <span className="relative z-10 mt-px flex h-[18px] w-[18px] items-center justify-center rounded-full bg-white ring-4 ring-white dark:bg-zinc-950 dark:ring-zinc-950">
                <Avatar member={author} size={16} />
              </span>
              <span className={cx("pt-0.5", isProblem && "text-red-600")}>
                <span className="font-medium text-zinc-700 dark:text-zinc-300">{author?.name ?? "System"}</span>{" "}
                {e.type === "attachment_added" ? (
                  <>
                    attached{" "}
                    <a className="text-accent underline" href={`/api/attachments/${e.data.attachment_id}`} target="_blank" rel="noreferrer">
                      {e.data.filename}
                    </a>
                    {att && att.content_type.startsWith("image/") && (
                      <img src={`/api/attachments/${att.id}`} alt="" className="mt-2 max-h-64 rounded-md border border-zinc-200 dark:border-zinc-800" />
                    )}
                  </>
                ) : (
                  text
                )}{" "}
                · {timeAgo(e.created_at)}
              </span>
            </li>
          );
        }
        const replied = e.reply_to_id ? entryById.get(e.reply_to_id) : undefined;
        const isQ = e.type === "question";
        const open = isQ && e.data.state === "open";
        return (
          <li key={e.id} className="relative flex gap-3">
            <span className="relative z-10 rounded-full bg-white ring-4 ring-white dark:bg-zinc-950 dark:ring-zinc-950">
              <Avatar member={author} size={24} />
            </span>
            <div
              className={cx(
                "min-w-0 flex-1 rounded-lg border px-3.5 py-2.5",
                isQ
                  ? open
                    ? "border-orange-300 bg-orange-50/60 dark:border-orange-500/40 dark:bg-orange-500/5"
                    : "border-zinc-200 dark:border-zinc-800"
                  : e.type === "update"
                    ? "border-indigo-200 bg-indigo-50/40 dark:border-indigo-500/30 dark:bg-indigo-500/5"
                    : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900",
              )}
            >
              <div className="mb-1 flex flex-wrap items-center gap-1.5 text-xs">
                <span className="font-medium">{author?.name ?? "Unknown"}</span>
                {author?.kind === "agent" && <AgentBadge />}
                {e.type === "update" && <span className="text-indigo-600 dark:text-indigo-300">posted an update</span>}
                {isQ && <span className="text-orange-600 dark:text-orange-300">{open ? "asked a question" : "asked (answered)"}</span>}
                {e.type === "answer" && <span className="text-emerald-600 dark:text-emerald-400">answered</span>}
                <span className="text-zinc-400">· {timeAgo(e.created_at)}</span>
                {e.edited_at && <span className="text-zinc-400">(edited)</span>}
                {(isQ || e.type === "comment" || e.type === "update") && (
                  <button onClick={() => onReply(e)} className="ml-auto text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200">
                    {open ? "Answer" : "Reply"}
                  </button>
                )}
              </div>
              {replied && (
                <div className="mb-1.5 truncate border-l-2 border-zinc-300 pl-2 text-xs text-zinc-500 dark:border-zinc-700">
                  {byId.get(replied.author_id)?.name}: {replied.body.slice(0, 140)}
                </div>
              )}
              {isQ && e.data.addressed_to && (
                <div className="mb-1 text-xs text-zinc-500">For {byId.get(e.data.addressed_to)?.name ?? "someone"}</div>
              )}
              <Markdown text={e.body} />
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ---------- Composer ----------

type Mode = "comment" | "update" | "note" | "checklist";

function Composer({
  taskKey,
  replyTo,
  onClearReply,
  byId,
}: {
  taskKey: string;
  replyTo: Entry | null;
  onClearReply: () => void;
  byId: Map<string, Member>;
}) {
  const [mode, setMode] = useState<Mode>("comment");
  const [noteTitle, setNoteTitle] = useState("");
  const [checklistTitle, setChecklistTitle] = useState("");
  const [checklistItems, setChecklistItems] = useState("");
  const [drag, setDrag] = useState(false);
  const editor = useRef<EditorHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const me = useMe().data?.member;
  const done = () => {
    qc.invalidateQueries({ queryKey: ["task", taskKey] });
    qc.invalidateQueries({ queryKey: ["tasks"] });
    qc.invalidateQueries({ queryKey: ["inbox"] });
  };

  useEffect(() => {
    if (replyTo) {
      setMode("comment");
      editor.current?.focus();
    }
  }, [replyTo]);

  const submit = useMutation({
    mutationFn: async () => {
      if (mode === "checklist") {
        const items = checklistItems.split("\n").map((s) => s.trim()).filter(Boolean);
        await api.post(`/api/tasks/${taskKey}/checklists`, { title: checklistTitle || "Checklist", items });
        return;
      }
      const body = editor.current?.getMarkdown().trim() ?? "";
      if (!body) throw new Error("Write something first");
      if (mode === "note") {
        await api.post(`/api/tasks/${taskKey}/notes`, { title: noteTitle || "Untitled note", content: body });
      } else {
        await api.post(`/api/tasks/${taskKey}/entries`, { type: mode, body, reply_to_id: replyTo?.id });
      }
    },
    onSuccess: () => {
      editor.current?.setMarkdown("");
      setNoteTitle("");
      setChecklistTitle("");
      setChecklistItems("");
      onClearReply();
      done();
    },
  });

  const upload = useMutation({
    mutationFn: (files: File[]) => api.upload(`/api/tasks/${taskKey}/attachments`, files),
    onSuccess: done,
  });

  const tab = (m: Mode, label: string) => (
    <button
      type="button"
      onClick={() => setMode(m)}
      className={cx("rounded px-2 py-1 text-xs", mode === m ? "bg-zinc-200 font-medium dark:bg-zinc-700" : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200")}
    >
      {label}
    </button>
  );

  return (
    <div
      className={cx(
        "mt-5 flex gap-3",
      )}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        const files = [...e.dataTransfer.files];
        if (files.length) upload.mutate(files);
      }}
    >
      <Avatar member={me} size={24} />
      <div className={cx("min-w-0 flex-1 rounded-lg border bg-white dark:bg-zinc-900", drag ? "border-accent" : "border-zinc-200 dark:border-zinc-800")}>
        {replyTo && (
          <div className="flex items-center gap-2 border-b border-zinc-100 px-3 py-1.5 text-xs text-zinc-500 dark:border-zinc-800">
            <span className="truncate">
              {replyTo.type === "question" ? "Answering" : "Replying to"} {byId.get(replyTo.author_id)?.name}: “{replyTo.body.slice(0, 80)}”
            </span>
            <button onClick={onClearReply} className="ml-auto hover:text-zinc-800">
              ✕
            </button>
          </div>
        )}
        <div className="px-3 pt-2.5">
          {mode === "note" && (
            <input value={noteTitle} onChange={(e) => setNoteTitle(e.target.value)} placeholder="Note title" className="mb-2 w-full bg-transparent text-sm font-semibold outline-none" />
          )}
          {mode === "checklist" ? (
            <div className="space-y-2 pb-1">
              <input value={checklistTitle} onChange={(e) => setChecklistTitle(e.target.value)} placeholder="Checklist title" className="w-full bg-transparent text-sm font-semibold outline-none" />
              <textarea
                value={checklistItems}
                onChange={(e) => setChecklistItems(e.target.value)}
                placeholder={"One item per line\nAnother item"}
                rows={4}
                className="w-full resize-y bg-transparent text-sm outline-none"
              />
            </div>
          ) : (
            <RichEditor
              ref={editor}
              placeholder={
                replyTo?.type === "question"
                  ? "Type your answer… the agent will be woken to continue."
                  : mode === "update"
                    ? "Share a progress update…"
                    : mode === "note"
                      ? "Write a note — headings, lists, to-dos, code…"
                      : "Leave a comment… @mention an agent to wake it"
              }
              onSubmit={() => submit.mutate()}
              className="max-h-80 overflow-auto"
            />
          )}
        </div>
        <div className="flex items-center gap-1 px-2 py-2">
          {!replyTo && (
            <>
              {tab("comment", "Comment")}
              {tab("update", "Update")}
              {tab("note", "Note")}
              {tab("checklist", "Checklist")}
            </>
          )}
          <button type="button" onClick={() => fileInput.current?.click()} className="rounded px-2 py-1 text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
            {upload.isPending ? "Uploading…" : "Attach"}
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              if (files.length) upload.mutate(files);
              e.target.value = "";
            }}
          />
          <span className="ml-auto mr-2 hidden text-[11px] text-zinc-400 sm:inline">⌘↵</span>
          <Button variant="primary" onClick={() => submit.mutate()} disabled={submit.isPending}>
            {replyTo?.type === "question" ? "Send answer" : mode === "note" ? "Add note" : mode === "checklist" ? "Add checklist" : mode === "update" ? "Post update" : "Comment"}
          </Button>
        </div>
        {(submit.error || upload.error) && (
          <p className="px-3 pb-2 text-xs text-red-600">{((submit.error || upload.error) as Error).message}</p>
        )}
      </div>
    </div>
  );
}

// ---------- Notes & checklists ----------

function NoteCard({ note, taskKey, byId }: { note: Note; taskKey: string; byId: Map<string, Member> }) {
  const [editing, setEditing] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [title, setTitle] = useState(note.title);
  const editor = useRef<EditorHandle>(null);
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: () => api.patch(`/api/notes/${note.id}`, { title, content: editor.current?.getMarkdown() ?? note.content }),
    onSuccess: () => {
      setEditing(false);
      qc.invalidateQueries({ queryKey: ["task", taskKey] });
    },
  });
  return (
    <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center gap-2 border-b border-zinc-100 px-3.5 py-2 dark:border-zinc-800">
        <span className="text-zinc-400">¶</span>
        {editing ? (
          <input value={title} onChange={(e) => setTitle(e.target.value)} className="flex-1 bg-transparent text-sm font-semibold outline-none" />
        ) : (
          <button onClick={() => setCollapsed((c) => !c)} className="flex-1 truncate text-left text-sm font-semibold">
            {note.title}
          </button>
        )}
        <span className="text-xs text-zinc-400">
          {byId.get(note.updated_by)?.name} · {timeAgo(note.updated_at)}
        </span>
        {editing ? (
          <>
            <Button variant="primary" className="px-2 py-0.5 text-xs" onClick={() => save.mutate()}>
              Save
            </Button>
            <Button variant="ghost" className="px-2 py-0.5 text-xs" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button variant="ghost" className="px-2 py-0.5 text-xs" onClick={() => (setEditing(true), setCollapsed(false), setTitle(note.title))}>
            Edit
          </Button>
        )}
      </div>
      {!collapsed && (
        <div className="px-3.5 py-3">
          {editing ? <RichEditor ref={editor} initial={note.content} autoFocus onSubmit={() => save.mutate()} /> : <Markdown text={note.content || "_Empty note_"} />}
        </div>
      )}
    </div>
  );
}

function ChecklistCard({ checklist, taskKey, byId }: { checklist: Checklist; taskKey: string; byId: Map<string, Member> }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey: ["task", taskKey] });
  const toggle = useMutation({
    mutationFn: ({ id, done }: { id: string; done: boolean }) => api.patch(`/api/checklist-items/${id}`, { done }),
    onSuccess: refresh,
  });
  const add = useMutation({
    mutationFn: () => api.post(`/api/checklists/${checklist.id}/items`, { text }),
    onSuccess: () => (setText(""), refresh()),
  });
  const remove = useMutation({ mutationFn: (id: string) => api.del(`/api/checklist-items/${id}`), onSuccess: refresh });
  const doneCount = checklist.items.filter((i) => i.done).length;
  const pct = checklist.items.length ? Math.round((doneCount / checklist.items.length) * 100) : 0;
  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-3.5 py-3 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold">{checklist.title}</span>
        <span className="text-xs text-zinc-400">
          {doneCount}/{checklist.items.length}
        </span>
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
        <div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} />
      </div>
      <ul className="mt-2 space-y-0.5">
        {checklist.items.map((i) => (
          <li key={i.id} className="group flex items-center gap-2 rounded px-1 py-1 hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
            <input type="checkbox" checked={!!i.done} onChange={(e) => toggle.mutate({ id: i.id, done: e.target.checked })} className="accent-[#5b5bd6]" />
            <span className={cx("flex-1 text-[13px]", !!i.done && "text-zinc-400 line-through")}>{i.text}</span>
            {i.done_by && i.done ? <Avatar member={byId.get(i.done_by)} size={14} /> : null}
            <button onClick={() => remove.mutate(i.id)} className="hidden text-xs text-zinc-400 group-hover:block hover:text-red-600">
              ✕
            </button>
          </li>
        ))}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) add.mutate();
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="+ Add item" className="mt-1 w-full bg-transparent px-1 py-1 text-[13px] outline-none" />
      </form>
    </div>
  );
}
