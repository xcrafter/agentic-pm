export type MemberKind = "human" | "agent";
export interface Member {
  id: string;
  kind: MemberKind;
  name: string;
  handle: string;
  avatar_url: string | null;
  role: "admin" | "member";
  active: boolean;
  email: string | null;
  description: string | null;
  has_webhook: boolean;
  webhook_url: string | null;
  wake_on_mention: boolean;
  max_runs_per_hour: number;
  created_by: string | null;
  created_at: string;
  sidebar_profile_id?: string | null;
}
export type MemberRef = Pick<Member, "id" | "name" | "handle" | "kind" | "avatar_url">;

export const STATUSES = ["backlog", "todo", "in_progress", "waiting_on_human", "done", "canceled"] as const;
export type Status = (typeof STATUSES)[number];
/** A workspace task status. Built-in ones have key === category; custom ones behave like their category. */
export interface StatusDef {
  key: string;
  name: string;
  color: string;
  category: Status;
  builtin: boolean;
  position: number;
  task_count?: number;
}
export const DEFAULT_STATUSES: StatusDef[] = [
  { key: "backlog", name: "Backlog", color: "#a3a5ab", category: "backlog", builtin: true, position: 1000 },
  { key: "todo", name: "Todo", color: "#7c7e85", category: "todo", builtin: true, position: 2000 },
  { key: "in_progress", name: "In Progress", color: "#2b6feb", category: "in_progress", builtin: true, position: 3000 },
  { key: "waiting_on_human", name: "Waiting on human", color: "#e5791d", category: "waiting_on_human", builtin: true, position: 4000 },
  { key: "done", name: "Done", color: "#1f9d5c", category: "done", builtin: true, position: 5000 },
  { key: "canceled", name: "Canceled", color: "#a3a5ab", category: "canceled", builtin: true, position: 6000 },
];
export interface LabelRef {
  id: string;
  name: string;
  color: string;
}
export interface Label extends LabelRef {
  created_by: string | null;
  created_at: string;
  task_count: number;
}
export const LABEL_COLORS = ["#6b7280", "#2b6feb", "#1f9d5c", "#e5791d", "#d64545", "#8b5cf6", "#d9468f", "#0e9488", "#b7791f"];

export const PRIORITIES = ["none", "urgent", "high", "medium", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_LABEL: Record<Priority, string> = {
  none: "No priority",
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export interface Task {
  id: string;
  key: string;
  number: number;
  title: string;
  description: string;
  /** Built-in status (for a custom status, the one it behaves like). */
  status: Status;
  /** The status the task shows: a built-in key or a custom status key. */
  status_key: string;
  status_name: string;
  labels: LabelRef[];
  priority: Priority;
  due_date: string | null;
  position: number;
  assignee: MemberRef | null;
  project: { id: string; name: string } | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  /** Set when the task was archived along with its project. */
  archived_at: string | null;
  open_questions: number;
  run_status: string | null;
  open_blockers: number;
}

export interface Entry {
  id: string;
  task_id: string;
  author_id: string;
  type: "comment" | "update" | "question" | "answer" | "note_created" | "checklist_created" | "attachment_added" | "system";
  body: string;
  data: Record<string, any>;
  reply_to_id: string | null;
  created_at: string;
  edited_at: string | null;
  reactions: { emoji: string; count: number; by: string[] }[];
}
export interface DepTask {
  id: string;
  key: string;
  title: string;
  status: Status;
  status_key: string;
  assignee: { id: string; name: string } | null;
}
export interface Note {
  id: string;
  title: string;
  content: string;
  created_by: string;
  updated_by: string;
  updated_at: string;
}
export interface ChecklistItem {
  id: string;
  checklist_id: string;
  text: string;
  done: number;
  done_by: string | null;
}
export interface Checklist {
  id: string;
  title: string;
  created_by: string;
  items: ChecklistItem[];
}
export interface Attachment {
  id: string;
  filename: string;
  content_type: string;
  size: number;
  uploaded_by: string;
  created_at: string;
}
export interface Run {
  id: string;
  agent_id: string;
  trigger: string;
  status: "queued" | "dispatched" | "active" | "ended" | "failed" | "stale";
  attempts: number;
  last_error: string | null;
  created_at: string;
  dispatched_at: string | null;
  last_activity_at: string | null;
  ended_at: string | null;
  dismissed: number;
}
export interface TaskDetail {
  task: Task;
  entries: Entry[];
  notes: Note[];
  checklists: Checklist[];
  attachments: Attachment[];
  runs: Run[];
  dependencies: { blocked_by: DepTask[]; blocking: DepTask[]; open_blockers: number };
}
export interface Project {
  id: string;
  name: string;
  description: string;
  lead_member_id: string | null;
  status: "active" | "archived";
  created_by: string;
  task_count: number;
  done_count: number;
  open_count: number;
}
export interface WorkspaceInfo {
  id: string;
  name: string;
  key_prefix: string;
  website: string | null;
  logo_url: string | null;
  allowed_domains: string[];
  allowed_domains_source: "workspace" | "default";
  pm_agent_id: string | null;
  pm_triage: boolean;
  link_previews: "off" | "title" | "full";
}
export interface Me {
  member: Member | null;
  workspace: WorkspaceInfo | null;
  brand: { name: string; logo_url: string | null };
  auth: { google: boolean; setup: boolean };
}
export type SidebarItemKey =
  | "inbox" | "feed" | "my" | "ideas" | "customers" | "policies" | "all"
  | "workspace" | "team" | "reports" | "projects" | "tools" | "settings"
  | "favorite_views" | "project_list";
export interface SidebarItem {
  key: SidebarItemKey;
  label: string;
  group: "main" | "team" | "sections";
}
export interface SidebarInfo {
  hidden: SidebarItemKey[];
  profile: { id: string; name: string; hidden: SidebarItemKey[]; source: "assigned" | "default" } | null;
  personal: { hidden: SidebarItemKey[]; shown: SidebarItemKey[] };
  items: SidebarItem[];
}
export interface SidebarProfile {
  id: string;
  name: string;
  hidden: SidebarItemKey[];
  member_ids: string[];
  is_default: boolean;
  created_at: string;
  updated_at: string;
}
export interface Inbox {
  questions: (Entry & { task_key: string; task_title: string })[];
  runs: (Run & { task_key: string; task_title: string; agent_name: string; task_id: string })[];
  mentions: (Entry & { task_key: string; task_title: string })[];
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin", headers: {} };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  const res = await fetch(path, init);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText);
  return data as T;
}

export const api = {
  get: <T>(p: string) => request<T>("GET", p),
  post: <T>(p: string, b?: unknown) => request<T>("POST", p, b ?? {}),
  patch: <T>(p: string, b: unknown) => request<T>("PATCH", p, b),
  put: <T>(p: string, b?: unknown) => request<T>("PUT", p, b ?? {}),
  del: <T>(p: string) => request<T>("DELETE", p),
  upload: <T>(p: string, files: File[]) => {
    const fd = new FormData();
    files.forEach((f) => fd.append("file", f));
    return request<T>("POST", p, fd);
  },
};

export interface FeedEntry {
  id: string;
  task_id: string;
  task_key: string;
  task_title: string;
  author_id: string;
  type: Entry["type"];
  body: string;
  data: Record<string, any>;
  created_at: string;
}
export interface Overview {
  workspace: { id: string; name: string; key_prefix: string; created_at: string };
  by_status: Partial<Record<Status, number>>;
  by_member: { member_id: string; open: number; waiting: number; done_7d: number }[];
  done_7d: number;
  open_questions: number;
  active_runs: { id: string; agent_id: string; status: Run["status"]; trigger: string; created_at: string; last_activity_at: string | null; task_key: string; task_title: string }[];
  recent: FeedEntry[];
}
export interface MemberRecord {
  member: Member;
  created_by: MemberRef | null;
  sub_agents: Member[];
  can_manage: boolean;
  stats: { open: number; waiting: number; done: number; done_7d: number; created: number };
  recent: FeedEntry[];
  runs: (Pick<Run, "id" | "status" | "trigger" | "attempts" | "last_error" | "created_at" | "dispatched_at" | "last_activity_at" | "ended_at"> & {
    task_key: string;
    task_title: string;
  })[];
}

export type PostKind = "update" | "done" | "blocker";
export interface Post {
  id: string;
  author_id: string;
  kind: PostKind;
  body: string;
  link_url: string | null;
  routine: string | null;
  auto: boolean;
  created_at: string;
  task: { id: string; key: string; title: string | null; status: string | null } | null;
  reactions: { emoji: string; count: number; mine: boolean; by: string[] }[];
}
export interface ReportPerson {
  id: string;
  name: string;
  handle: string;
  kind: MemberKind;
  avatar_url: string | null;
  tasks_done: number;
  avg_hours_to_done: number | null;
  open_tasks: number;
  overdue: number;
  updates: number;
  blockers: number;
  useful: number;
  questions: number;
  runs: number;
  failed_runs: number;
  last_active: string | null;
}
export interface Report {
  days: number;
  since: string;
  people: ReportPerson[];
  routines: { routine: string; author_id: string; posts: number; last_at: string; days: string[] }[];
}

export type IdeaStatus = "new" | "exploring" | "planned" | "converted" | "parked";
export interface Idea {
  id: string;
  title: string;
  body: string;
  labels: string[];
  labels_by: "pending" | "ai" | "human" | "agent" | "fallback";
  suggested_owner_id: string | null;
  owner_reason: string | null;
  status: IdeaStatus;
  stage: IdeaStage;
  live_at: string | null;
  pinned_at: string | null;
  pinned_by: string | null;
  source_url: string | null;
  created_by: string;
  task: { id: string; key: string; status: string | null } | null;
  created_at: string;
  updated_at: string;
  request_count: number;
  request_times: number;
  open_request_count: number;
  request_mrr: number;
  requested_by: { id: string; name: string }[];
  last_requested_at: string | null;
  requests?: IdeaRequest[];
}
export interface IdeaRequest {
  id: string;
  idea_id: string;
  customer_id: string;
  customer_name: string;
  plan: string | null;
  mrr: number | null;
  note: string;
  requested_at: string;
  added_by: string;
  times: number;
  status: RequestStatus;
  pinned_at: string | null;
}
export type IdeaStage = "backlog" | "live" | "archived";
export type RequestStatus = "open" | "live" | "archived";
/** A request as listed on the Requests tab (with its customer and feature). */
export interface RequestListItem extends IdeaRequest {
  idea_title: string;
  idea_stage: IdeaStage;
  idea_status: IdeaStatus;
  created_at: string;
}
export interface Customer {
  id: string;
  name: string;
  domain: string | null;
  email: string | null;
  plan: string | null;
  mrr: number | null;
  notes: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  requests?: number | CustomerRequest[];
  last_request?: string | null;
}
export interface CustomerRequest {
  id: string;
  idea_id: string;
  customer_id: string;
  note: string;
  requested_at: string;
  added_by: string;
  times: number;
  status: RequestStatus;
  pinned_at: string | null;
  idea_title: string;
  idea_status: IdeaStatus;
  idea_stage: IdeaStage;
  idea_labels: string[];
}

export interface ToolEntry {
  id: string;
  url: string;
  domain: string;
  name: string;
  summary: string;
  notes: string;
  tags: string[];
  category: string | null;
  pricing: string | null;
  icon_url: string | null;
  enriched_by: "pending" | "ai" | "agent" | "human" | "failed";
  pinned_at: string | null;
  research_task: { key: string; status: string | null } | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface EmailPrefs {
  enabled: boolean;
  kinds: { key: string; label: string }[];
  off: string[];
  email: string | null;
}
export interface EmailLog {
  enabled: boolean;
  from: string | null;
  binding: boolean;
  items: { id: string; to_email: string; kind: string; subject: string; status: "sent" | "failed" | "skipped"; error: string | null; created_at: string }[];
}
