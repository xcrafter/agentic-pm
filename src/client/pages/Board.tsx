import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { type Status, type Task, STATUSES, STATUS_LABEL, api } from "../api";
import { Avatar, Menu, PriorityIcon, StatusIcon, cx, timeAgo, useMe, useMembers, useProjects } from "../components";
import { CreateTaskModal } from "./CreateTask";

type View = "board" | "list";
const BOARD_STATUSES: Status[] = ["backlog", "todo", "in_progress", "waiting_on_human", "done"];

function loadView(): View {
  try {
    return (localStorage.getItem("apm:view") as View) || "board";
  } catch {
    return "board";
  }
}

export function BoardPage({ mine }: { mine?: boolean }) {
  const { projectId } = useParams();
  const me = useMe().data!;
  const members = useMembers();
  const projects = useProjects();
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
  const tasks = useQuery({
    queryKey: ["tasks", params.toString()],
    queryFn: () => api.get<Task[]>(`/api/tasks?${params}`),
  });

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
  const title = mine ? "My tasks" : project ? project.name : "All tasks";
  const setV = (v: View) => {
    setView(v);
    try {
      localStorage.setItem("apm:view", v);
    } catch {
      /* ignore */
    }
  };
  const byStatus = (s: Status) => (tasks.data ?? []).filter((t) => t.status === s);
  const filterChip = "rounded-md border border-zinc-200 px-2 py-1 text-xs text-zinc-600 dark:border-zinc-800 dark:text-zinc-300";

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-4 py-2.5 md:px-6 dark:border-zinc-800">
        <h1 className="mr-2 text-[15px] font-semibold">{title}</h1>
        {project?.description && <span className="hidden truncate text-xs text-zinc-400 lg:inline">{project.description}</span>}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {!mine && (
            <Menu
              searchable
              align="right"
              trigger={<span className={filterChip}>Assignee: {assignee === "all" ? "Anyone" : members.data?.find((m) => m.id === assignee)?.name ?? "Unassigned"}</span>}
              value={assignee}
              onChange={setAssignee}
              options={[
                { value: "all", label: "Anyone" },
                { value: "none", label: "Unassigned", icon: <Avatar member={null} size={16} /> },
                ...(members.data ?? []).map((m) => ({ value: m.id, label: m.name, icon: <Avatar member={m} size={16} /> })),
              ]}
            />
          )}
          <Menu
            align="right"
            trigger={<span className={filterChip}>{kind === "all" ? "Humans & agents" : kind === "agent" ? "Agents only" : "Humans only"}</span>}
            value={kind}
            onChange={setKind}
            options={[
              { value: "all", label: "Humans & agents" },
              { value: "human", label: "Assigned to humans" },
              { value: "agent", label: "Assigned to agents" },
            ]}
          />
          <div className="flex rounded-md border border-zinc-200 p-0.5 text-xs dark:border-zinc-800">
            {(["board", "list"] as View[]).map((v) => (
              <button
                key={v}
                onClick={() => setV(v)}
                className={cx("rounded px-2 py-0.5 capitalize", view === v ? "bg-zinc-200 font-medium dark:bg-zinc-700" : "text-zinc-500")}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
      </header>

      {tasks.isLoading ? (
        <div className="p-6 text-zinc-400">Loading…</div>
      ) : view === "board" ? (
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3 md:p-4">
          {BOARD_STATUSES.map((s) => (
            <Column
              key={s}
              status={s}
              tasks={byStatus(s)}
              onDrop={(key) => move.mutate({ key, status: s })}
              onAdd={() => setCreatingIn(s)}
            />
          ))}
        </div>
      ) : (
        <div className="flex-1 overflow-auto pb-10">
          {STATUSES.map((s) => {
            const items = byStatus(s);
            if (!items.length) return null;
            return (
              <section key={s}>
                <div className="sticky top-0 flex items-center gap-2 border-b border-zinc-200 bg-zinc-50 px-4 py-1.5 text-xs font-medium md:px-6 dark:border-zinc-800 dark:bg-zinc-900">
                  <StatusIcon status={s} /> {STATUS_LABEL[s]} <span className="text-zinc-400">{items.length}</span>
                </div>
                {items.map((t) => (
                  <ListRow key={t.id} task={t} />
                ))}
              </section>
            );
          })}
          {!tasks.data?.length && <Empty />}
        </div>
      )}
      <CreateTaskModal open={!!creatingIn} onClose={() => setCreatingIn(null)} defaultProjectId={projectId} defaultStatus={creatingIn ?? undefined} />
    </div>
  );
}

function Empty() {
  return (
    <div className="p-10 text-center text-sm text-zinc-400">
      No tasks here yet. Press <kbd className="rounded border px-1">C</kbd> to create one.
    </div>
  );
}

function Column({ status, tasks, onDrop, onAdd }: { status: Status; tasks: Task[]; onDrop: (key: string) => void; onAdd: () => void }) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={cx(
        "flex w-72 shrink-0 flex-col rounded-lg bg-zinc-100/70 dark:bg-zinc-900/60",
        over && "ring-2 ring-accent/40",
      )}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const key = e.dataTransfer.getData("text/task-key");
        if (key) onDrop(key);
      }}
    >
      <div className="flex items-center gap-2 px-3 py-2 text-[13px] font-medium">
        <StatusIcon status={status} />
        {STATUS_LABEL[status]}
        <span className="text-zinc-400">{tasks.length}</span>
        <button onClick={onAdd} className="ml-auto rounded px-1 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-800" title="Add task">
          +
        </button>
      </div>
      <div className="flex min-h-10 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {tasks.map((t) => (
          <Card key={t.id} task={t} />
        ))}
      </div>
    </div>
  );
}

function RunBadge({ task }: { task: Task }) {
  if (task.open_questions > 0)
    return (
      <span className="rounded bg-orange-100 px-1.5 py-px text-[11px] font-medium text-orange-700 dark:bg-orange-500/15 dark:text-orange-300">
        {task.open_questions} question{task.open_questions > 1 ? "s" : ""}
      </span>
    );
  if (!task.run_status) return null;
  const map: Record<string, [string, string]> = {
    queued: ["Waking…", "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"],
    dispatched: ["Agent starting", "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300"],
    active: ["Agent working", "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"],
    failed: ["Agent unreachable", "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300"],
    stale: ["Agent quiet", "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300"],
  };
  const m = map[task.run_status];
  if (!m) return null;
  return (
    <span className={cx("inline-flex items-center gap-1 rounded px-1.5 py-px text-[11px] font-medium", m[1])}>
      {task.run_status === "active" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
      {m[0]}
    </span>
  );
}

function Card({ task }: { task: Task }) {
  return (
    <Link
      to={`/t/${task.key}`}
      draggable
      onDragStart={(e) => e.dataTransfer.setData("text/task-key", task.key)}
      className="block rounded-md border border-zinc-200 bg-white p-2.5 shadow-xs hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
    >
      <div className="flex items-center gap-1.5 text-[11px] text-zinc-400">
        <span>{task.key}</span>
        <span className="ml-auto">
          <Avatar member={task.assignee} size={18} />
        </span>
      </div>
      <div className="mt-1 text-[13px] leading-snug font-medium">{task.title}</div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {task.priority !== "none" && <PriorityIcon priority={task.priority} />}
        {task.project && (
          <span className="rounded border border-zinc-200 px-1.5 py-px text-[11px] text-zinc-500 dark:border-zinc-700">{task.project.name}</span>
        )}
        <RunBadge task={task} />
      </div>
    </Link>
  );
}

function ListRow({ task }: { task: Task }) {
  return (
    <Link
      to={`/t/${task.key}`}
      className="flex items-center gap-3 border-b border-zinc-100 px-4 py-2 text-[13px] hover:bg-zinc-50 md:px-6 dark:border-zinc-900 dark:hover:bg-zinc-900"
    >
      <PriorityIcon priority={task.priority} />
      <span className="w-16 shrink-0 text-xs text-zinc-400">{task.key}</span>
      <StatusIcon status={task.status} />
      <span className="min-w-0 flex-1 truncate">{task.title}</span>
      <RunBadge task={task} />
      {task.project && <span className="hidden text-xs text-zinc-500 sm:inline">{task.project.name}</span>}
      <span className="hidden w-16 text-right text-xs text-zinc-400 sm:inline">{timeAgo(task.updated_at)}</span>
      <Avatar member={task.assignee} size={20} />
    </Link>
  );
}
