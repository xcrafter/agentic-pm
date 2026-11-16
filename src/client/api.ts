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
}
export type MemberRef = Pick<Member, "id" | "name" | "handle" | "kind" | "avatar_url">;

export const STATUSES = ["backlog", "todo", "in_progress", "waiting_on_human", "done", "canceled"] as const;
export type Status = (typeof STATUSES)[number];
export const STATUS_LABEL: Record<Status, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In Progress",
  waiting_on_human: "Waiting on human",
  done: "Done",
  canceled: "Canceled",
};
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
  status: Status;
  priority: Priority;
  due_date: string | null;
  position: number;
  assignee: MemberRef | null;
  project: { id: string; name: string } | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  open_questions: number;
  run_status: string | null;
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
}
export interface Project {
  id: string;
  name: string;
  description: string;
  lead_member_id: string | null;
  status: "active" | "archived";
  task_count: number;
  done_count: number;
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
}
export interface Me {
  member: Member | null;
  workspace: WorkspaceInfo | null;
  brand: { name: string; logo_url: string | null };
  auth: { google: boolean; setup: boolean };
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
