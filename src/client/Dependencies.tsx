import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2, Plus, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import { type DepTask, type Task, type TaskDetail, api } from "./api";
import { SectionTitle, StatusIcon, cx, findStatus, useStatuses } from "./components";

type Dir = "blocked_by" | "blocks";

const DONE = new Set(["done", "canceled"]);

/** "Blocked by" / "Blocks" lists on the task page, with search-or-create pickers. */
export function DependenciesSection({ detail }: { detail: TaskDetail }) {
  const { task, dependencies: deps } = detail;
  const statuses = useStatuses();
  const qc = useQueryClient();
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["task"] });
    qc.invalidateQueries({ queryKey: ["tasks"] });
  };
  const remove = useMutation({
    mutationFn: ({ dir, key }: { dir: Dir; key: string }) =>
      api.del(`/api/tasks/${task.key}/dependencies?${dir}=${encodeURIComponent(key)}`),
    onSuccess: refresh,
  });
  const linked = new Set([task.id, ...deps.blocked_by.map((t) => t.id), ...deps.blocking.map((t) => t.id)]);

  const group = (dir: Dir, label: string, hint: string, rows: DepTask[]) => (
    <div className="mt-1">
      <div className="flex h-7 items-center gap-2 text-[12px] text-ink-3">
        <span className="font-medium text-ink-2">{label}</span>
        {dir === "blocked_by" && deps.open_blockers > 0 && (
          <span className="text-[#b25e09] dark:text-[#f5ac6e]">{deps.open_blockers} not done</span>
        )}
        <span className="ml-auto">
          <TaskPicker task={task} dir={dir} exclude={linked} hint={hint} onDone={refresh} />
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="pb-1 pl-0.5 text-[12px] text-ink-3">
          {dir === "blocked_by" ? "Nothing. It can start any time." : "No tasks wait on this one."}
        </p>
      ) : (
        <ul className="space-y-0.5">
          {rows.map((t) => (
            <li key={t.id} className="group flex min-w-0 items-center gap-2 rounded-md px-1 py-1 hover:bg-hover">
              <StatusIcon status={t.status_key ?? t.status} />
              <Link
                to={`/t/${t.key}`}
                className="flex min-w-0 flex-1 items-baseline gap-1.5 text-[13px]"
                title={`${t.key} ${t.title} · ${findStatus(statuses, t.status_key ?? t.status).name}`}
              >
                <span className="shrink-0 text-[12px] tabular-nums text-ink-3">{t.key}</span>
                <span className={cx("truncate", DONE.has(t.status) && "text-ink-3 line-through")}>{t.title}</span>
              </Link>
              <button
                type="button"
                aria-label={`Remove link to ${t.key}`}
                title="Remove link"
                onClick={() => remove.mutate({ dir, key: t.key })}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-3 opacity-0 hover:bg-line hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
              >
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <div className="border-t border-line px-4 py-4">
      <SectionTitle>Dependencies</SectionTitle>
      {group("blocked_by", "Blocked by", "Add a task this one waits for", deps.blocked_by)}
      {group("blocks", "Blocks", "Add a dependent task (it waits for this one)", deps.blocking)}
      {remove.error && <p className="mt-1 text-[12px] text-danger">{(remove.error as Error).message}</p>}
    </div>
  );
}

function TaskPicker({
  task,
  dir,
  exclude,
  hint,
  onDone,
}: {
  task: Task;
  dir: Dir;
  exclude: Set<string>;
  hint: string;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{
    top?: number;
    bottom?: number;
    left: number;
  }>({ left: 0 });
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 150);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !btn.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("mousedown", close, true);
    return () => document.removeEventListener("mousedown", close, true);
  }, [open]);

  const results = useQuery({
    queryKey: ["tasks", "pick", debounced],
    enabled: open,
    queryFn: () =>
      api.get<Task[]>(
        debounced
          ? `/api/tasks?q=${encodeURIComponent(debounced)}&limit=12`
          : `/api/tasks?status=backlog,todo,in_progress,waiting_on_human&limit=12`,
      ),
  });
  const options = (results.data ?? []).filter((t) => !exclude.has(t.id)).slice(0, 8);
  const canCreate = q.trim().length > 0;
  const count = options.length + (canCreate ? 1 : 0);

  const link = useMutation({
    mutationFn: (other: Task) => api.post(`/api/tasks/${task.key}/dependencies`, { [dir]: other.key }),
    onSuccess: () => (setOpen(false), onDone()),
  });
  const create = useMutation({
    mutationFn: () =>
      api.post<Task>("/api/tasks", {
        title: q.trim(),
        project_id: task.project?.id ?? null,
        // A new task this one waits for "blocks" it; a new dependent task is "blocked by" it.
        [dir === "blocked_by" ? "blocks" : "blocked_by"]: [task.key],
      }),
    onSuccess: () => (setOpen(false), onDone()),
  });
  const busy = link.isPending || create.isPending;
  const error = (link.error ?? create.error) as Error | null;

  const choose = (i: number) => {
    if (busy) return;
    if (i < options.length) link.mutate(options[i]);
    else if (canCreate) create.mutate();
  };

  const toggle = () => {
    if (!open) {
      const r = btn.current!.getBoundingClientRect();
      const below = window.innerHeight - r.bottom;
      setPos({
        ...(below < 340 && r.top > below ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
        left: Math.max(8, Math.min(r.right - 320, window.innerWidth - 328)),
      });
      setQ("");
      setActive(0);
      link.reset();
      create.reset();
    }
    setOpen((o) => !o);
  };

  return (
    <>
      <button
        ref={btn}
        type="button"
        onClick={toggle}
        aria-label={hint}
        title={hint}
        aria-expanded={open}
        className="flex h-6 w-6 items-center justify-center rounded-md text-ink-3 hover:bg-hover hover:text-ink"
      >
        <Plus size={14} />
      </button>
      {open &&
        createPortal(
          <div
            ref={pop}
            className="fixed z-[100] w-[320px] rounded-[10px] bg-canvas p-1 text-ink shadow-pop"
            style={pos}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), setOpen(false), btn.current?.focus());
              else if (e.key === "ArrowDown") (e.preventDefault(), setActive((i) => Math.min(i + 1, count - 1)));
              else if (e.key === "ArrowUp") (e.preventDefault(), setActive((i) => Math.max(i - 1, 0)));
              else if (e.key === "Enter") (e.preventDefault(), choose(active));
            }}
          >
            <div className="px-2 pb-1 pt-1.5 text-[12px] text-ink-3">
              {dir === "blocked_by" ? `${task.key} is blocked by…` : `Tasks that wait for ${task.key}…`}
            </div>
            <div className="mb-1 flex items-center gap-1.5 border-b border-line px-2 pb-1.5">
              <Search size={13} className="text-ink-3" />
              <input
                autoFocus
                value={q}
                onChange={(e) => (setQ(e.target.value), setActive(0))}
                placeholder="Search tasks or type a new title"
                className="w-full bg-transparent text-[13px] outline-none"
                aria-label="Search tasks"
              />
            </div>
            <div role="listbox" className="max-h-72 overflow-auto">
              {options.map((t, i) => (
                <button
                  key={t.id}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(i)}
                  className={cx(
                    "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px]",
                    i === active && "bg-hover",
                  )}
                >
                  <StatusIcon status={t.status_key ?? t.status} />
                  <span className="shrink-0 text-[12px] tabular-nums text-ink-3">{t.key}</span>
                  <span className="truncate">{t.title}</span>
                </button>
              ))}
              {results.isFetching && !options.length && <div className="px-2 py-1.5 text-[12px] text-ink-3">Searching…</div>}
              {!results.isFetching && !options.length && !canCreate && (
                <div className="px-2 py-1.5 text-[12px] text-ink-3">No open tasks to link.</div>
              )}
              {canCreate && (
                <button
                  type="button"
                  role="option"
                  aria-selected={active === options.length}
                  onMouseEnter={() => setActive(options.length)}
                  onClick={() => choose(options.length)}
                  className={cx(
                    "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px]",
                    active === options.length && "bg-hover",
                    options.length > 0 && "mt-1",
                  )}
                >
                  <Plus size={14} className="shrink-0 text-ink-3" />
                  <span className="truncate">
                    Create “{q.trim()}”{dir === "blocks" ? " as a dependent task" : " as a blocker"}
                  </span>
                </button>
              )}
            </div>
            {(busy || error) && (
              <div className={cx("border-t border-line px-2 pb-1 pt-1.5 text-[12px]", error ? "text-danger" : "text-ink-3")}>
                {error ? (
                  error.message
                ) : (
                  <span className="inline-flex items-center gap-1">
                    <Link2 size={12} /> Linking…
                  </span>
                )}
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
