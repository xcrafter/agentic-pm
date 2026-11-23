import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpDown,
  CalendarDays,
  Check,
  CircleDot,
  Clock,
  Columns3,
  Eye,
  EyeOff,
  Filter,
  FolderKanban,
  Layers,
  ListTodo,
  Plus,
  Search,
  Signal,
  SlidersHorizontal,
  Table2,
  Trash2,
  Star,
  TriangleAlert,
  UserRound,
  X,
  Link2,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { type Priority, type Status, type Task, PRIORITIES, PRIORITY_LABEL, STATUSES, STATUS_LABEL, api } from "../api";
import {
  Avatar,
  Button,
  IconButton,
  MultiSelect,
  Popover,
  inputClass,
  useSavedViews,
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
import {
  type Layout,
  type SavedView,
  type SortKey,
  type ViewConfig,
  DEFAULT_CONFIG,
  PRESETS,
  SORT_LABEL,
  activeFilterCount,
  applyFilters,
  isClosed,
  normalizeConfig,
  sameConfig,
  sortTasks,
  taskDefaultsFrom,
} from "../taskViews";
import { ProjectDot, filterNote } from "./Layout";

const BOARD_STATUSES: Status[] = ["backlog", "todo", "in_progress", "waiting_on_human", "done", "canceled"];

function loadLocal(key: string): ViewConfig | null {
  try {
    const raw = localStorage.getItem(`apm:cfg:${key}`);
    if (raw) return normalizeConfig(JSON.parse(raw));
    // Older single "view" preference.
    const legacy = localStorage.getItem("apm:view");
    return legacy === "board" ? { ...DEFAULT_CONFIG, layout: "board" } : null;
  } catch {
    return null;
  }
}
function saveLocal(key: string, c: ViewConfig) {
  try {
    localStorage.setItem(`apm:cfg:${key}`, JSON.stringify(c));
  } catch {
    /* per-viewer convenience only */
  }
}


export function BoardPage({ mine }: { mine?: boolean }) {
  const { projectId } = useParams();
  const [search, setSearch] = useSearchParams();
  const viewId = search.get("view");
  const me = useMe().data!;
  const shell = useShell();
  const projects = useProjects();
  const views = useSavedViews();
  const [creatingIn, setCreatingIn] = useState<Status | null>(null);
  const qc = useQueryClient();

  const scope = mine ? "mine" : projectId ? `project:${projectId}` : "all";
  const preset = viewId ? PRESETS.find((p) => p.id === viewId) : undefined;
  const saved = viewId && !preset ? views.data?.find((v) => v.id === viewId) : undefined;
  const base: ViewConfig = preset ? preset.config : saved ? normalizeConfig(saved.config) : (loadLocal(scope) ?? DEFAULT_CONFIG);
  const draftKey = viewId ? `view:${viewId}` : scope;
  const [drafts, setDrafts] = useState<Record<string, ViewConfig>>({});
  const cfg = drafts[draftKey] ?? base;
  const setCfg = (patch: Partial<ViewConfig>) => {
    const next = { ...cfg, ...patch };
    setDrafts((d) => ({ ...d, [draftKey]: next }));
    if (!viewId) saveLocal(scope, next);
  };
  const dirty = !!viewId && !sameConfig(cfg, base);
  const resetDraft = () => setDrafts((d) => {
    const { [draftKey]: _, ...rest } = d;
    return rest;
  });

  const params = new URLSearchParams();
  if (mine) params.set("assignee", me.member!.id);
  if (projectId) params.set("project", projectId);
  const tasks = useQuery({ queryKey: ["tasks", params.toString()], queryFn: () => api.get<Task[]>(`/api/tasks?${params}`) });
  const all = tasks.data ?? [];
  const list = sortTasks(applyFilters(all, cfg, me.member?.id), cfg.sort);
  const closedHidden = cfg.hideDone ? applyFilters(all, { ...cfg, hideDone: false }, me.member?.id).filter(isClosed).length : 0;

  const move = useMutation({
    mutationFn: ({ key, status }: { key: string; status: Status }) => api.patch(`/api/tasks/${key}`, { status }),
    onMutate: async ({ key, status }) => {
      const qk = ["tasks", params.toString()];
      await qc.cancelQueries({ queryKey: qk });
      qc.setQueryData<Task[]>(qk, (old) => old?.map((t) => (t.key === key ? { ...t, status } : t)));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });

  const saveView = useMutation({
    mutationFn: (v: { id?: string; name?: string }) =>
      v.id ? api.patch<SavedView>(`/api/views/${v.id}`, { config: cfg, ...(v.name ? { name: v.name } : {}) }) : api.post<SavedView>("/api/views", { name: v.name, config: cfg }),
    onSuccess: (v) => {
      qc.invalidateQueries({ queryKey: ["views"] });
      resetDraft();
      if (v.id !== viewId) setSearch({ view: v.id });
    },
  });

  const project = projects.data?.find((p) => p.id === projectId);
  const viewName = preset?.name ?? saved?.name;
  const crumbs = mine
    ? [{ label: "My tasks", icon: <UserRound size={15} className="text-ink-3" /> }]
    : project
      ? [
          { label: "Projects", to: "/projects", icon: <FolderKanban size={15} className="text-ink-3" /> },
          { label: project.name, icon: <ProjectDot id={project.id} /> },
        ]
      : [{ label: "All tasks", icon: <ListTodo size={15} className="text-ink-3" />, to: viewName ? "/" : undefined }, ...(viewName ? [{ label: viewName }] : [])];
  const boardStatuses = BOARD_STATUSES.filter((st) =>
    cfg.status.length ? cfg.status.includes(st) : cfg.hideDone ? !(st === "done" || st === "canceled") : st !== "canceled",
  );
  const filters = activeFilterCount(cfg);

  // New tasks created from here start inside this view: its single-value filters become the form's defaults.
  const taskDefaults = taskDefaultsFrom(cfg, me.member?.id, { mine, projectId });
  const defaultsKey = JSON.stringify(taskDefaults);
  const { setTaskDefaults } = shell;
  useEffect(() => {
    setTaskDefaults(JSON.parse(defaultsKey));
  }, [defaultsKey, setTaskDefaults]);
  useEffect(() => () => setTaskDefaults(null), [setTaskDefaults]);

  return (
    <div className="flex h-full flex-col">
      <TopBar
        crumbs={crumbs}
        actions={
          <Button variant="primary" onClick={shell.createTask} className="hidden md:inline-flex">
            <Plus size={15} /> New task
          </Button>
        }
      />
      <Toolbar
        cfg={cfg}
        setCfg={setCfg}
        hideAssignee={!!mine}
        hideProject={!!projectId}
        viewId={viewId}
        viewName={viewName}
        savedViews={views.data ?? []}
        onPickView={(id) => setSearch(id ? { view: id } : {})}
        dirty={dirty}
        onReset={resetDraft}
        onSave={(name) => saveView.mutate(saved && !name ? { id: saved.id } : { name })}
        saving={saveView.isPending}
        saveError={saveView.error ? (saveView.error as Error).message : null}
        count={list.length}
        closedHidden={closedHidden}
        canSaveInPlace={!!saved}
      />

      {tasks.isLoading ? (
        <div className="p-6 text-[13px] text-ink-3">Loading…</div>
      ) : !all.length ? (
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
      ) : !list.length ? (
        <EmptyState
          icon={<Filter size={18} />}
          title="No tasks match"
          action={
            <Button onClick={() => setCfg({ ...DEFAULT_CONFIG, layout: cfg.layout, sort: cfg.sort, hideDone: false })}>Clear filters</Button>
          }
        >
          {filters ? `${filters} filter${filters > 1 ? "s" : ""} applied` : ""}
          {cfg.hideDone && closedHidden ? `${filters ? "; " : ""}${closedHidden} completed hidden` : ""}.
        </EmptyState>
      ) : cfg.layout === "table" ? (
        <TaskTable tasks={list} sort={cfg.sort} onSort={(sort) => setCfg({ sort })} />
      ) : (
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto bg-subtle p-3 md:p-4">
          {boardStatuses.map((st) => (
            <Column key={st} status={st} tasks={list.filter((t) => t.status === st)} onDrop={(key) => move.mutate({ key, status: st })} onAdd={() => setCreatingIn(st)} />
          ))}
        </div>
      )}
      <CreateTaskModal
        open={!!creatingIn}
        onClose={() => setCreatingIn(null)}
        defaults={{ ...taskDefaults, status: creatingIn ?? taskDefaults.status }}
        note={filterNote({ ...taskDefaults, status: undefined }, projectId)}
      />
    </div>
  );
}

// ---------- Toolbar: views, filters, sort ----------

function Toolbar(p: {
  cfg: ViewConfig;
  setCfg: (patch: Partial<ViewConfig>) => void;
  hideAssignee: boolean;
  hideProject: boolean;
  viewId: string | null;
  viewName: string | undefined;
  savedViews: SavedView[];
  onPickView: (id: string | null) => void;
  dirty: boolean;
  onReset: () => void;
  onSave: (newName?: string) => void;
  saving: boolean;
  saveError: string | null;
  count: number;
  closedHidden: number;
  canSaveInPlace: boolean;
}) {
  const { cfg, setCfg } = p;
  const me = useMe().data;
  const members = useMembers();
  const projects = useProjects();
  const qc = useQueryClient();
  const [naming, setNaming] = useState<string | null>(null);
  const filters = activeFilterCount(cfg);
  const removeView = useMutation({
    mutationFn: (id: string) => api.del(`/api/views/${id}`),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: ["views"] });
      if (id === p.viewId) p.onPickView(null);
    },
  });
  const toggleFavorite = useMutation({
    mutationFn: (v: SavedView) => (v.favorite ? api.del(`/api/views/${v.id}/favorite`) : api.put(`/api/views/${v.id}/favorite`)),
    onMutate: (v) => qc.setQueryData<SavedView[]>(["views"], (old) => old?.map((x) => (x.id === v.id ? { ...x, favorite: !v.favorite } : x))),
    onSettled: () => qc.invalidateQueries({ queryKey: ["views"] }),
  });
  const nameOf = (ids: string[], lookup: (id: string) => string | undefined) =>
    ids.length === 1 ? lookup(ids[0]) : `${ids.length} selected`;
  const memberName = (id: string) => (id === "me" ? "Me" : id === "none" ? "Unassigned" : members.data?.find((m) => m.id === id)?.name);
  const projectName = (id: string) => (id === "none" ? "No project" : projects.data?.find((x) => x.id === id)?.name);
  const sep = <span className="mx-0.5 h-4 w-px bg-line-strong" />;

  return (
    <div className="border-b border-line">
      <div className="scroll-row flex flex-wrap items-center gap-2 px-3 py-2 md:px-5">
        {/* Views */}
        <Popover
          label="Views"
          width="w-72"
          trigger={
            <Chip active={!!p.viewId}>
              <Layers size={13} /> {p.viewName ?? "Views"}
              {p.dirty && <span className="h-1.5 w-1.5 rounded-full bg-current" title="Unsaved changes" />}
              <ChevronDown size={13} />
            </Chip>
          }
        >
          {(close) => (
            <>
              <div className="px-2 pt-1 pb-1 text-[11px] font-medium text-ink-3">Built in</div>
              {PRESETS.map((v) => (
                <ViewRow key={v.id} name={v.name} active={p.viewId === v.id} onPick={() => (p.onPickView(v.id), close())} />
              ))}
              <div className="mt-1 flex items-baseline justify-between border-t border-line px-2 pt-2 pb-1 text-[11px] font-medium text-ink-3">
                Saved views <span className="font-normal">Star to show in your sidebar</span>
              </div>
              {p.savedViews.map((v) => (
                <ViewRow
                  key={v.id}
                  name={v.name}
                  active={p.viewId === v.id}
                  onPick={() => (p.onPickView(v.id), close())}
                  favorite={!!v.favorite}
                  onFavorite={() => toggleFavorite.mutate(v)}
                  onDelete={me?.member && (me.member.role === "admin" || v.created_by === me.member.id) ? () => removeView.mutate(v.id) : undefined}
                />
              ))}
              {!p.savedViews.length && <div className="px-2 pb-1 text-[12px] text-ink-3">Set filters, then save them as a view everyone can use.</div>}
              <div className="mt-1 border-t border-line pt-1">
                {naming === null ? (
                  <button type="button" onClick={() => setNaming("")} className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-[13px] hover:bg-hover">
                    <Plus size={13} className="text-ink-3" /> Save current as new view…
                  </button>
                ) : (
                  <form
                    className="flex gap-1 p-1"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (naming.trim()) {
                        p.onSave(naming.trim());
                        setNaming(null);
                        close();
                      }
                    }}
                  >
                    <input autoFocus value={naming} onChange={(e) => setNaming(e.target.value)} placeholder="View name" maxLength={60} className={cx(inputClass, "h-7")} />
                    <Button size="sm" variant="primary" disabled={!naming.trim()}>
                      Save
                    </Button>
                  </form>
                )}
                {p.viewId && (
                  <button type="button" onClick={() => (p.onPickView(null), close())} className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-[13px] text-ink-2 hover:bg-hover">
                    <X size={13} className="text-ink-3" /> Leave view
                  </button>
                )}
              </div>
            </>
          )}
        </Popover>

        <div className="flex rounded-lg border border-line-strong bg-subtle p-0.5">
          {(
            [
              ["table", "Table", <Table2 size={14} />],
              ["board", "Board", <Columns3 size={14} />],
            ] as [Layout, string, ReactNode][]
          ).map(([v, label, icon]) => (
            <button
              key={v}
              onClick={() => setCfg({ layout: v })}
              aria-pressed={cfg.layout === v}
              className={cx(
                "flex h-6 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium",
                cfg.layout === v ? "bg-canvas text-ink shadow-btn" : "text-ink-3 hover:text-ink-2",
              )}
            >
              {icon}
              {label}
            </button>
          ))}
        </div>
        {sep}

        <label className="flex h-7 w-44 items-center gap-1.5 rounded-lg border border-line-strong bg-canvas px-2 text-[12px] focus-within:border-accent/50">
          <Search size={13} className="shrink-0 text-ink-3" />
          <input
            value={cfg.q}
            onChange={(e) => setCfg({ q: e.target.value })}
            placeholder="Filter by title or key"
            aria-label="Filter tasks by text"
            className="w-full min-w-0 bg-transparent outline-none placeholder:text-ink-3"
          />
          {cfg.q && (
            <button type="button" onClick={() => setCfg({ q: "" })} aria-label="Clear text filter" className="text-ink-3 hover:text-ink">
              <X size={12} />
            </button>
          )}
        </label>

        <MultiSelect
          label="Filter by status"
          trigger={
            <Chip active={!!cfg.status.length}>
              <CircleDot size={13} /> {cfg.status.length ? `Status: ${nameOf(cfg.status, (s) => STATUS_LABEL[s as Status])}` : "Status"} <ChevronDown size={13} />
            </Chip>
          }
          value={cfg.status}
          onChange={(status) => setCfg({ status })}
          options={STATUSES.map((st) => ({ value: st, label: STATUS_LABEL[st], icon: <StatusIcon status={st} /> }))}
        />
        {!p.hideAssignee && (
          <MultiSelect
            searchable
            label="Filter by assignee"
            width="w-72"
            trigger={
              <Chip active={!!cfg.assignees.length}>
                <UserRound size={13} /> {cfg.assignees.length ? `Assignee: ${nameOf(cfg.assignees, memberName)}` : "Assignee"} <ChevronDown size={13} />
              </Chip>
            }
            value={cfg.assignees}
            onChange={(assignees) => setCfg({ assignees })}
            options={[
              { value: "me", label: "Me", icon: <Avatar member={me?.member} size={16} /> },
              { value: "none", label: "Unassigned", icon: <Avatar member={null} size={16} /> },
              ...(members.data ?? [])
                .filter((m) => m.active)
                .map((m) => ({ value: m.id, label: m.name, icon: <Avatar member={m} size={16} />, hint: m.kind === "agent" ? <span className="text-agent">Agent</span> : undefined })),
            ]}
          />
        )}
        {!p.hideProject && (
          <MultiSelect
            searchable
            label="Filter by project"
            trigger={
              <Chip active={!!cfg.projects.length}>
                <FolderKanban size={13} /> {cfg.projects.length ? `Project: ${nameOf(cfg.projects, projectName)}` : "Project"} <ChevronDown size={13} />
              </Chip>
            }
            value={cfg.projects}
            onChange={(projects) => setCfg({ projects })}
            options={[
              { value: "none", label: "No project" },
              ...(projects.data ?? []).filter((x) => x.status === "active").map((x) => ({ value: x.id, label: x.name, icon: <ProjectDot id={x.id} /> })),
            ]}
          />
        )}
        <MultiSelect
          label="Filter by priority"
          width="w-52"
          trigger={
            <Chip active={!!cfg.priorities.length}>
              <Signal size={13} /> {cfg.priorities.length ? `Priority: ${nameOf(cfg.priorities, (x) => PRIORITY_LABEL[x as Priority])}` : "Priority"} <ChevronDown size={13} />
            </Chip>
          }
          value={cfg.priorities}
          onChange={(priorities) => setCfg({ priorities })}
          options={PRIORITIES.map((x) => ({ value: x, label: PRIORITY_LABEL[x], icon: <PriorityIcon priority={x} /> }))}
        />
        <Popover
          label="More filters"
          width="w-64"
          trigger={
            <Chip active={cfg.due !== "any" || cfg.kind !== "all" || cfg.attention}>
              <SlidersHorizontal size={13} /> More
              {cfg.due !== "any" || cfg.kind !== "all" || cfg.attention ? ` · ${(cfg.due !== "any" ? 1 : 0) + (cfg.kind !== "all" ? 1 : 0) + (cfg.attention ? 1 : 0)}` : ""}
              <ChevronDown size={13} />
            </Chip>
          }
        >
          <div className="space-y-3 p-2 text-[13px]">
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-0.5" checked={cfg.attention} onChange={(e) => setCfg({ attention: e.target.checked })} />
              <span>
                Needs attention
                <span className="block text-[12px] text-ink-3">Failed or quiet agent runs, and unanswered questions</span>
              </span>
            </label>
            <div>
              <div className="mb-1 text-[12px] font-medium text-ink-3">Due date</div>
              <Segmented
                value={cfg.due}
                onChange={(due) => setCfg({ due })}
                options={[
                  ["any", "Any"],
                  ["overdue", "Overdue"],
                  ["week", "Next 7 days"],
                  ["none", "No date"],
                ]}
              />
            </div>
            <div>
              <div className="mb-1 text-[12px] font-medium text-ink-3">Assigned to</div>
              <Segmented
                value={cfg.kind}
                onChange={(kind) => setCfg({ kind })}
                options={[
                  ["all", "Anyone"],
                  ["human", "People"],
                  ["agent", "Agents"],
                ]}
              />
            </div>
          </div>
        </Popover>
        {filters > 0 && (
          <button
            type="button"
            onClick={() => setCfg({ status: [], assignees: [], projects: [], priorities: [], due: "any", kind: "all", attention: false, q: "" })}
            className="h-7 rounded-md px-1.5 text-[12px] font-medium text-ink-3 hover:bg-hover hover:text-ink"
          >
            Clear filters
          </button>
        )}

        <div className="flex items-center gap-2 md:ml-auto">
          <button
            type="button"
            role="switch"
            aria-checked={!cfg.hideDone}
            onClick={() => setCfg({ hideDone: !cfg.hideDone })}
            title={cfg.hideDone ? "Done and canceled tasks are hidden" : "Showing done and canceled tasks"}
            className={cx(
              "flex h-7 items-center gap-1.5 rounded-lg border px-2 text-[12px] font-medium",
              cfg.hideDone ? "border-line-strong bg-canvas text-ink-2 shadow-btn hover:bg-hover" : "border-accent/30 bg-accent-soft text-accent",
            )}
          >
            {cfg.hideDone ? <EyeOff size={13} /> : <Eye size={13} />}
            {cfg.hideDone ? `Completed hidden${p.closedHidden ? ` (${p.closedHidden})` : ""}` : "Showing completed"}
          </button>
          <Menu
            label="Sort tasks"
            align="right"
            width="w-48"
            trigger={
              <Chip>
                <ArrowUpDown size={13} /> {SORT_LABEL[cfg.sort]}
              </Chip>
            }
            value={cfg.sort}
            onChange={(sort: SortKey) => setCfg({ sort })}
            options={(Object.keys(SORT_LABEL) as SortKey[]).map((k) => ({ value: k, label: SORT_LABEL[k] }))}
          />
          <span className="text-[12px] text-ink-3 tabular-nums">
            {p.count} {p.count === 1 ? "task" : "tasks"}
          </span>
        </div>
      </div>
      {p.dirty && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line bg-panel px-3 py-1.5 text-[12px] md:px-5">
          <span className="text-ink-2">You've changed “{p.viewName}”.</span>
          {p.canSaveInPlace && (
            <Button size="sm" variant="primary" onClick={() => p.onSave()} disabled={p.saving}>
              Save view
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={p.onReset}>
            Reset
          </Button>
          {!p.canSaveInPlace && <span className="text-ink-3">Built-in views can't be changed. Use Views → Save current as new view.</span>}
          {p.saveError && <span className="text-danger">{p.saveError}</span>}
        </div>
      )}
    </div>
  );
}

function ViewRow({
  name,
  active,
  onPick,
  onDelete,
  favorite,
  onFavorite,
}: {
  name: string;
  active: boolean;
  onPick: () => void;
  onDelete?: () => void;
  favorite?: boolean;
  onFavorite?: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="group flex items-center rounded-md hover:bg-hover" onMouseLeave={() => setConfirming(false)}>
      <button type="button" onClick={onPick} className="flex h-8 min-w-0 flex-1 items-center gap-2 px-2 text-left text-[13px]">
        <span className="flex-1 truncate">{name}</span>
        {active && <Check size={14} className="text-accent" />}
      </button>
      {onFavorite && (
        <IconButton
          label={favorite ? `Remove ${name} from sidebar` : `Show ${name} in sidebar`}
          aria-pressed={favorite}
          className={cx("mr-0.5 h-6 w-6", favorite ? "text-[#e5a00d]" : "opacity-0 group-hover:opacity-100 focus:opacity-100")}
          onClick={onFavorite}
        >
          <Star size={13} fill={favorite ? "currentColor" : "none"} />
        </IconButton>
      )}
      {onDelete &&
        (confirming ? (
          <button type="button" onClick={onDelete} className="mr-1 h-6 rounded-md bg-danger px-1.5 text-[12px] font-medium text-white">
            Delete for everyone
          </button>
        ) : (
          <IconButton
            label={`Delete view ${name}`}
            className="mr-0.5 h-6 w-6 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-danger"
            onClick={() => setConfirming(true)}
          >
            <Trash2 size={12} />
          </IconButton>
        ))}
    </div>
  );
}

function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: [T, string][] }) {
  return (
    <div className="flex rounded-lg border border-line-strong bg-subtle p-0.5">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={cx("h-6 flex-1 rounded-md px-1.5 text-[12px] font-medium whitespace-nowrap", value === v ? "bg-canvas text-ink shadow-btn" : "text-ink-3 hover:text-ink-2")}
        >
          {label}
        </button>
      ))}
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

const COL_SORT: Record<string, SortKey | undefined> = { title: "title", status: "status", priority: "priority", due: "due", updated: "updated" };

/** Rows come in sorted when `sort` is given (the list page); otherwise they're sorted by status. */
export function TaskTable({ tasks, sort, onSort }: { tasks: Task[]; sort?: SortKey; onSort?: (s: SortKey) => void }) {
  const members = useMembers();
  const projects = useProjects();
  const patch = useTaskPatch();
  const rows = sort ? tasks : sortTasks(tasks, "status");
  const cell = "h-10 border-r border-b border-line text-[13px] whitespace-nowrap";
  const edit = (task: Task, body: Record<string, unknown>) => patch.mutate({ task, body });
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {patch.error && (
        <div className="sticky top-0 left-0 z-20 border-b border-danger-line bg-danger-soft px-4 py-2 text-[13px] text-danger">
          Couldn't save: {(patch.error as Error).message}
        </div>
      )}
      {/* Phones: compact cards (tap to open). */}
      <ul className="divide-y divide-line md:hidden">
        {rows.map((t) => {
          const health = taskHealth(t);
          return (
            <li key={t.id}>
              <Link
                to={`/t/${t.key}`}
                className={cx(
                  "block px-4 py-3 active:bg-hover",
                  health === "problem" && "bg-danger-soft shadow-[inset_3px_0_0_var(--c-danger)]",
                  health === "waiting" && "shadow-[inset_3px_0_0_var(--c-warn)]",
                )}
              >
                <div className="flex items-start gap-2">
                  <StatusIcon status={t.status} />
                  <span className="min-w-0 flex-1 text-[15px] leading-snug font-medium">{t.title}</span>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 pl-6 text-[12px] text-ink-3">
                  <span className="tabular-nums">{t.key}</span>
                  {t.assignee && <MemberChip member={t.assignee} size={14} muted />}
                  {t.priority !== "none" && (
                    <span className="flex items-center gap-1">
                      <PriorityIcon priority={t.priority} /> {PRIORITY_LABEL[t.priority]}
                    </span>
                  )}
                  {t.due_date && <span className={cx(isOverdue(t) && "font-medium text-danger")}>Due {formatDate(t.due_date)}</span>}
                  {t.project && <span className="truncate">{t.project.name}</span>}
                  <RunBadge task={t} compact />
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
      <table className="hidden w-full min-w-[1100px] border-separate border-spacing-0 md:table">
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
                {onSort && COL_SORT[c.key] ? (
                  <button
                    type="button"
                    onClick={() => onSort(COL_SORT[c.key]!)}
                    className={cx("flex items-center gap-1.5 hover:text-ink", sort === COL_SORT[c.key] && "text-ink")}
                    title={`Sort by ${c.label.toLowerCase()}`}
                  >
                    {c.icon}
                    {c.label}
                    {sort === COL_SORT[c.key] && <ArrowUpDown size={11} />}
                  </button>
                ) : (
                  <span className="flex items-center gap-1.5">
                    {c.icon}
                    {c.label}
                  </span>
                )}
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
  if (isClosed(task) && !problem) return null;
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
      {task.open_blockers > 0 && (
        <Tag tone="gray" className="shrink-0" title={`Waiting on ${task.open_blockers} other task${task.open_blockers > 1 ? "s" : ""}`}>
          <Link2 size={12} />
          {compact ? "Blocked" : `Blocked by ${task.open_blockers}`}
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
        {(task.project || task.priority !== "none" || task.run_status || task.open_questions > 0 || task.open_blockers > 0) && (
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
