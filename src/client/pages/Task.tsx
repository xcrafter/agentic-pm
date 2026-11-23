import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Archive,
  Bot,
  CalendarDays,
  CheckSquare,
  CircleDot,
  FileText,
  FolderKanban,
  ListTodo,
  MessageSquare,
  Paperclip,
  Plus,
  Signal,
  SmilePlus,
  UserRound,
  X,
  Zap,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
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
  AttrRow,
  Avatar,
  Button,
  EmptyState,
  IconButton,
  Markdown,
  MemberChip,
  Menu,
  PriorityIcon,
  SectionTitle,
  StatusIcon,
  StatusTag,
  Tabs,
  Tag,
  TopBar,
  assigneeOptions,
  attrValue,
  cx,
  formatBytes,
  inputClass,
  projectTone,
  textareaClass,
  timeAgo,
  useMe,
  useMembers,
  useProjects,
  wakeRoute,
  DeleteButton,
  canDelete,
} from "../components";
import { type EditorHandle, RichEditor } from "../editor";
import { ProjectDot } from "./Layout";
import { ShareTaskButton } from "../ShareTask";
import { DependenciesSection } from "../Dependencies";

type TabKey = "overview" | "activity" | "files";

export function TaskPage() {
  const { taskKey } = useParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["task", taskKey], queryFn: () => api.get<TaskDetail>(`/api/tasks/${taskKey}`) });
  const members = useMembers();
  const byId = new Map((members.data ?? []).map((m) => [m.id, m]));
  const [replyTo, setReplyTo] = useState<Entry | null>(null);
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as TabKey) || "overview";
  const setTab = (t: TabKey) => setParams(t === "overview" ? {} : { tab: t }, { replace: true });

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/api/tasks/${taskKey}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["task", taskKey] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
    },
  });

  const navigate = useNavigate();
  const meMember = useMe().data?.member;
  const problemAction = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "retry" | "dismiss" }) => api.post(`/api/runs/${id}/${action}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["task", taskKey] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
      qc.invalidateQueries({ queryKey: ["inbox"] });
    },
  });

  if (q.isLoading) return <div className="p-8 text-[13px] text-ink-3">Loading…</div>;
  if (q.error || !q.data)
    return (
      <EmptyState icon={<ListTodo size={18} />} title="Task not found" action={<Link to="/" className="text-[13px] text-accent hover:underline">Back to all tasks</Link>}>
        It may have been deleted, or the link is wrong.
      </EmptyState>
    );
  const { task, entries, notes, checklists, attachments, runs } = q.data;
  const openQuestions = entries.filter((e) => e.type === "question" && e.data.state === "open");
  const problems = runs.filter((r) => (r.status === "failed" || r.status === "stale") && !r.dismissed);
  const conversation = entries.filter((e) => e.type !== "system").length;
  const answer = (e: Entry) => {
    setReplyTo(e);
    setTab("activity");
  };

  return (
    <div className="flex h-full flex-col">
      <TopBar
        crumbs={[
          task.project
            ? { label: task.project.name, to: `/projects/${task.project.id}`, icon: <ProjectDot id={task.project.id} /> }
            : { label: "All tasks", to: "/", icon: <ListTodo size={15} className="text-ink-3" /> },
          { label: task.key },
        ]}
        actions={
          <>
          <ShareTaskButton taskKey={task.key} />
          {meMember?.role === "admin" && (
            <DeleteButton
              what="task"
              name={`${task.key} ${task.title}`}
              detail={`Its thread, notes, checklists, files${runs.length ? " and agent run history" : ""} are deleted too. Any agent working on it is stopped.`}
              onDelete={() => api.del(`/api/tasks/${task.key}`)}
              onDone={() => {
                qc.removeQueries({ queryKey: ["task", taskKey] });
                qc.invalidateQueries({ queryKey: ["tasks"] });
                navigate(task.project ? `/projects/${task.project.id}` : "/");
              }}
            />
          )}
          </>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-auto lg:flex-row lg:overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col lg:overflow-auto">
          <div className="px-4 pt-6 md:px-6">
            <div className="flex items-start gap-3">
              <span className="mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-line bg-panel">
                <StatusIcon status={task.status} size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <TitleEditor value={task.title} onSave={(title) => patch.mutate({ title })} />
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-ink-3">
                  <span className="tabular-nums">{task.key}</span>
                  <span>·</span>
                  <span>
                    Created by {byId.get(task.created_by)?.name ?? "someone"} {timeAgo(task.created_at)}
                  </span>
                </div>
              </div>
            </div>
            {task.archived_at && (
              <div className="mt-5 flex flex-wrap items-center gap-2 rounded-[10px] border border-line bg-subtle px-3.5 py-2.5 text-[13px] text-ink-2">
                <Archive size={15} className="shrink-0 text-ink-3" />
                <span>
                  Archived with{" "}
                  {task.project ? (
                    <Link to={`/projects/${task.project.id}`} className="font-medium text-ink underline-offset-2 hover:underline">
                      {task.project.name}
                    </Link>
                  ) : (
                    "its project"
                  )}{" "}
                  {timeAgo(task.archived_at)}. Agents aren't woken on it. Restore the project, or move this task to another one, to bring it back.
                </span>
              </div>
            )}
            {problems.map((r) => (
              <div
                key={r.id}
                role="alert"
                className="mt-5 flex flex-wrap items-center gap-3 rounded-[10px] border border-danger-line bg-danger-soft px-3.5 py-2.5 shadow-[inset_3px_0_0_var(--c-danger)]"
              >
                <TriangleAlert size={16} className="shrink-0 text-danger" />
                <div className="min-w-0 flex-1 text-[13px]">
                  <div className="font-medium text-danger">
                    {byId.get(r.agent_id)?.name ?? "The agent"}{" "}
                    {r.status === "stale" ? "has gone quiet on this task" : r.last_error?.match(/^(Failed|Blocked):/) ? "reported a problem" : "couldn't be reached"}
                  </div>
                  {(r.last_error || r.status === "stale") && (
                    <div className="mt-0.5 line-clamp-2 text-ink-2" title={r.last_error ?? undefined}>
                      {r.status === "stale" ? "No activity since it was woken. It may have crashed or lost access." : r.last_error}
                    </div>
                  )}
                </div>
                <div className="flex gap-1.5">
                  <Button size="sm" onClick={() => problemAction.mutate({ id: r.id, action: "retry" })} disabled={problemAction.isPending}>
                    Wake again
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => problemAction.mutate({ id: r.id, action: "dismiss" })} disabled={problemAction.isPending}>
                    Dismiss
                  </Button>
                </div>
              </div>
            ))}
            {openQuestions.length > 0 && (
              <div className="mt-5 flex flex-wrap items-center gap-3 rounded-[10px] border border-[#f5c99a] bg-[#fef6ee] px-3.5 py-2.5 dark:border-[#e5791d]/40 dark:bg-[#e5791d]/10">
                <MessageSquare size={16} className="text-[#e5791d]" />
                <span className="flex-1 text-[13px] font-medium text-[#8a4510] dark:text-[#f5ac6e]">
                  {openQuestions.length === 1
                    ? `${byId.get(openQuestions[0].author_id)?.name ?? "An agent"} is waiting for your answer`
                    : `${openQuestions.length} questions are waiting for an answer`}
                </span>
                <Button size="sm" onClick={() => answer(openQuestions[0])}>
                  Answer
                </Button>
              </div>
            )}
          </div>
          <Tabs
            className="mt-5"
            value={tab}
            onChange={setTab}
            tabs={[
              { value: "overview", label: "Overview", icon: <FileText size={14} /> },
              { value: "activity", label: "Activity", icon: <Activity size={14} />, count: conversation },
              { value: "files", label: "Files", icon: <Paperclip size={14} />, count: attachments.length },
            ]}
          />
          <div className="px-4 py-6 md:px-6">
            {tab === "overview" && (
              <div className="max-w-3xl space-y-8">
                <section>
                  <SectionTitle>Description</SectionTitle>
                  <DescriptionEditor key={task.id} value={task.description} onSave={(description) => patch.mutate({ description })} />
                </section>
                <ChecklistsSection taskKey={task.key} checklists={checklists} byId={byId} />
                <NotesSection taskKey={task.key} notes={notes} byId={byId} />
              </div>
            )}
            {tab === "activity" && (
              <div className="max-w-3xl">
                <Thread entries={entries} byId={byId} onReply={answer} attachments={attachments} />
                <Composer taskKey={task.key} replyTo={replyTo} onClearReply={() => setReplyTo(null)} byId={byId} />
              </div>
            )}
            {tab === "files" && <FilesTab taskKey={task.key} attachments={attachments} byId={byId} />}
          </div>
        </div>
        <Details detail={q.data} members={members.data ?? []} onPatch={(b) => patch.mutate(b)} runs={runs} />
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
      aria-label="Task title"
      onChange={(e) => setV(e.target.value.replace(/\n/g, ""))}
      onBlur={() => v.trim() && v !== value && onSave(v.trim())}
      onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), (e.target as HTMLTextAreaElement).blur())}
      className="-mx-1 w-full resize-none rounded-md bg-transparent px-1 text-[22px] leading-tight font-semibold tracking-[-0.015em] outline-none [field-sizing:content] hover:bg-hover focus:bg-transparent"
    />
  );
}

function DescriptionEditor({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const ref = useRef<EditorHandle>(null);
  const [dirty, setDirty] = useState(false);
  return (
    <div className="rounded-[10px] border border-line px-3.5 py-3 focus-within:border-line-strong">
      <RichEditor
        ref={ref}
        initial={value}
        slash
        placeholder="What needs to happen, and what does done look like? Type “/” for headings, lists, to-dos…"
        onChange={(md) => setDirty(md !== value)}
        onSubmit={() => {
          onSave(ref.current!.getMarkdown());
          setDirty(false);
        }}
      />
      {dirty && (
        <div className="mt-3 flex gap-2">
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              onSave(ref.current!.getMarkdown());
              setDirty(false);
            }}
          >
            Save description
          </Button>
          <Button
            variant="ghost"
            size="sm"
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

// ---------- Details panel ----------

function Details({
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
  const activeRuns = runs.filter((r) => !r.dismissed && r.status !== "ended");
  const me = useMe().data;
  const route = assignee ? wakeRoute(assignee, members, me) : { kind: null, pm: null };
  const pmAgent = members.find((m) => m.id === me?.workspace?.pm_agent_id && m.active) ?? null;
  const triage = useMutation({
    mutationFn: () => api.post(`/api/tasks/${task.key}/triage`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["task"] }),
  });

  return (
    <aside className="shrink-0 border-t border-line lg:w-[340px] lg:overflow-auto lg:border-t-0 lg:border-l">
      <div className="px-4 py-4">
        <SectionTitle>Details</SectionTitle>
        <AttrRow icon={<CircleDot size={14} />} label="Status">
          <Menu
            trigger={
              <span className={attrValue}>
                <StatusTag status={task.status} />
              </span>
            }
            value={task.status}
            onChange={(s: Status) => onPatch({ status: s })}
            options={STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s], icon: <StatusIcon status={s} /> }))}
          />
        </AttrRow>
        <AttrRow icon={<UserRound size={14} />} label="Assignee">
          <Menu
            searchable
            trigger={
              <span className={attrValue}>
                <MemberChip member={assignee} />
                {assignee?.kind === "agent" && <AgentBadge />}
              </span>
            }
            value={task.assignee?.id ?? "none"}
            onChange={(id) => onPatch({ assignee_id: id === "none" ? null : id })}
            options={assigneeOptions(members)}
          />
        </AttrRow>
        <AttrRow icon={<Signal size={14} />} label="Priority">
          <Menu
            trigger={
              <span className={attrValue}>
                <PriorityIcon priority={task.priority} /> {PRIORITY_LABEL[task.priority]}
              </span>
            }
            value={task.priority}
            onChange={(p: Priority) => onPatch({ priority: p })}
            options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p], icon: <PriorityIcon priority={p} /> }))}
          />
        </AttrRow>
        <AttrRow icon={<FolderKanban size={14} />} label="Project">
          <Menu
            searchable
            trigger={
              <span className={attrValue}>
                {task.project ? <Tag tone={projectTone(task.project.id)}>{task.project.name}</Tag> : <span className="text-ink-3">No project</span>}
              </span>
            }
            value={task.project?.id ?? "none"}
            onChange={(id) => onPatch({ project_id: id === "none" ? null : id })}
            options={[
              { value: "none", label: "No project" },
              ...(projects.data ?? []).filter((p) => p.status === "active").map((p) => ({ value: p.id, label: p.name, icon: <ProjectDot id={p.id} /> })),
            ]}
          />
        </AttrRow>
        <AttrRow icon={<CalendarDays size={14} />} label="Due date">
          <input
            type="date"
            aria-label="Due date"
            value={task.due_date ?? ""}
            onChange={(e) => onPatch({ due_date: e.target.value || null })}
            className={cx(attrValue, "w-full bg-transparent text-[13px] outline-none", !task.due_date && "text-ink-3")}
          />
        </AttrRow>
      </div>

      <DependenciesSection detail={detail} />

      {!assignee && pmAgent && (
        <div className="border-t border-line px-4 py-4">
          <SectionTitle>Assignment</SectionTitle>
          <p className="mb-2 text-[12px] leading-relaxed text-ink-3">No one is assigned. {pmAgent.name} can read the task and pick the right agent or person.</p>
          <Button size="sm" onClick={() => triage.mutate()} disabled={triage.isPending || triage.isSuccess}>
            <Zap size={13} /> {triage.isSuccess ? `${pmAgent.name} is on it` : `Ask ${pmAgent.name} to assign`}
          </Button>
          {triage.error && <p className="mt-1.5 text-[12px] text-danger">{(triage.error as Error).message}</p>}
        </div>
      )}

      {assignee?.kind === "agent" && (
        <div className="border-t border-line px-4 py-4">
          <SectionTitle
            action={
              <Button size="sm" onClick={() => wake.mutate()} disabled={wake.isPending}>
                <Zap size={13} /> Wake
              </Button>
            }
          >
            Agent runs
          </SectionTitle>
          {route.kind === null && (
            <p className="mb-2 rounded-lg bg-[#fdf5dc] px-2.5 py-2 text-[12px] text-[#946200] dark:bg-[#e5b53a]/15 dark:text-[#ecc76a]">
              {assignee.name} has no wake-up webhook and there's no workspace PM to route through, so it can't be woken.{" "}
              <Link to={`/team/${assignee.handle}`} className="underline">
                Set it up
              </Link>
            </p>
          )}
          {route.kind === "pm" && (
            <p className="mb-2 text-[12px] text-ink-3">
              Wake-ups go through the workspace PM, <Link to={`/team/${route.pm!.handle}`} className="text-ink-2 underline">@{route.pm!.handle}</Link>.
            </p>
          )}
          {runs.length === 0 && <p className="text-[12px] text-ink-3">{assignee.name} hasn't been woken for this task yet.</p>}
          <ul className="space-y-1">
            {runs.slice(0, 6).map((r) => (
              <li key={r.id} className="rounded-lg px-2 py-1.5 text-[12px] hover:bg-hover">
                <div className="flex items-center gap-2">
                  <RunStatus status={r.status} />
                  <span className="text-ink-3">{TRIGGER_LABEL[r.trigger] ?? r.trigger}</span>
                  <span className="ml-auto text-ink-3">{timeAgo(r.created_at)}</span>
                </div>
                {r.last_error && (r.status === "failed" || r.status === "queued") && (
                  <div className="mt-0.5 truncate text-[#c4312b]" title={r.last_error}>
                    {r.last_error}
                  </div>
                )}
                {(r.status === "failed" || r.status === "stale") && !r.dismissed && (
                  <div className="mt-1.5 flex gap-1">
                    <Button size="sm" onClick={() => runAction.mutate({ id: r.id, action: "retry" })}>
                      Wake again
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => runAction.mutate({ id: r.id, action: "dismiss" })}>
                      Dismiss
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          {activeRuns.length > 0 && <p className="mt-2 text-[12px] text-ink-3">Messages you send now are passed on when {assignee.name} finishes this run.</p>}
        </div>
      )}
    </aside>
  );
}

const TRIGGER_LABEL: Record<string, string> = {
  assigned: "Assigned",
  answered: "Answer received",
  mentioned: "Mentioned",
  manual: "Woken manually",
  followup: "Follow-up",
};

function RunStatus({ status }: { status: Run["status"] }) {
  const map: Record<Run["status"], [string, "gray" | "violet" | "red" | "amber" | "green"]> = {
    queued: ["Queued", "gray"],
    dispatched: ["Starting", "violet"],
    active: ["Working", "violet"],
    ended: ["Finished", "gray"],
    failed: ["Failed", "red"],
    stale: ["Gone quiet", "red"],
  };
  const [label, tone] = map[status];
  return (
    <Tag tone={tone}>
      {status === "active" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
      {label}
    </Tag>
  );
}

// ---------- Activity ----------

const SYSTEM_TEXT: Record<string, (d: any, byId: Map<string, Member>) => string> = {
  created: () => "created the task",
  note_deleted: (d) => `deleted the note “${d.title}”`,
  checklist_deleted: (d) => `deleted the checklist “${d.title}”`,
  attachment_deleted: (d) => `deleted the file ${d.filename}`,
  assigned: (d) => `assigned to ${d.to_name ?? "someone"}`,
  unassigned: () => "removed the assignee",
  status_changed: (d) => `moved from ${STATUS_LABEL[d.from as Status] ?? d.from} to ${STATUS_LABEL[d.to as Status] ?? d.to}`,
  priority_changed: (d) => `set priority to ${PRIORITY_LABEL[d.to as Priority] ?? d.to}`,
  title_changed: (d) => `renamed to “${d.to}”`,
  project_changed: (d) => (d.to_name ? `moved to project ${d.to_name}` : "removed from project"),
  due_date_changed: (d) => (d.to ? `set due date to ${d.to}` : "cleared the due date"),
  agent_woken: (d) => `was woken (${d.trigger})`,
  agent_not_configured: () => "couldn't be woken: no webhook configured",
  run_failed: (d) => (d.reported_by_agent ? `reported a problem: ${d.error ?? ""}` : `couldn't be reached: ${d.error ?? "unknown error"}`),
  run_stale: (d) => `has gone quiet (${d.reason})`,
  blocked_by_added: (d) => `marked this as blocked by ${d.key} ${d.title}`,
  blocked_by_removed: (d) => `removed the blocker ${d.key} ${d.title}`,
  blocks_added: (d) => `added ${d.key} ${d.title} as waiting on this`,
  blocks_removed: (d) => `removed ${d.key} ${d.title} from waiting on this`,
  unblocked: (d) => `unblocked: ${d.key} ${d.title} is ${d.outcome === "canceled" ? "canceled" : "done"}, nothing else is in the way`,
};

const ENTRY_REACTIONS = ["👍", "🎉", "👀", "❤️"] as const;

/** Emoji reactions on a thread message. 👍 means "acknowledged". */
function Reactions({ entry, byId, meId }: { entry: Entry; byId: Map<string, Member>; meId?: string }) {
  const qc = useQueryClient();
  const [picker, setPicker] = useState(false);
  const react = useMutation({
    mutationFn: (emoji: string) => api.post(`/api/entries/${entry.id}/reactions`, { emoji }),
    onMutate: async (emoji) => {
      // Optimistic toggle so the click feels instant.
      await qc.cancelQueries({ queryKey: ["task"] });
      qc.setQueriesData<TaskDetail>({ queryKey: ["task"] }, (d) => {
        if (!d?.entries || !meId) return d;
        return {
          ...d,
          entries: d.entries.map((x) => {
            if (x.id !== entry.id) return x;
            const list = x.reactions.map((r) => ({ ...r, by: [...r.by] }));
            let r = list.find((y) => y.emoji === emoji);
            if (!r) list.push((r = { emoji, count: 0, by: [] }));
            r.by = r.by.includes(meId) ? r.by.filter((id) => id !== meId) : [...r.by, meId];
            r.count = r.by.length;
            const order = (e: string) => ENTRY_REACTIONS.indexOf(e as (typeof ENTRY_REACTIONS)[number]);
            return { ...x, reactions: list.filter((y) => y.count > 0).sort((a, b) => order(a.emoji) - order(b.emoji)) };
          }),
        };
      });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["task"] }),
  });
  const names = (ids: string[]) => ids.map((id) => (id === meId ? "You" : (byId.get(id)?.name ?? "Someone"))).join(", ");
  const reactions = entry.reactions ?? [];
  const ack = reactions.find((r) => r.emoji === "👍");
  const iAcked = !!ack && !!meId && ack.by.includes(meId);
  const others = reactions.filter((r) => r.emoji !== "👍");
  // No "Acknowledge" button on your own messages (you still see who acknowledged them).
  const ownMessage = !!meId && entry.author_id === meId && !entry.data.via_share;
  const chip = "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[12px] tabular-nums transition-colors";
  return (
    <div className="mr-1 flex flex-wrap items-center gap-1">
      {(!ownMessage || ack) && (
        <button
          type="button"
          disabled={ownMessage && !iAcked}
          onClick={() => react.mutate("👍")}
          aria-pressed={iAcked}
          title={ack ? `Acknowledged by ${names(ack.by)}` : "Acknowledge: let them know you've seen this"}
          className={cx(
            chip,
            iAcked
              ? "border-accent/40 bg-accent-soft text-ink"
              : ack
                ? "border-line bg-canvas text-ink-2 hover:border-line-strong"
                : "border-transparent text-ink-3 hover:border-line hover:bg-hover hover:text-ink",
          )}
        >
          <span className="text-[13px] leading-none">👍</span>
          <span>{ack ? (ack.count === 1 ? `Acknowledged by ${names(ack.by)}` : `${ack.count} acknowledged`) : "Acknowledge"}</span>
        </button>
      )}
      {others.map((r) => {
        const mine = !!meId && r.by.includes(meId);
        return (
          <button
            key={r.emoji}
            type="button"
            onClick={() => react.mutate(r.emoji)}
            aria-pressed={mine}
            title={names(r.by)}
            className={cx(chip, mine ? "border-accent/40 bg-accent-soft" : "border-line bg-canvas hover:border-line-strong")}
          >
            <span className="text-[13px] leading-none">{r.emoji}</span>
            {r.count}
          </button>
        );
      })}
      <div
        className="relative"
        onBlur={(ev) => !ev.currentTarget.contains(ev.relatedTarget as Node) && setPicker(false)}
        onKeyDown={(ev) => ev.key === "Escape" && setPicker(false)}
      >
        <button
          type="button"
          onClick={() => setPicker((p) => !p)}
          aria-label="Add reaction"
          aria-expanded={picker}
          title="Add reaction"
          className="flex h-6 w-6 items-center justify-center rounded-full text-ink-3 hover:bg-hover hover:text-ink"
        >
          <SmilePlus size={14} />
        </button>
        {picker && (
          <div className="absolute bottom-7 left-0 z-20 flex gap-0.5 rounded-full border border-line bg-canvas p-0.5 shadow-pop">
            {ENTRY_REACTIONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => (react.mutate(emoji), setPicker(false))}
                aria-label={emoji === "👍" ? "Acknowledge" : `React ${emoji}`}
                className="flex h-7 w-7 items-center justify-center rounded-full text-[15px] hover:bg-hover"
              >
                {emoji}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

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
  const me = useMe().data?.member;
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ["task"] });
  const entryById = new Map(entries.map((e) => [e.id, e]));
  const attById = new Map(attachments.map((a) => [a.id, a]));
  return (
    <ol className="relative space-y-4 before:absolute before:top-3 before:bottom-3 before:left-[11px] before:w-px before:bg-line">
      {entries.map((e) => {
        const author = byId.get(e.author_id);
        if (e.type === "system" || e.type === "note_created" || e.type === "checklist_created" || e.type === "attachment_added") {
          let text = "";
          if (e.type === "system") text = (SYSTEM_TEXT[e.data.event] ?? (() => e.data.event))(e.data, byId);
          if (e.type === "note_created") text = `added the note “${e.data.title}”`;
          if (e.type === "checklist_created") text = `added the checklist “${e.data.title}”`;
          const att = e.type === "attachment_added" ? attById.get(e.data.attachment_id) : undefined;
          const isProblem = e.data.event === "run_failed" || e.data.event === "run_stale" || e.data.event === "agent_not_configured";
          return (
            <li key={e.id} className="relative flex items-start gap-3 text-[12px] text-ink-3">
              <span className="relative z-10 flex h-6 w-6 items-center justify-center rounded-full bg-canvas">
                <Avatar member={author} size={16} />
              </span>
              <span className={cx("pt-1", isProblem && "text-[#c4312b]")}>
                <span className="font-medium text-ink-2">{author?.name ?? "System"}</span>{" "}
                {e.type === "attachment_added" && e.data.deleted ? (
                  <>
                    attached <span className="line-through">{e.data.filename}</span> (deleted)
                  </>
                ) : e.type === "attachment_added" ? (
                  <>
                    attached{" "}
                    <a className="font-medium text-accent hover:underline" href={`/api/attachments/${e.data.attachment_id}`} target="_blank" rel="noreferrer">
                      {e.data.filename}
                    </a>
                    {att && att.content_type.startsWith("image/") && (
                      <img src={`/api/attachments/${att.id}`} alt={att.filename} className="mt-2 max-h-64 rounded-lg border border-line" />
                    )}
                  </>
                ) : (
                  text
                )}
                <span className="ml-1.5">{timeAgo(e.created_at)}</span>
              </span>
            </li>
          );
        }
        if (e.data.deleted) {
          return (
            <li key={e.id} className="relative flex items-start gap-3 text-[12px] text-ink-3">
              <span className="relative z-10 flex h-6 w-6 items-center justify-center rounded-full bg-canvas">
                <Avatar member={author} size={16} />
              </span>
              <span className="pt-1 italic">
                {author?.name ?? "Someone"}'s message was deleted{e.data.deleted_by && e.data.deleted_by !== e.author_id ? ` by ${byId.get(e.data.deleted_by)?.name ?? "an admin"}` : ""}
                <span className="ml-1.5 not-italic">{timeAgo(e.edited_at ?? e.created_at)}</span>
              </span>
            </li>
          );
        }
        const replied = e.reply_to_id ? entryById.get(e.reply_to_id) : undefined;
        const isQ = e.type === "question";
        const open = isQ && e.data.state === "open";
        const isAgent = author?.kind === "agent";
        return (
          <li key={e.id} className="relative flex gap-3">
            <span className="relative z-10 flex h-6 w-6 shrink-0 items-center justify-center bg-canvas">
              <Avatar member={author} size={24} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="mb-1.5 flex flex-wrap items-center gap-1.5 pt-0.5 text-[13px]">
                <span className="font-semibold">{e.data.via_share ? e.data.author_name || "External" : (author?.name ?? "Unknown")}</span>
                {e.data.via_share ? <Tag tone="gray">via share link · {e.data.via_share}</Tag> : isAgent && <AgentBadge />}
                <span className="text-ink-3">
                  {e.type === "update" ? "posted an update" : isQ ? "asked a question" : e.type === "answer" ? "answered" : "commented"}
                </span>
                <span className="text-[12px] text-ink-3">{timeAgo(e.created_at)}</span>
                {e.edited_at && <span className="text-[12px] text-ink-3">(edited)</span>}
                {isQ && !open && <Tag tone="green">Answered</Tag>}
              </div>
              <div
                className={cx(
                  "rounded-[10px] border px-3.5 py-2.5 text-[14px]",
                  open
                    ? "border-[#f5c99a] bg-[#fef6ee] dark:border-[#e5791d]/40 dark:bg-[#e5791d]/10"
                    : isAgent
                      ? "border-agent/20 bg-agent-soft/50"
                      : "border-line bg-canvas shadow-card",
                )}
              >
                {replied && (
                  <div className="mb-2 truncate border-l-2 border-line-strong pl-2 text-[12px] text-ink-3">
                    {byId.get(replied.author_id)?.name}: {replied.body.slice(0, 140)}
                  </div>
                )}
                {isQ && e.data.addressed_to && <div className="mb-1 text-[12px] text-ink-3">For {byId.get(e.data.addressed_to)?.name ?? "someone"}</div>}
                <Markdown text={e.body} />
                {(isQ || e.type === "comment" || e.type === "update" || e.type === "answer") && (
                  <div className="mt-2 flex flex-wrap items-center gap-y-1">
                    <Reactions entry={e} byId={byId} meId={me?.id} />
                    {e.type !== "answer" && (
                      <Button size="sm" variant={open ? "secondary" : "ghost"} onClick={() => onReply(e)}>
                        {open ? "Answer" : "Reply"}
                      </Button>
                    )}
                    {canDelete(me, e.author_id) && !open && (
                      <DeleteButton what="message" onDelete={() => api.del(`/api/entries/${e.id}`)} onDone={refresh} />
                    )}
                  </div>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ---------- Composer ----------

type Mode = "comment" | "update";

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
      const body = editor.current?.getMarkdown().trim() ?? "";
      if (!body) throw new Error("Write a message first");
      await api.post(`/api/tasks/${taskKey}/entries`, { type: mode, body, reply_to_id: replyTo?.id });
    },
    onSuccess: () => {
      editor.current?.setMarkdown("");
      onClearReply();
      done();
    },
  });
  const upload = useMutation({
    mutationFn: (files: File[]) => api.upload(`/api/tasks/${taskKey}/attachments`, files),
    onSuccess: done,
  });
  const isAnswer = replyTo?.type === "question";

  return (
    <div
      className="mt-6 flex gap-3"
      onDragOver={(e) => (e.preventDefault(), setDrag(true))}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        const files = [...e.dataTransfer.files];
        if (files.length) upload.mutate(files);
      }}
    >
      <Avatar member={me} size={24} />
      <div
        className={cx(
          "min-w-0 flex-1 rounded-[10px] border bg-canvas shadow-card focus-within:border-accent focus-within:ring-3 focus-within:ring-[var(--c-focus)]",
          drag ? "border-accent" : "border-line-strong",
        )}
      >
        {replyTo && (
          <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-[12px] text-ink-3">
            <span className="truncate">
              {isAnswer ? "Answering" : "Replying to"} {byId.get(replyTo.author_id)?.name}: “{replyTo.body.slice(0, 80)}”
            </span>
            <IconButton label="Cancel reply" className="ml-auto h-6 w-6" onClick={onClearReply}>
              <X size={13} />
            </IconButton>
          </div>
        )}
        <div className="px-3.5 pt-3">
          <RichEditor
            ref={editor}
            placeholder={
              isAnswer
                ? "Type your answer. The agent is woken to continue as soon as you send it."
                : mode === "update"
                  ? "Share a progress update…"
                  : "Write a comment… @mention an agent to wake it"
            }
            onSubmit={() => submit.mutate()}
            className="max-h-80 overflow-auto"
          />
        </div>
        <div className="flex items-center gap-1 px-2 pt-1 pb-2">
          {!replyTo && (
            <div className="flex rounded-lg bg-subtle p-0.5">
              {(["comment", "update"] as Mode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={cx("h-6 rounded-md px-2 text-[12px] font-medium capitalize", mode === m ? "bg-canvas text-ink shadow-btn" : "text-ink-3 hover:text-ink-2")}
                >
                  {m}
                </button>
              ))}
            </div>
          )}
          <IconButton label={upload.isPending ? "Uploading…" : "Attach files"} onClick={() => fileInput.current?.click()}>
            <Paperclip size={15} />
          </IconButton>
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
          <span className="mr-2 ml-auto hidden text-[12px] text-ink-3 sm:inline">⌘ Enter</span>
          <Button variant="primary" size="sm" onClick={() => submit.mutate()} disabled={submit.isPending}>
            {isAnswer ? "Send answer" : mode === "update" ? "Post update" : "Comment"}
          </Button>
        </div>
        {(submit.error || upload.error) && <p className="px-3.5 pb-2 text-[12px] text-[#c4312b]">{((submit.error || upload.error) as Error).message}</p>}
      </div>
    </div>
  );
}

// ---------- Files ----------

function FilesTab({ taskKey, attachments, byId }: { taskKey: string; attachments: TaskDetail["attachments"]; byId: Map<string, Member> }) {
  const qc = useQueryClient();
  const me = useMe().data?.member;
  const input = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: (files: File[]) => api.upload(`/api/tasks/${taskKey}/attachments`, files),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["task", taskKey] }),
  });
  const picker = (
    <>
      <Button onClick={() => input.current?.click()} disabled={upload.isPending}>
        <Plus size={14} /> {upload.isPending ? "Uploading…" : "Upload files"}
      </Button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          if (files.length) upload.mutate(files);
          e.target.value = "";
        }}
      />
    </>
  );
  if (!attachments.length)
    return (
      <EmptyState icon={<Paperclip size={18} />} title="No files yet" action={picker}>
        Files uploaded here, dropped into the thread, or attached by an agent appear in this list.
      </EmptyState>
    );
  return (
    <div className="max-w-3xl">
      <div className="mb-3 flex justify-end">{picker}</div>
      <ul className="divide-y divide-line overflow-hidden rounded-[10px] border border-line">
        {attachments.map((a) => (
          <li key={a.id} className="group flex items-center hover:bg-hover">
            <a href={`/api/attachments/${a.id}`} target="_blank" rel="noreferrer" className="flex h-12 min-w-0 flex-1 items-center gap-3 pl-3.5">
              <span className="flex h-7 w-7 items-center justify-center rounded-md border border-line bg-panel text-ink-3">
                <FileText size={14} />
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{a.filename}</span>
              <span className="hidden text-[12px] text-ink-3 sm:inline">{byId.get(a.uploaded_by)?.name}</span>
              <span className="w-16 text-right text-[12px] text-ink-3 tabular-nums">{formatBytes(a.size)}</span>
            </a>
            <span className="flex w-10 justify-center">
              {canDelete(me, a.uploaded_by) && (
                <DeleteButton
                  icon
                  what="file"
                  name={a.filename}
                  className="opacity-0 group-hover:opacity-100 focus:opacity-100"
                  onDelete={() => api.del(`/api/attachments/${a.id}`)}
                  onDone={() => qc.invalidateQueries({ queryKey: ["task", taskKey] })}
                />
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------- Notes & checklists ----------

function NotesSection({ taskKey, notes, byId }: { taskKey: string; notes: Note[]; byId: Map<string, Member> }) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const editor = useRef<EditorHandle>(null);
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: () => api.post(`/api/tasks/${taskKey}/notes`, { title: title || "Untitled note", content: editor.current?.getMarkdown() ?? "" }),
    onSuccess: () => {
      setAdding(false);
      setTitle("");
      qc.invalidateQueries({ queryKey: ["task", taskKey] });
    },
  });
  return (
    <section>
      <SectionTitle
        action={
          !adding && (
            <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
              <Plus size={13} /> New note
            </Button>
          )
        }
      >
        Notes
      </SectionTitle>
      <div className="space-y-3">
        {adding && (
          <div className="rounded-[10px] border border-line-strong px-3.5 py-3 shadow-card">
            <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Note title" className="mb-2 w-full bg-transparent text-[14px] font-semibold outline-none placeholder:text-ink-3" />
            <RichEditor ref={editor} placeholder="Write a note: headings, lists, to-dos, code…" onSubmit={() => create.mutate()} />
            <div className="mt-3 flex gap-2">
              <Button size="sm" variant="primary" onClick={() => create.mutate()} disabled={create.isPending}>
                Add note
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        {notes.map((n) => (
          <NoteCard key={n.id} note={n} taskKey={taskKey} byId={byId} />
        ))}
        {!notes.length && !adding && <p className="text-[13px] text-ink-3">Longer write-ups (research, drafts, decisions) live here. Agents can write them too.</p>}
      </div>
    </section>
  );
}

function ChecklistsSection({ taskKey, checklists, byId }: { taskKey: string; checklists: Checklist[]; byId: Map<string, Member> }) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [items, setItems] = useState("");
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: () =>
      api.post(`/api/tasks/${taskKey}/checklists`, {
        title: title || "Checklist",
        items: items.split("\n").map((s) => s.trim()).filter(Boolean),
      }),
    onSuccess: () => {
      setAdding(false);
      setTitle("");
      setItems("");
      qc.invalidateQueries({ queryKey: ["task", taskKey] });
    },
  });
  return (
    <section>
      <SectionTitle
        action={
          !adding && (
            <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
              <Plus size={13} /> Add checklist
            </Button>
          )
        }
      >
        Checklists
      </SectionTitle>
      <div className="space-y-3">
        {adding && (
          <div className="space-y-2 rounded-[10px] border border-line-strong p-3.5 shadow-card">
            <input autoFocus className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Checklist title" />
            <textarea className={textareaClass} rows={4} value={items} onChange={(e) => setItems(e.target.value)} placeholder={"One item per line\nAnother item"} />
            <div className="flex gap-2">
              <Button size="sm" variant="primary" onClick={() => create.mutate()} disabled={create.isPending}>
                Add checklist
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        {checklists.map((c) => (
          <ChecklistCard key={c.id} checklist={c} taskKey={taskKey} byId={byId} />
        ))}
        {!checklists.length && !adding && <p className="text-[13px] text-ink-3">Break the work into steps people and agents can tick off.</p>}
      </div>
    </section>
  );
}

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
  const author = byId.get(note.updated_by);
  const me = useMe().data?.member;
  return (
    <div className="rounded-[10px] border border-line bg-canvas shadow-card">
      <div className="flex h-11 items-center gap-2 border-b border-line px-3.5">
        <FileText size={14} className="text-ink-3" />
        {editing ? (
          <input value={title} onChange={(e) => setTitle(e.target.value)} className="flex-1 bg-transparent text-[13px] font-semibold outline-none" />
        ) : (
          <button onClick={() => setCollapsed((c) => !c)} className="flex-1 truncate text-left text-[13px] font-semibold">
            {note.title}
          </button>
        )}
        <span className="hidden items-center gap-1.5 text-[12px] text-ink-3 sm:flex">
          <Avatar member={author} size={14} /> {timeAgo(note.updated_at)}
        </span>
        {editing ? (
          <>
            <Button variant="primary" size="sm" onClick={() => save.mutate()}>
              Save
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={() => (setEditing(true), setCollapsed(false), setTitle(note.title))}>
              Edit
            </Button>
            {canDelete(me, note.created_by) && (
              <DeleteButton icon what="note" name={note.title} onDelete={() => api.del(`/api/notes/${note.id}`)} onDone={() => qc.invalidateQueries({ queryKey: ["task", taskKey] })} />
            )}
          </>
        )}
      </div>
      {!collapsed && (
        <div className="px-3.5 py-3 text-[14px]">
          {editing ? <RichEditor ref={editor} initial={note.content} autoFocus onSubmit={() => save.mutate()} /> : <Markdown text={note.content || "_This note is empty._"} />}
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
  const me = useMe().data?.member;
  const doneCount = checklist.items.filter((i) => i.done).length;
  const pct = checklist.items.length ? Math.round((doneCount / checklist.items.length) * 100) : 0;
  return (
    <div className="rounded-[10px] border border-line bg-canvas px-3.5 py-3 shadow-card">
      <div className="flex items-center gap-2">
        <CheckSquare size={14} className="text-ink-3" />
        <span className="text-[13px] font-semibold">{checklist.title}</span>
        <span className="ml-auto text-[12px] text-ink-3 tabular-nums">
          {doneCount} of {checklist.items.length}
        </span>
        {canDelete(me, checklist.created_by) && (
          <DeleteButton
            icon
            what="checklist"
            name={checklist.title}
            detail={checklist.items.length ? `All ${checklist.items.length} items go with it.` : undefined}
            onDelete={() => api.del(`/api/checklists/${checklist.id}`)}
            onDone={refresh}
          />
        )}
      </div>
      <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-active">
        <div className="h-full rounded-full bg-[#1f9d5c] transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      <ul className="mt-2">
        {checklist.items.map((i) => (
          <li key={i.id} className="group flex min-h-8 items-center gap-2.5 rounded-md px-1 hover:bg-hover">
            <input type="checkbox" checked={!!i.done} onChange={(e) => toggle.mutate({ id: i.id, done: e.target.checked })} />
            <span className={cx("flex-1 text-[13px]", !!i.done && "text-ink-3 line-through")}>{i.text}</span>
            {i.done_by && i.done ? <Avatar member={byId.get(i.done_by)} size={14} /> : null}
            <IconButton label="Remove item" className="h-6 w-6 opacity-0 group-hover:opacity-100 focus:opacity-100" onClick={() => remove.mutate(i.id)}>
              <X size={13} />
            </IconButton>
          </li>
        ))}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) add.mutate();
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Add an item…" className="mt-1 h-8 w-full rounded-md bg-transparent px-1 text-[13px] outline-none placeholder:text-ink-3 hover:bg-hover focus:bg-transparent" />
      </form>
    </div>
  );
}

export { Bot };
