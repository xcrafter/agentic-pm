/**
 * Task list views: a view is a set of filters + a sort + a layout. Built-in views ship with the app;
 * saved views are stored in the workspace and shared with everyone.
 */
import { type Priority, type Status, type Task, PRIORITIES, STATUSES } from "./api";

export type SortKey = "status" | "priority" | "due" | "updated" | "created" | "title";
export type DueFilter = "any" | "overdue" | "week" | "none";
export type Layout = "table" | "board";

export interface ViewConfig {
  layout: Layout;
  hideDone: boolean;
  status: Status[];
  /** member ids, plus "none" (unassigned) and "me" */
  assignees: string[];
  kind: "all" | "human" | "agent";
  /** project ids, plus "none" */
  projects: string[];
  priorities: Priority[];
  due: DueFilter;
  attention: boolean;
  q: string;
  sort: SortKey;
}

export const DEFAULT_CONFIG: ViewConfig = {
  layout: "table",
  hideDone: true,
  status: [],
  assignees: [],
  kind: "all",
  projects: [],
  priorities: [],
  due: "any",
  attention: false,
  q: "",
  sort: "status",
};

export function normalizeConfig(raw: unknown): ViewConfig {
  const c = (raw && typeof raw === "object" ? raw : {}) as Partial<ViewConfig>;
  const arr = <T>(v: unknown, allowed?: readonly T[]) =>
    Array.isArray(v) ? (v.filter((x) => typeof x === "string" && (!allowed || allowed.includes(x as T))) as T[]) : [];
  return {
    layout: c.layout === "board" ? "board" : "table",
    hideDone: typeof c.hideDone === "boolean" ? c.hideDone : DEFAULT_CONFIG.hideDone,
    status: arr<Status>(c.status, STATUSES),
    assignees: arr<string>(c.assignees),
    kind: c.kind === "human" || c.kind === "agent" ? c.kind : "all",
    projects: arr<string>(c.projects),
    priorities: arr<Priority>(c.priorities, PRIORITIES),
    due: c.due === "overdue" || c.due === "week" || c.due === "none" ? c.due : "any",
    attention: !!c.attention,
    q: typeof c.q === "string" ? c.q : "",
    sort: (["status", "priority", "due", "updated", "created", "title"] as SortKey[]).includes(c.sort as SortKey) ? (c.sort as SortKey) : "status",
  };
}

export const sameConfig = (a: ViewConfig, b: ViewConfig) => JSON.stringify(normalizeConfig(a)) === JSON.stringify(normalizeConfig(b));

/** Number of filters narrowing the list (not counting layout, sort or hide-completed). */
export function activeFilterCount(c: ViewConfig) {
  return (
    (c.status.length ? 1 : 0) +
    (c.assignees.length ? 1 : 0) +
    (c.kind !== "all" ? 1 : 0) +
    (c.projects.length ? 1 : 0) +
    (c.priorities.length ? 1 : 0) +
    (c.due !== "any" ? 1 : 0) +
    (c.attention ? 1 : 0) +
    (c.q.trim() ? 1 : 0)
  );
}

export const isClosed = (t: Pick<Task, "status">) => t.status === "done" || t.status === "canceled";
const today = () => new Date().toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);

export function needsAttention(t: Task) {
  return t.run_status === "failed" || t.run_status === "stale" || t.open_questions > 0;
}

export function applyFilters(tasks: Task[], c: ViewConfig, meId: string | undefined) {
  const q = c.q.trim().toLowerCase();
  // An explicit status filter wins over "hide completed".
  const hideDone = c.hideDone && !c.status.some((s) => s === "done" || s === "canceled");
  return tasks.filter((t) => {
    if (hideDone && isClosed(t)) return false;
    if (c.status.length && !c.status.includes(t.status)) return false;
    if (c.assignees.length) {
      const id = t.assignee?.id ?? "none";
      const ok = c.assignees.some((a) => a === id || (a === "me" && id === meId));
      if (!ok) return false;
    }
    if (c.kind !== "all" && t.assignee?.kind !== c.kind) return false;
    if (c.projects.length && !c.projects.includes(t.project?.id ?? "none")) return false;
    if (c.priorities.length && !c.priorities.includes(t.priority)) return false;
    if (c.due === "none" && t.due_date) return false;
    if (c.due === "overdue" && !(t.due_date && t.due_date < today() && !isClosed(t))) return false;
    if (c.due === "week" && !(t.due_date && t.due_date <= inDays(7) && !isClosed(t))) return false;
    if (c.attention && !needsAttention(t)) return false;
    if (q && !t.title.toLowerCase().includes(q) && !t.key.toLowerCase().includes(q) && !(t.assignee?.name.toLowerCase().includes(q) ?? false)) return false;
    return true;
  });
}

const STATUS_ORDER = new Map(STATUSES.map((s, i) => [s, i]));
const PRIORITY_ORDER: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

export function sortTasks(tasks: Task[], sort: SortKey) {
  const byCreated = (a: Task, b: Task) => b.created_at.localeCompare(a.created_at);
  const cmp: Record<SortKey, (a: Task, b: Task) => number> = {
    status: (a, b) => STATUS_ORDER.get(a.status)! - STATUS_ORDER.get(b.status)! || PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || byCreated(a, b),
    priority: (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || STATUS_ORDER.get(a.status)! - STATUS_ORDER.get(b.status)! || byCreated(a, b),
    due: (a, b) => (a.due_date ?? "9999") .localeCompare(b.due_date ?? "9999") || PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority],
    updated: (a, b) => b.updated_at.localeCompare(a.updated_at),
    created: byCreated,
    title: (a, b) => a.title.localeCompare(b.title),
  };
  return [...tasks].sort(cmp[sort]);
}

export const SORT_LABEL: Record<SortKey, string> = {
  status: "Status",
  priority: "Priority",
  due: "Due date",
  updated: "Last updated",
  created: "Newest",
  title: "Title",
};

/** Views that ship with the app. Their ids are "preset:<key>". */
export const PRESETS: { id: string; name: string; config: ViewConfig }[] = [
  { id: "preset:active", name: "Active tasks", config: { ...DEFAULT_CONFIG } },
  { id: "preset:attention", name: "Needs attention", config: { ...DEFAULT_CONFIG, attention: true } },
  { id: "preset:agents", name: "Agents' work", config: { ...DEFAULT_CONFIG, kind: "agent" } },
  { id: "preset:mine", name: "Assigned to me", config: { ...DEFAULT_CONFIG, assignees: ["me"] } },
  { id: "preset:everything", name: "Everything", config: { ...DEFAULT_CONFIG, hideDone: false } },
  { id: "preset:completed", name: "Completed", config: { ...DEFAULT_CONFIG, hideDone: false, status: ["done", "canceled"], sort: "updated" } },
];

export interface SavedView {
  id: string;
  name: string;
  config: ViewConfig;
  created_by: string;
  created_at: string;
  updated_at: string;
  /** Pinned to my sidebar. */
  favorite?: boolean;
}
