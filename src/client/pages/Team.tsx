import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AtSign,
  Bot,
  CalendarDays,
  Copy,
  Gauge,
  KeyRound,
  ListTodo,
  Mail,
  Plug,
  Plus,
  Shield,
  UserPlus,
  UserRound,
  Users,
  Webhook,
  Zap,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { type Member, type MemberRecord, type SidebarProfile, type Task, api } from "../api";
import {
  AgentBadge,
  AttrRow,
  Avatar,
  Button,
  EmptyState,
  Field,
  MemberChip,
  Modal,
  ModalFooter,
  SectionTitle,
  Tabs,
  Tag,
  TopBar,
  cx,
  inputClass,
  textareaClass,
  timeAgo,
  useMe,
  useMembers,
  wakeRoute,
} from "../components";
import { TaskTable } from "./Board";
import { FeedList } from "./Feed";

interface Connection {
  id: string;
  client_name: string;
  scope: string[];
  created_at: string | null;
  connected_by: string | null;
}

// ---------- Team list ----------

export function TeamPage() {
  const me = useMe().data!.member!;
  const members = useMembers();
  const nav = useNavigate();
  const [adding, setAdding] = useState(false);
  const [inviting, setInviting] = useState(false);
  const isAdmin = me.role === "admin";
  const byId = new Map((members.data ?? []).map((x) => [x.id, x]));
  const pmId = useMe().data?.workspace?.pm_agent_id;
  const rows = [...(members.data ?? [])].sort((a, b) => Number(b.active) - Number(a.active) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  const cell = "h-11 border-r border-b border-line px-3 text-[13px] whitespace-nowrap";
  const head = (icon: ReactNode, label: string, w = "") => (
    <th className={cx("h-9 border-r border-b border-line px-3 text-left text-[12px] font-medium text-ink-3", w)}>
      <span className="flex items-center gap-1.5">
        {icon}
        {label}
      </span>
    </th>
  );

  return (
    <div className="flex h-full flex-col">
      <TopBar
        crumbs={[{ label: "Members & agents", icon: <Users size={15} className="text-ink-3" /> }]}
        actions={
          isAdmin && (
            <>
              <Button onClick={() => setInviting(true)}>
                <UserPlus size={14} /> Invite person
              </Button>
              <Button variant="primary" onClick={() => setAdding(true)}>
                <Plus size={15} /> Add agent
              </Button>
            </>
          )
        }
      />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] border-separate border-spacing-0">
            <thead className="sticky top-0 z-10 bg-canvas">
              <tr>
                {head(<UserRound size={13} />, "Name", "w-[30%]")}
                {head(<Shield size={13} />, "Type", "w-[170px]")}
                {head(<AtSign size={13} />, "Handle", "w-[160px]")}
                {head(<Mail size={13} />, "Email or wake-up", "w-[240px]")}
                {head(<CalendarDays size={13} />, "Joined", "w-[110px]")}
                <th className="border-b border-line" />
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id} onClick={() => nav(`/team/${m.handle}`)} className={cx("group cursor-pointer", !m.active && "opacity-50")}>
                  <td className={cx(cell, "group-hover:bg-hover")}>
                    <span className="flex items-center gap-2 font-medium">
                      <MemberChip member={m} size={22} />
                      {m.id === me.id && <span className="text-[12px] font-normal text-ink-3">You</span>}
                      {!m.active && <Tag>Deactivated</Tag>}
                    </span>
                  </td>
                  <td className={cx(cell, "group-hover:bg-hover")}>
                    {m.kind === "agent" ? (
                      <span className="flex items-center gap-1.5">
                        <AgentBadge />
                        {m.id === pmId && <Tag tone="violet">PM</Tag>}
                        {m.created_by && byId.get(m.created_by)?.kind === "agent" && (
                          <span className="truncate text-[12px] text-ink-3">via @{byId.get(m.created_by)!.handle}</span>
                        )}
                      </span>
                    ) : (
                      <Tag tone={m.role === "admin" ? "blue" : "gray"}>{m.role === "admin" ? "Admin" : "Member"}</Tag>
                    )}
                  </td>
                  <td className={cx(cell, "text-ink-2 group-hover:bg-hover")}>@{m.handle}</td>
                  <td className={cx(cell, "max-w-[240px] truncate group-hover:bg-hover")}>
                    {m.kind === "human" ? (
                      <span className="text-ink-2">{m.email}</span>
                    ) : (
                      <WakeTag agent={m} />
                    )}
                  </td>
                  <td className={cx(cell, "text-ink-3 group-hover:bg-hover")}>{timeAgo(m.created_at)}</td>
                  <td className="border-b border-line group-hover:bg-hover" />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mx-auto max-w-4xl space-y-8 px-4 py-8 md:px-6">
          {isAdmin && <PendingInvites />}
          <ConnectHelp />
        </div>
      </div>
      {adding && <AgentModal agent={null} onClose={() => setAdding(false)} />}
      {inviting && <InviteModal onClose={() => setInviting(false)} />}
    </div>
  );
}

function ConnectHelp() {
  const url = `${location.origin}/mcp`;
  return (
    <section className="rounded-xl border border-line bg-panel p-5">
      <div className="flex items-center gap-2 text-[14px] font-semibold">
        <Plug size={16} className="text-agent" /> Connect an agent (Grok Bot, Claude, …)
      </div>
      <ol className="mt-3 list-decimal space-y-2 pl-5 text-[13px] text-ink-2">
        <li>
          In the assistant, add a custom MCP server with this URL and sign in. Choose <strong className="text-ink">A new agent</strong> to create its
          profile, or pick an existing agent.
          <div className="mt-2">
            <CopyField value={url} />
          </div>
        </li>
        <li>
          Give the agent its wake-up webhook (Grok Bot: Routine → Trigger → Webhook). Paste the URL and key on the agent's page, or ask the agent to
          set them with its <code className="rounded bg-active px-1 text-[12px]">update_my_profile</code> tool.
        </li>
        <li>Send a test ping from the agent's page. From then on, assigning a task wakes the agent.</li>
      </ol>
    </section>
  );
}

function CopyField({ value, hint }: { value: string; hint?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      {hint && <div className="mb-1.5 text-[12px] text-ink-3">{hint}</div>}
      <div className="flex h-8 items-center gap-2 rounded-lg border border-line-strong bg-canvas pr-1 pl-2.5 shadow-btn">
        <code className="min-w-0 flex-1 truncate text-[12px]">{value}</code>
        <Button
          size="sm"
          variant="ghost"
          className="h-6"
          onClick={() => {
            navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          <Copy size={12} /> {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}

interface PendingInvite {
  id: string;
  email: string;
  name: string | null;
  role: string;
  created_at: string;
  expires_at: string;
}

function PendingInvites() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["invites"], queryFn: () => api.get<PendingInvite[]>("/api/invites") });
  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/api/invites/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["invites"] }),
  });
  if (!q.data?.length) return null;
  return (
    <section>
      <SectionTitle>Pending invites</SectionTitle>
      <ul className="divide-y divide-line overflow-hidden rounded-[10px] border border-line">
        {q.data.map((i) => (
          <li key={i.id} className="flex h-11 items-center gap-3 px-3.5 text-[13px]">
            <Mail size={14} className="text-ink-3" />
            <span className="font-medium">{i.email}</span>
            <Tag>{i.role === "admin" ? "Admin" : "Member"}</Tag>
            <span className="text-[12px] text-ink-3">Invited {timeAgo(i.created_at)}</span>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => revoke.mutate(i.id)}>
              Revoke
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function InviteModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const create = useMutation({
    mutationFn: () => api.post<{ url: string; emailed?: boolean }>("/api/invites", { email, name, role }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["invites"] }),
  });
  return (
    <Modal open onClose={onClose} title="Invite a person">
      {create.data ? (
        <>
          <div className="p-4">
            <CopyField
              value={create.data.url}
              hint={
                create.data.emailed
                  ? `We've emailed this link to ${email}. You can also send it yourself. They choose their own password. It works once and expires in 7 days.`
                  : `Send this link to ${email}. They choose their own password. It works once and expires in 7 days.`
              }
            />
          </div>
          <ModalFooter>
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </ModalFooter>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <div className="space-y-4 p-4">
            <Field label="Work email">
              <input className={inputClass} type="email" placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            </Field>
            <Field label="Name" hint="Optional. They can change it when they join.">
              <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Role">
              <select className={inputClass} value={role} onChange={(e) => setRole(e.target.value as "member" | "admin")}>
                <option value="member">Member</option>
                <option value="admin">Admin: can invite people and manage agents</option>
              </select>
            </Field>
            {create.error && <p className="text-[13px] text-[#c4312b]">{(create.error as Error).message}</p>}
          </div>
          <ModalFooter hint="You'll get a sign-up link to send them.">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={create.isPending}>
              Create invite link
            </Button>
          </ModalFooter>
        </form>
      )}
    </Modal>
  );
}

// ---------- Member record ----------

type MemberTab = "tasks" | "activity" | "runs";

export function MemberPage() {
  const { handle } = useParams();
  const me = useMe().data!.member!;
  const members = useMembers();
  const byId = new Map((members.data ?? []).map((m) => [m.id, m]));
  const q = useQuery({ queryKey: ["member-record", handle], queryFn: () => api.get<MemberRecord>(`/api/members/${handle}/record`) });
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as MemberTab) || "tasks";
  const m = q.data?.member;
  const tasks = useQuery({
    queryKey: ["tasks", `assignee=${m?.id}`],
    queryFn: () => api.get<Task[]>(`/api/tasks?assignee=${m!.id}`),
    enabled: !!m,
  });
  const [configuring, setConfiguring] = useState(false);

  if (q.isLoading) return <div className="p-8 text-[13px] text-ink-3">Loading…</div>;
  if (!q.data || !m) return <div className="p-8 text-[13px] text-[#c4312b]">{(q.error as Error)?.message ?? "Member not found"}</div>;
  const { stats } = q.data;
  const isAgent = m.kind === "agent";
  const canManage = q.data.can_manage || me.role === "admin" || m.id === me.id;
  const parent = isAgent && q.data.created_by?.kind === "agent" ? q.data.created_by : null;
  const subAgents = q.data.sub_agents ?? [];
  const stat = (label: string, value: number, tone?: string) => (
    <div className="min-w-[120px] flex-1 border-r border-line px-4 py-3 last:border-r-0">
      <div className="text-[12px] text-ink-3">{label}</div>
      <div className={cx("mt-0.5 text-[20px] font-semibold tracking-[-0.01em] tabular-nums", tone)}>{value}</div>
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      <TopBar
        crumbs={[
          { label: "Members & agents", to: "/team", icon: <Users size={15} className="text-ink-3" /> },
          { label: m.name, icon: <Avatar member={m} size={16} /> },
        ]}
        actions={
          canManage &&
          (isAgent || me.role === "admin") && (
            <Button onClick={() => setConfiguring(true)}>{isAgent ? "Configure agent" : "Manage"}</Button>
          )
        }
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-auto lg:flex-row lg:overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col lg:overflow-auto">
          <div className="px-4 pt-6 md:px-6">
            <div className="flex items-center gap-3.5">
              <Avatar member={m} size={44} />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="truncate text-[22px] font-semibold tracking-[-0.015em]">{m.name}</h1>
                  {isAgent && <AgentBadge />}
                  {!m.active && <Tag>Deactivated</Tag>}
                </div>
                <div className="text-[13px] text-ink-3">
                  @{m.handle}
                  {m.description ? ` · ${m.description}` : ""}
                </div>
              </div>
            </div>
            <div className="mt-5 flex flex-wrap overflow-hidden rounded-[10px] border border-line">
              {stat("Open tasks", stats.open)}
              {stat("Waiting on a person", stats.waiting, stats.waiting ? "text-[#e5791d]" : undefined)}
              {stat("Done in last 7 days", stats.done_7d, stats.done_7d ? "text-[#1f9d5c]" : undefined)}
              {stat("Tasks created", stats.created)}
            </div>
          </div>
          <Tabs
            className="mt-5"
            value={tab}
            onChange={(t) => setParams(t === "tasks" ? {} : { tab: t }, { replace: true })}
            tabs={[
              { value: "tasks" as MemberTab, label: "Assigned tasks", icon: <ListTodo size={14} />, count: tasks.data?.length },
              { value: "activity" as MemberTab, label: "Activity", icon: <Activity size={14} />, count: q.data.recent.length },
              ...(isAgent ? [{ value: "runs" as MemberTab, label: "Runs", icon: <Zap size={14} />, count: q.data.runs.length }] : []),
            ]}
          />
          {tab === "tasks" &&
            (tasks.data?.length ? (
              <TaskTable tasks={tasks.data} />
            ) : (
              <EmptyState icon={<ListTodo size={18} />} title={`Nothing assigned to ${m.name}`}>
                {isAgent ? "Assign a task to this agent and it is woken to start working." : "Tasks assigned to them appear here."}
              </EmptyState>
            ))}
          {tab === "activity" && (
            <div className="px-4 py-6 md:px-6">
              <FeedList entries={q.data.recent} byId={byId} showAuthor={false} />
            </div>
          )}
          {tab === "runs" && <RunsTable runs={q.data.runs} />}
        </div>

        <aside className="shrink-0 border-t border-line lg:w-[340px] lg:overflow-auto lg:border-t-0 lg:border-l">
          <div className="px-4 py-4">
            <SectionTitle>Details</SectionTitle>
            <AttrRow icon={<Shield size={14} />} label="Type">
              <span className="px-1.5">{isAgent ? <AgentBadge /> : <Tag tone={m.role === "admin" ? "blue" : "gray"}>{m.role === "admin" ? "Admin" : "Member"}</Tag>}</span>
            </AttrRow>
            <AttrRow icon={<AtSign size={14} />} label="Handle">
              <span className="px-1.5">@{m.handle}</span>
            </AttrRow>
            {!isAgent && (
              <AttrRow icon={<Mail size={14} />} label="Email">
                <span className="block truncate px-1.5">{m.email}</span>
              </AttrRow>
            )}
            {isAgent && (
              <>
                <AttrRow icon={<Webhook size={14} />} label="Wake-up">
                  <span className="px-1.5">
                    <WakeTag agent={m} />
                  </span>
                </AttrRow>
                <AttrRow icon={<AtSign size={14} />} label="On mention">
                  <span className="px-1.5 text-ink-2">{m.wake_on_mention ? "Wakes up" : "Stays asleep"}</span>
                </AttrRow>
                <AttrRow icon={<Gauge size={14} />} label="Rate limit">
                  <span className="px-1.5 text-ink-2">{m.max_runs_per_hour} runs / hour</span>
                </AttrRow>
                <AttrRow icon={<UserRound size={14} />} label={parent ? "Managed by" : "Created by"}>
                  <span className="px-1.5">
                    {q.data.created_by ? (
                      <Link to={`/team/${q.data.created_by.handle}`} className="hover:underline">
                        <MemberChip member={q.data.created_by} />
                      </Link>
                    ) : (
                      <span className="text-ink-3">—</span>
                    )}
                  </span>
                </AttrRow>
                {parent && (
                  <p className="mt-2 rounded-lg bg-agent-soft px-2.5 py-2 text-[12px] leading-relaxed text-ink-2">
                    A sub-agent run by <b className="font-medium text-ink">{parent.name}</b>. {parent.name} can assign it tasks and act as it. It can't wake other agents.
                  </p>
                )}
              </>
            )}
            <AttrRow icon={<CalendarDays size={14} />} label="Joined">
              <span className="px-1.5 text-ink-2">{new Date(m.created_at).toLocaleDateString(undefined, { dateStyle: "medium" })}</span>
            </AttrRow>
          </div>
          {isAgent && !parent && (
            <div className="border-t border-line px-4 py-4">
              <SectionTitle>Sub-agents</SectionTitle>
              {subAgents.length ? (
                <ul className="-mx-1.5 space-y-0.5">
                  {subAgents.map((a) => (
                    <li key={a.id}>
                      <Link to={`/team/${a.handle}`} className={cx("flex items-center gap-2 rounded-md px-1.5 py-1.5 hover:bg-hover", !a.active && "opacity-50")}>
                        <Avatar member={a} size={20} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium">{a.name}</span>
                          {a.description && <span className="block truncate text-[12px] text-ink-3">{a.description}</span>}
                        </span>
                        {!a.has_webhook && <WakeTag agent={a} />}
                        {!a.active && <Tag>Off</Tag>}
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[12px] leading-relaxed text-ink-3">
                  None yet. When connected over MCP, {m.name} can add the other agents it runs with the <code className="text-ink-2">register_agent</code> tool. Each gets its own profile
                  and webhook, and {m.name} can assign them tasks.
                </p>
              )}
            </div>
          )}
          {canManage && (
            <div className="border-t border-line px-4 py-4">
              <SectionTitle>Connected assistants</SectionTitle>
              <Connections memberId={m.id} />
            </div>
          )}
          {me.role === "admin" && !isAgent && m.id !== me.id && <PersonAdmin member={m} />}
        </aside>
      </div>
      {configuring && isAgent && <AgentModal agent={m} onClose={() => (setConfiguring(false), q.refetch())} />}
      {configuring && !isAgent && (
        <Modal open onClose={() => setConfiguring(false)} title={`Manage ${m.name}`}>
          <div className="p-4">
            <PersonAdmin member={m} bare />
          </div>
        </Modal>
      )}
    </div>
  );
}

/** How this agent gets woken: own webhook (override), via the workspace PM, or not yet. */
export function WakeTag({ agent }: { agent: Member }) {
  const me = useMe().data;
  const members = useMembers().data;
  if (me?.workspace?.pm_agent_id === agent.id)
    return <Tag tone={agent.has_webhook ? "violet" : "amber"}>{agent.has_webhook ? "PM · workspace webhook" : "PM · no webhook yet"}</Tag>;
  const r = wakeRoute(agent, members, me);
  if (r.kind === "own") return <Tag tone="green">Own webhook</Tag>;
  if (r.kind === "pm") return <Tag tone="blue">Via PM @{r.pm!.handle}</Tag>;
  return <Tag tone="amber">No webhook yet</Tag>;
}

function RunsTable({ runs }: { runs: MemberRecord["runs"] }) {
  if (!runs.length)
    return (
      <EmptyState icon={<Zap size={18} />} title="No runs yet">
        A run starts each time this agent is woken: when it's assigned a task, gets an answer, or is @mentioned.
      </EmptyState>
    );
  const tone = { queued: "gray", dispatched: "violet", active: "violet", ended: "gray", failed: "red", stale: "red" } as const;
  const label = { queued: "Queued", dispatched: "Starting", active: "Working", ended: "Finished", failed: "Failed", stale: "Gone quiet" };
  const cell = "h-10 border-r border-b border-line px-3 text-[13px] whitespace-nowrap";
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] border-separate border-spacing-0">
        <thead>
          <tr className="text-left text-[12px] text-ink-3">
            {["Task", "Status", "Woken by", "Started", "Last activity"].map((h) => (
              <th key={h} className="h-9 border-r border-b border-line px-3 font-medium">
                {h}
              </th>
            ))}
            <th className="border-b border-line" />
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} className="hover:bg-hover">
              <td className={cell}>
                <Link to={`/t/${r.task_key}`} className="flex items-center gap-2">
                  <span className="text-[12px] text-ink-3 tabular-nums">{r.task_key}</span>
                  <span className="max-w-[320px] truncate font-medium">{r.task_title}</span>
                </Link>
              </td>
              <td className={cell}>
                <Tag tone={tone[r.status]}>{label[r.status]}</Tag>
              </td>
              <td className={cx(cell, "text-ink-2 capitalize")}>{r.trigger}</td>
              <td className={cx(cell, "text-ink-3")}>{timeAgo(r.created_at)}</td>
              <td className={cx(cell, "text-ink-3")}>{r.last_activity_at ? timeAgo(r.last_activity_at) : "—"}</td>
              <td className="border-b border-line" />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PersonAdmin({ member, bare }: { member: Member; bare?: boolean }) {
  const qc = useQueryClient();
  const [resetLink, setResetLink] = useState<string | null>(null);
  const [resetEmailed, setResetEmailed] = useState(false);
  const update = useMutation({
    mutationFn: (b: Record<string, unknown>) => api.patch(`/api/members/${member.id}`, b),
    onSuccess: () => qc.invalidateQueries(),
  });
  const reset = useMutation({
    mutationFn: () => api.post<{ url: string; emailed?: boolean }>(`/api/members/${member.id}/reset-link`),
    onSuccess: (r) => (setResetLink(r.url), setResetEmailed(!!r.emailed)),
  });
  return (
    <div className={cx(!bare && "border-t border-line px-4 py-4")}>
      {!bare && <SectionTitle>Admin</SectionTitle>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => update.mutate({ role: member.role === "admin" ? "member" : "admin" })}>
          <Shield size={13} /> {member.role === "admin" ? "Make member" : "Make admin"}
        </Button>
        {member.active && (
          <Button size="sm" onClick={() => reset.mutate()}>
            <KeyRound size={13} /> Reset password
          </Button>
        )}
        <Button size="sm" variant="danger" onClick={() => update.mutate({ active: !member.active })}>
          {member.active ? "Deactivate" : "Reactivate"}
        </Button>
      </div>
      <SidebarProfilePicker member={member} />
      {resetLink && (
        <div className="mt-3">
          <CopyField
            value={resetLink}
            hint={`${resetEmailed ? `We've emailed this to ${member.name}; you can also send it yourself.` : `Send this to ${member.name}.`} It works once, expires in 24 hours, and signs them out elsewhere.`}
          />
        </div>
      )}
    </div>
  );
}

function SidebarProfilePicker({ member }: { member: Member }) {
  const qc = useQueryClient();
  const profiles = useQuery({
    queryKey: ["sidebar-profiles"],
    queryFn: () => api.get<{ profiles: SidebarProfile[] }>("/api/sidebar-profiles"),
  });
  const update = useMutation({
    mutationFn: (id: string | null) => api.patch(`/api/members/${member.id}`, { sidebar_profile_id: id }),
    onSuccess: () => qc.invalidateQueries(),
  });
  const list = profiles.data?.profiles ?? [];
  if (!list.length) return null;
  const def = list.find((p) => p.is_default);
  return (
    <label className="mt-3 flex items-center gap-2 text-[13px]">
      <span className="text-ink-3">Sidebar profile</span>
      <select
        className={cx(inputClass, "h-8 w-auto py-0")}
        value={member.sidebar_profile_id ?? ""}
        disabled={update.isPending}
        onChange={(e) => update.mutate(e.target.value || null)}
      >
        <option value="">{def ? `Default (${def.name})` : "None (full sidebar)"}</option>
        {list.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function Connections({ memberId }: { memberId: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["connections", memberId], queryFn: () => api.get<Connection[]>(`/api/members/${memberId}/connections`) });
  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/api/members/${memberId}/connections/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["connections", memberId] }),
  });
  if (q.isLoading) return <p className="text-[12px] text-ink-3">Loading…</p>;
  if (!q.data?.length) return <p className="text-[12px] text-ink-3">No assistants are connected over MCP.</p>;
  return (
    <ul className="space-y-1">
      {q.data.map((c) => (
        <li key={c.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] hover:bg-hover">
          <Plug size={13} className="text-ink-3" />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{c.client_name}</span>
            <span className="block text-[12px] text-ink-3">
              {c.connected_by ? `Approved by ${c.connected_by}` : ""} {c.created_at ? timeAgo(c.created_at) : ""}
            </span>
          </span>
          <Button size="sm" variant="ghost" onClick={() => revoke.mutate(c.id)}>
            Revoke
          </Button>
        </li>
      ))}
    </ul>
  );
}

export function AgentModal({ agent, onClose }: { agent: Member | null; onClose: () => void }) {
  const qc = useQueryClient();
  const isAdmin = useMe().data?.member?.role === "admin";
  const [name, setName] = useState(agent?.name ?? "");
  const [handle, setHandle] = useState(agent?.handle ?? "");
  const [description, setDescription] = useState(agent?.description ?? "");
  const [avatar, setAvatar] = useState(agent?.avatar_url ?? "");
  const [webhookUrl, setWebhookUrl] = useState(agent?.webhook_url ?? "");
  const [webhookKey, setWebhookKey] = useState("");
  const [wakeOnMention, setWakeOnMention] = useState(agent?.wake_on_mention ?? true);
  const [maxRuns, setMaxRuns] = useState(agent?.max_runs_per_hour ?? 10);
  const [ping, setPing] = useState<{ ok: boolean; status: number; body: string } | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        name,
        description,
        avatar_url: avatar || null,
        webhook_url: webhookUrl || null,
        wake_on_mention: wakeOnMention,
        max_runs_per_hour: maxRuns,
      };
      if (webhookKey) body.webhook_key = webhookKey;
      if (agent) return api.patch<Member>(`/api/members/${agent.id}`, body);
      return api.post<Member>("/api/members/agents", { ...body, handle: handle || undefined });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["members"] });
      qc.invalidateQueries({ queryKey: ["member-record"] });
      onClose();
    },
  });
  const testPing = useMutation({
    mutationFn: () => api.post<{ ok: boolean; status: number; body: string }>(`/api/members/${agent!.id}/test-ping`),
    onSuccess: setPing,
  });
  const meData = useMe().data;
  const allMembers = useMembers().data;
  const pmAgent = allMembers?.find((x) => x.id === meData?.workspace?.pm_agent_id) ?? null;
  const toggleActive = useMutation({
    mutationFn: () => api.patch(`/api/members/${agent!.id}`, { active: !agent!.active }),
    onSuccess: () => {
      qc.invalidateQueries();
      onClose();
    },
  });

  return (
    <Modal
      open
      onClose={onClose}
      wide
      title={
        <>
          <Bot size={16} className="text-agent" /> {agent ? `Configure ${agent.name}` : "Add an agent"}
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) save.mutate();
        }}
      >
        <div className="max-h-[65vh] space-y-4 overflow-y-auto p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name">
              <input autoFocus className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="Grok Bot – Research" />
            </Field>
            <Field label="Handle" hint="Used for @mentions. Can't be changed later.">
              <input className={inputClass} value={handle} disabled={!!agent} onChange={(e) => setHandle(e.target.value)} placeholder="research-bot" />
            </Field>
          </div>
          <Field label="What is this agent good at?" hint="Shown to people when they pick who to assign.">
            <textarea className={textareaClass} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Market research, competitor summaries, drafting outreach" />
          </Field>
          <Field label="Avatar URL" hint="Optional.">
            <input className={inputClass} value={avatar} onChange={(e) => setAvatar(e.target.value)} />
          </Field>
          <div className="rounded-[10px] border border-line bg-panel p-4">
            <div className="mb-1 flex items-center gap-2 text-[13px] font-semibold">
              <Webhook size={14} className="text-ink-3" /> Wake-up webhook
            </div>
            <p className="mb-3 text-[12px] leading-relaxed text-ink-3">
              {pmAgent && pmAgent.id !== agent?.id
                ? `Optional. Leave it empty and wake-ups for this agent go to the workspace PM, @${pmAgent.handle}, which hands the work over. Set one to wake this agent directly instead.`
                : pmAgent && pmAgent.id === agent?.id
                  ? "This agent is the workspace PM: this webhook also wakes every agent that doesn't have its own."
                  : "Where the platform sends a request to wake this agent. You can also set a workspace-wide one under Workspace settings → Agent dispatch."}
            </p>
            <div className="space-y-3">
              <Field label="Webhook URL">
                <input className={inputClass} value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://…" />
              </Field>
              <Field label="Webhook key" hint="Sent as a Bearer token with every wake-up.">
                <input
                  className={inputClass}
                  type="password"
                  value={webhookKey}
                  onChange={(e) => setWebhookKey(e.target.value)}
                  placeholder={agent?.has_webhook ? "Saved. Type a new key to replace it." : "Paste the routine's secret key"}
                />
              </Field>
              <div className="flex flex-wrap items-center gap-5 text-[13px]">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={wakeOnMention} onChange={(e) => setWakeOnMention(e.target.checked)} /> Wake when @mentioned
                </label>
                <label className="flex items-center gap-2">
                  At most
                  <input type="number" min={1} max={1000} value={maxRuns} onChange={(e) => setMaxRuns(Number(e.target.value))} className={cx(inputClass, "w-20")} />
                  runs per hour
                </label>
              </div>
              {agent && (
                <div className="flex items-center gap-3 pt-1">
                  <Button type="button" size="sm" onClick={() => testPing.mutate()} disabled={testPing.isPending || !agent.has_webhook}>
                    <Zap size={13} /> {testPing.isPending ? "Pinging…" : "Send test ping"}
                  </Button>
                  {ping && (
                    <span className={cx("truncate text-[12px]", ping.ok ? "text-[#1f9d5c]" : "text-[#c4312b]")}>
                      {ping.ok ? "The agent accepted the ping. Check its chat for the run." : `Ping failed: ${ping.status || ""} ${ping.body}`}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
          {save.error && <p className="text-[13px] text-[#c4312b]">{(save.error as Error).message}</p>}
        </div>
        <ModalFooter
          hint={
            agent && isAdmin ? (
              <Button type="button" size="sm" variant="danger" onClick={() => toggleActive.mutate()}>
                {agent.active ? "Deactivate agent" : "Reactivate agent"}
              </Button>
            ) : undefined
          }
        >
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!name.trim() || save.isPending}>
            {agent ? "Save changes" : "Add agent"}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
