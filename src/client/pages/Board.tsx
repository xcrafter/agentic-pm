import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, CircleDot, Clock, Columns3, FolderKanban, ListTodo, Plus, Signal, Table2, UserRound, Bot, Users } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { type Status, type Task, STATUSES, STATUS_LABEL, api } from "../api";
import {
  Avatar,
  Button,
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

export function TaskTable({ tasks }: { tasks: Task[] }) {
  const nav = useNavigate();
  const order = new Map(STATUSES.map((s, i) => [s, i]));
  const rows = [...tasks].sort((a, b) => order.get(a.status)! - order.get(b.status)! || b.updated_at.localeCompare(a.updated_at));
  const cell = "h-10 border-r border-b border-line px-3 text-[13px] whitespace-nowrap";
  return (
    <div className="min-h-0 flex-1 overflow-auto">
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
          {rows.map((t) => (
            <tr key={t.id} onClick={() => nav(`/t/${t.key}`)} className="group cursor-pointer">
              <td className={cx(cell, "sticky left-0 bg-canvas group-hover:bg-hover")}>
                <Link to={`/t/${t.key}`} onClick={(e) => e.stopPropagation()} className="flex min-w-0 items-center gap-2">
                  <span className="w-12 shrink-0 text-[12px] text-ink-3 tabular-nums">{t.key}</span>
                  <span className="truncate font-medium">{t.title}</span>
                  <RunBadge task={t} compact />
                </Link>
              </td>
              <td className={cx(cell, "group-hover:bg-hover")}>
                <StatusTag status={t.status} />
              </td>
              <td className={cx(cell, "max-w-[190px] group-hover:bg-hover")}>
                <MemberChip member={t.assignee} />
              </td>
              <td className={cx(cell, "max-w-[170px] group-hover:bg-hover")}>
                {t.project ? <Tag tone={projectTone(t.project.id)}>{t.project.name}</Tag> : <span className="text-ink-3">—</span>}
              </td>
              <td className={cx(cell, "group-hover:bg-hover")}>
                <span className="flex items-center gap-1.5 text-ink-2">
                  <PriorityIcon priority={t.priority} />
                  {t.priority === "none" ? "" : t.priority[0].toUpperCase() + t.priority.slice(1)}
                </span>
              </td>
              <td className={cx(cell, "text-ink-2 group-hover:bg-hover")}>{t.due_date ? formatDate(t.due_date) : <span className="text-ink-3">—</span>}</td>
              <td className={cx(cell, "text-ink-3 group-hover:bg-hover")}>{timeAgo(t.updated_at)}</td>
              <td className="border-b border-line group-hover:bg-hover" />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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

export function RunBadge({ task, compact }: { task: Task; compact?: boolean }) {
  if (task.open_questions > 0)
    return (
      <Tag tone="orange" className="shrink-0">
        {compact ? `${task.open_questions} question${task.open_questions > 1 ? "s" : ""}` : `Waiting on you · ${task.open_questions}`}
      </Tag>
    );
  if (!task.run_status) return null;
  const map: Record<string, [string, "gray" | "violet" | "red" | "amber"]> = {
    queued: ["Waking", "gray"],
    dispatched: ["Starting", "violet"],
    active: ["Working", "violet"],
    failed: ["Unreachable", "red"],
    stale: ["Gone quiet", "amber"],
  };
  const m = map[task.run_status];
  if (!m) return null;
  return (
    <Tag tone={m[1]} className="shrink-0">
      {task.run_status === "active" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
      {m[0]}
    </Tag>
  );
}

function Card({ task }: { task: Task }) {
  return (
    <Link
      to={`/t/${task.key}`}
      draggable
      onDragStart={(e) => e.dataTransfer.setData("text/task-key", task.key)}
      className="block rounded-[10px] border border-line-strong bg-canvas p-3 shadow-card hover:border-ink-3/40"
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
