import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, CircleDot, Clock, Columns3, FolderKanban, ListTodo, Plus, Signal, Table2, UserRound, Bot, Users, TriangleAlert } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { type Priority, type Status, type Task, PRIORITIES, PRIORITY_LABEL, STATUSES, STATUS_LABEL, api } from "../api";
import {
  Avatar,
  Button,
  assigneeOptions,
  Chip,
  EmptyState,
  MemberChip,
  Menu,
  PriorityIcon,
  StatusIcon,
  StatusTag,
  Tag,
  TopBar,
  cx,
  projectTone,
  timeAgo,
  useMe,
  useMembers,
  useProjects,
  useShell,
  ChevronDown,
} from "../components";
import { CreateTaskModal } from "./CreateTask";
import { ProjectDot } from "./Layout";

type View = "table" | "board";
const BOARD_STATUSES: Status[] = ["backlog", "todo", "in_progress", "waiting_on_human", "done"];

function loadView(): View {
  try {
    const v = localStorage.getItem("apm:view");
    return v === "board" ? "board" : "table";
  } catch {
    return "table";
  }
}

export function BoardPage({ mine }: { mine?: boolean }) {
  const { projectId } = useParams();
  const me = useMe().data!;
  const members = useMembers();
  const projects = useProjects();
  const shell = useShell();
  const [view, setView] = useState<View>(loadView);
  const [assignee, setAssignee] = useState<string>("all");
  const [kind, setKind] = useState<"all" | "human" | "agent">("all");
  const [creatingIn, setCreatingIn] = useState<Status | null>(null);
  const qc = useQueryClient();

  const params = new URLSearchParams();
  if (mine) params.set("assignee", me.member!.id);
  else if (assignee !== "all") params.set("assignee", assignee);
  if (projectId) params.set("project", projectId);
  if (kind !== "all") params.set("kind", kind);
  const tasks = useQuery({ queryKey: ["tasks", params.toString()], queryFn: () => api.get<Task[]>(`/api/tasks?${params}`) });

  const move = useMutation({
    mutationFn: ({ key, status }: { key: string; status: Status }) => api.patch(`/api/tasks/${key}`, { status }),
    onMutate: async ({ key, status }) => {
      const qk = ["tasks", params.toString()];
      await qc.cancelQueries({ queryKey: qk });
      qc.setQueryData<Task[]>(qk, (old) => old?.map((t) => (t.key === key ? { ...t, status } : t)));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });

  const project = projects.data?.find((p) => p.id === projectId);
  const setV = (v: View) => {
    setView(v);
    try {
      localStorage.setItem("apm:view", v);
    } catch {
      /* per-viewer convenience only */
    }
  };
  const list = tasks.data ?? [];
  const assigneeName = assignee === "all" ? null : assignee === "none" ? "Unassigned" : members.data?.find((m) => m.id === assignee)?.name;

  const crumbs = mine
    ? [{ label: "My tasks", icon: <UserRound size={15} className="text-ink-3" /> }]
    : project
      ? [
          { label: "Projects", to: "/projects", icon: <FolderKanban size={15} className="text-ink-3" /> },
          { label: project.name, icon: <ProjectDot id={project.id} /> },
        ]
      : [{ label: "All tasks", icon: <ListTodo size={15} className="text-ink-3" /> }];

  return (
    <div className="flex h-full flex-col">
      <TopBar
        crumbs={crumbs}
        actions={
          <Button variant="primary" onClick={shell.createTask}>
            <Plus size={15} /> New task
          </Button>
        }
      />
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 md:px-5">
        <div className="flex rounded-lg border border-line-strong bg-subtle p-0.5">
          {(
            [
              ["table", "Table", <Table2 size={14} />],
              ["board", "Board", <Columns3 size={14} />],
            ] as [View, string, ReactNode][]
          ).map(([v, label, icon]) => (
            <button
              key={v}
              onClick={() => setV(v)}
              className={cx(
                "flex h-6 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium",
                view === v ? "bg-canvas text-ink shadow-btn" : "text-ink-3 hover:text-ink-2",
              )}
            >
              {icon}
              {label}
            </button>
          ))}
        </div>
        <span className="mx-1 h-4 w-px bg-line-strong" />
        {!mine && (
          <Menu
            searchable
            trigger={
              <Chip active={assignee !== "all"}>
                <UserRound size={13} /> {assigneeName ? `Assignee: ${assigneeName}` : "Assignee"} <ChevronDown size={13} />
              </Chip>
            }
            value={assignee}
            onChange={setAssignee}
            options={[
              { value: "all", label: "Anyone" },
              { value: "none", label: "Unassigned", icon: <Avatar member={null} size={16} /> },
              ...(members.data ?? []).filter((m) => m.active).map((m) => ({ value: m.id, label: m.name, icon: <Avatar member={m} size={16} /> })),
            ]}
          />
        )}
        <Menu
          trigger={
            <Chip active={kind !== "all"}>
              {kind === "agent" ? <Bot size={13} /> : <Users size={13} />}
              {kind === "all" ? "People & agents" : kind === "agent" ? "Agents' work" : "People's work"}
              <ChevronDown size={13} />
            </Chip>
          }
          value={kind}
          onChange={setKind}
          options={[
            { value: "all", label: "People & agents" },
            { value: "human", label: "Assigned to people" },
            { value: "agent", label: "Assigned to agents" },
          ]}
        />
        <span className="ml-auto text-[12px] text-ink-3">
          {list.length} {list.length === 1 ? "task" : "tasks"}
        </span>
      </div>

      {tasks.isLoading ? (
        <div className="p-6 text-[13px] text-ink-3">Loading…</div>
      ) : !list.length ? (
        <EmptyState
          icon={<ListTodo size={18} />}
          title={mine ? "Nothing assigned to you" : "No tasks yet"}
          action={
            <Button variant="primary" onClick={shell.createTask}>
              <Plus size={15} /> New task
            </Button>
          }
        >
          Create a task and assign it to a teammate or an agent. Agents are woken as soon as you assign them.
        </EmptyState>
      ) : view === "table" ? (
        <TaskTable tasks={list} />
      ) : (
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto bg-subtle p-3 md:p-4">
          {BOARD_STATUSES.map((s) => (
            <Column key={s} status={s} tasks={list.filter((t) => t.status === s)} onDrop={(key) => move.mutate({ key, status: s })} onAdd={() => setCreatingIn(s)} />
          ))}
        </div>
      )}
      <CreateTaskModal open={!!creatingIn} onClose={() => setCreatingIn(null)} defaultProjectId={projectId} defaultStatus={creatingIn ?? undefined} />
    </div>
  );
}

// ---------- Table ----------

const COLS: { key: string; label: string; icon: ReactNode; width: string }[] = [
  { key: "title", label: "Task", icon: <ListTodo size={13} />, width: "min-w-[320px] w-[38%]" },
  { key: "status", label: "Status", icon: <CircleDot size={13} />, width: "w-[170px]" },
  { key: "assignee", label: "Assignee", icon: <UserRound size={13} />, width: "w-[190px]" },
  { key: "project", label: "Project", icon: <FolderKanban size={13} />, width: "w-[170px]" },
  { key: "priority", label: "Priority", icon: <Signal size={13} />, width: "w-[120px]" },
  { key: "due", label: "Due", icon: <CalendarDays size={13} />, width: "w-[110px]" },
  { key: "updated", label: "Updated", icon: <Clock size={13} />, width: "w-[110px]" },
];

/** Edit a task from a list: optimistic update of every cached task list, then refetch. */
export function useTaskPatch() {
  const qc = useQueryClient();
  const members = useMembers();
  const projects = useProjects();
  return useMutation({
    mutationFn: ({ task, body }: { task: Task; body: Record<string, unknown> }) => api.patch<Task>(`/api/tasks/${task.key}`, body),
    onMutate: async ({ task, body }) => {
      await qc.cancelQueries({ queryKey: ["tasks"] });
      const prev = qc.getQueriesData<Task[]>({ queryKey: ["tasks"] });
      const next: Partial<Task> = {};
      if ("status" in body) next.status = body.status as Status;
      if ("priority" in body) next.priority = body.priority as Priority;
      if ("due_date" in body) next.due_date = body.due_date as string | null;
      if ("assignee_id" in body) {
        const m = members.data?.find((x) => x.id === body.assignee_id);
        next.assignee = m ? { id: m.id, name: m.name, handle: m.handle, kind: m.kind, avatar_url: m.avatar_url } : null;
      }
      if ("project_id" in body) {
        const p = projects.data?.find((x) => x.id === body.project_id);
        next.project = p ? { id: p.id, name: p.name } : null;
      }
      qc.setQueriesData<Task[]>({ queryKey: ["tasks"] }, (old) => old?.map((t) => (t.id === task.id ? { ...t, ...next } : t)));
      return { prev };
    },
    onError: (_e, _v, ctx) => ctx?.prev.forEach(([key, data]) => qc.setQueryData(key, data)),
    onSettled: (_d, _e, { task }) => {
      qc.invalidateQueries({ queryKey: ["tasks"] });
      qc.invalidateQueries({ queryKey: ["task", task.key] });
    },
  });
}

/** A table cell whose whole area opens an editor; hover shows it's editable. */
const editCell = "flex h-full w-full items-center gap-1.5 px-3 rounded-none hover:bg-active focus-visible:bg-active";

export function TaskTable({ tasks }: { tasks: Task[] }) {
  const members = useMembers();
  const projects = useProjects();
  const patch = useTaskPatch();
  const [order] = useState(() => new Map(STATUSES.map((s, i) => [s, i])));
  const rows = [...tasks].sort((a, b) => order.get(a.status)! - order.get(b.status)! || b.created_at.localeCompare(a.created_at));
  const cell = "h-10 border-r border-b border-line text-[13px] whitespace-nowrap";
  const edit = (task: Task, body: Record<string, unknown>) => patch.mutate({ task, body });
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {patch.error && (
        <div className="sticky top-0 left-0 z-20 border-b border-danger-line bg-danger-soft px-4 py-2 text-[13px] text-danger">
          Couldn't save: {(patch.error as Error).message}
        </div>
      )}
      <table className="w-full min-w-[1100px] border-separate border-spacing-0">
        <thead className="sticky top-0 z-10 bg-canvas">
          <tr>
            {COLS.map((c, i) => (
              <th
                key={c.key}
                className={cx(
                  "h-9 border-r border-b border-line px-3 text-left text-[12px] font-medium text-ink-3",
                  c.width,
                  i === 0 && "sticky left-0 z-10 bg-canvas",
                )}
              >
                <span className="flex items-center gap-1.5">
                  {c.icon}
                  {c.label}
                </span>
              </th>
            ))}
            <th className="border-b border-line" />
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => {
            const health = taskHealth(t);
            return (
              <tr
                key={t.id}
                className={cx("group", health === "problem" && "[&>td]:bg-danger-soft [&>td]:border-b-danger-line")}
                title={health === "problem" ? "Something went wrong with the agent's run. Open the task to see why." : undefined}
              >
                <td
                  className={cx(
                    cell,
                    "sticky left-0 z-[1] p-0",
                    health === "problem" ? "bg-danger-soft shadow-[inset_3px_0_0_var(--c-danger)]" : "bg-canvas group-hover:bg-hover",
                    health === "waiting" && "shadow-[inset_3px_0_0_var(--c-warn)]",
                  )}
                >
                  <Link to={`/t/${t.key}`} className="flex h-full min-w-0 items-center gap-2 px-3" title="Open task">
                    <span className="w-12 shrink-0 text-[12px] text-ink-3 tabular-nums">{t.key}</span>
                    <span className="truncate font-medium hover:underline">{t.title}</span>
                    <RunBadge task={t} compact />
                  </Link>
                </td>
                <td className={cx(cell, "p-0 group-hover:bg-hover")}>
                  <Menu
                    label={`Status of ${t.key}`}
                    className={editCell}
                    trigger={<StatusTag status={t.status} />}
                    value={t.status}
                    onChange={(s: Status) => edit(t, { status: s })}
                    options={STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s], icon: <StatusIcon status={s} /> }))}
                  />
                </td>
                <td className={cx(cell, "max-w-[190px] p-0 group-hover:bg-hover")}>
                  <Menu
                    label={`Assignee of ${t.key}`}
                    searchable
                    className={editCell}
                    trigger={<MemberChip member={t.assignee} />}
                    value={t.assignee?.id ?? "none"}
                    onChange={(id) => edit(t, { assignee_id: id === "none" ? null : id })}
                    options={assigneeOptions(members.data)}
                  />
                </td>
                <td className={cx(cell, "max-w-[170px] p-0 group-hover:bg-hover")}>
                  <Menu
                    label={`Project of ${t.key}`}
                    searchable
                    className={editCell}
                    trigger={t.project ? <Tag tone={projectTone(t.project.id)}>{t.project.name}</Tag> : <span className="text-ink-3">—</span>}
                    value={t.project?.id ?? "none"}
                    onChange={(id) => edit(t, { project_id: id === "none" ? null : id })}
                    options={[
                      { value: "none", label: "No project" },
                      ...(projects.data ?? []).filter((p) => p.status === "active").map((p) => ({ value: p.id, label: p.name, icon: <ProjectDot id={p.id} /> })),
                    ]}
                  />
                </td>
                <td className={cx(cell, "p-0 group-hover:bg-hover")}>
                  <Menu
                    label={`Priority of ${t.key}`}
                    className={editCell}
                    width="w-48"
                    trigger={
                      <span className="flex items-center gap-1.5 text-ink-2">
                        <PriorityIcon priority={t.priority} />
                        {t.priority === "none" ? "" : PRIORITY_LABEL[t.priority]}
                      </span>
                    }
                    value={t.priority}
                    onChange={(p: Priority) => edit(t, { priority: p })}
                    options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p], icon: <PriorityIcon priority={p} /> }))}
                  />
                </td>
                <td className={cx(cell, "p-0 group-hover:bg-hover")}>
                  <DueCell task={t} onChange={(d) => edit(t, { due_date: d })} />
                </td>
                <td className={cx(cell, "px-3 text-ink-3 group-hover:bg-hover")}>{timeAgo(t.updated_at)}</td>
                <td className="border-b border-line group-hover:bg-hover" />
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Due date: shows the date; the native date picker sits on top so a click opens it. */
function DueCell({ task, onChange }: { task: Task; onChange: (d: string | null) => void }) {
  return (
    <label className={cx(editCell, "relative cursor-pointer")} title="Set due date">
      <span className={cx(isOverdue(task) ? "font-medium text-danger" : task.due_date ? "text-ink-2" : "text-ink-3")}>
        {task.due_date ? formatDate(task.due_date) : "—"}
      </span>
      <input
        type="date"
        aria-label={`Due date of ${task.key}`}
        value={task.due_date ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        onClick={(e) => {
          try {
            (e.currentTarget as HTMLInputElement).showPicker?.();
          } catch {
            /* older browsers open it on click anyway */
          }
        }}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
      />
    </label>
  );
}

export function formatDate(d: string) {
  return new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ---------- Board ----------

function Column({ status, tasks, onDrop, onAdd }: { status: Status; tasks: Task[]; onDrop: (key: string) => void; onAdd: () => void }) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={cx("flex w-[280px] shrink-0 flex-col rounded-xl", over && "bg-accent-soft")}
      onDragOver={(e) => (e.preventDefault(), setOver(true))}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const key = e.dataTransfer.getData("text/task-key");
        if (key) onDrop(key);
      }}
    >
      <div className="flex h-9 items-center gap-2 px-1.5">
        <StatusTag status={status} />
        <span className="text-[12px] text-ink-3 tabular-nums">{tasks.length}</span>
        <button onClick={onAdd} className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-ink-3 hover:bg-active hover:text-ink" aria-label={`Add task to ${STATUS_LABEL[status]}`}>
          <Plus size={14} />
        </button>
      </div>
      <div className="flex min-h-12 flex-1 flex-col gap-2 overflow-y-auto pb-2">
        {tasks.map((t) => (
          <Card key={t.id} task={t} />
        ))}
      </div>
    </div>
  );
}

/**
 * How a task is doing, for color coding: "problem" when an agent run failed, was blocked or went quiet
 * (red), "waiting" when an agent is waiting on a human answer (orange).
 */
export type TaskHealth = "problem" | "waiting" | "ok";
export function taskHealth(task: Pick<Task, "run_status" | "open_questions">): TaskHealth {
  if (task.run_status === "failed" || task.run_status === "stale") return "problem";
  if (task.open_questions > 0) return "waiting";
  return "ok";
}

export function RunBadge({ task, compact }: { task: Task; compact?: boolean }) {
  const problem = taskHealth(task) === "problem";
  const map: Record<string, [string, "gray" | "violet" | "red" | "amber"]> = {
    queued: ["Waking", "gray"],
    dispatched: ["Starting", "violet"],
    active: ["Working", "violet"],
    failed: ["Run failed", "red"],
    stale: ["Gone quiet", "red"],
  };
  const run = task.run_status ? map[task.run_status] : undefined;
  return (
    <>
      {problem && run && (
        <Tag tone="red" className="shrink-0">
          <TriangleAlert size={12} />
          {run[0]}
        </Tag>
      )}
      {task.open_questions > 0 && (
        <Tag tone="orange" className="shrink-0">
          {compact ? `${task.open_questions} question${task.open_questions > 1 ? "s" : ""}` : `Waiting on you · ${task.open_questions}`}
        </Tag>
      )}
      {!problem && !task.open_questions && run && (
        <Tag tone={run[1]} className="shrink-0">
          {task.run_status === "active" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
          {run[0]}
        </Tag>
      )}
    </>
  );
}

const isOverdue = (t: Task) => !!t.due_date && t.status !== "done" && t.status !== "canceled" && t.due_date < new Date().toISOString().slice(0, 10);

function Card({ task }: { task: Task }) {
  const health = taskHealth(task);
  return (
    <Link
      to={`/t/${task.key}`}
      draggable
      onDragStart={(e) => e.dataTransfer.setData("text/task-key", task.key)}
      className={cx(
        "block rounded-[10px] border p-3 shadow-card",
        health === "problem"
          ? "border-danger-line bg-danger-soft shadow-[inset_3px_0_0_var(--c-danger)] hover:border-danger"
          : health === "waiting"
            ? "border-line-strong bg-canvas shadow-[inset_3px_0_0_var(--c-warn)] hover:border-ink-3/40"
            : "border-line-strong bg-canvas hover:border-ink-3/40",
      )}
      title={health === "problem" ? "Something went wrong with the agent's run. Open the task to see why." : undefined}
    >
      <div className="text-[13px] leading-snug font-medium">{task.title}</div>
      <div className="mt-2.5 space-y-1.5 text-[12px]">
        <div className="flex items-center gap-2">
          <MemberChip member={task.assignee} size={16} muted />
          <span className="ml-auto shrink-0 text-ink-3 tabular-nums">{task.key}</span>
        </div>
        {(task.project || task.priority !== "none" || task.run_status || task.open_questions > 0) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {task.priority !== "none" && <PriorityIcon priority={task.priority} />}
            {task.project && <Tag tone={projectTone(task.project.id)}>{task.project.name}</Tag>}
            <RunBadge task={task} compact />
          </div>
        )}
      </div>
    </Link>
  );
}

export { StatusIcon };
