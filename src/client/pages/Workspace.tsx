import { useQuery } from "@tanstack/react-query";
import { Activity, Building2, Users, Zap } from "lucide-react";
import { Link } from "react-router";
import { type Overview, type Status, STATUS_LABEL, api } from "../api";
import { AgentBadge, EmptyState, MemberChip, SectionTitle, Tag, TopBar, cx, timeAgo, useMembers } from "../components";
import { FeedList } from "./Feed";

const BAR: { status: Status; color: string }[] = [
  { status: "backlog", color: "#c9cbd0" },
  { status: "todo", color: "#8f9198" },
  { status: "in_progress", color: "#2b6feb" },
  { status: "waiting_on_human", color: "#e5791d" },
  { status: "done", color: "#1f9d5c" },
];

/** The workspace record: top-level visibility across the whole team, people and agents. */
export function WorkspacePage() {
  const q = useQuery({ queryKey: ["overview"], queryFn: () => api.get<Overview>("/api/overview"), refetchInterval: 30_000 });
  const members = useMembers();
  const byId = new Map((members.data ?? []).map((m) => [m.id, m]));
  if (q.isLoading || !q.data) return <div className="p-8 text-[13px] text-ink-3">Loading…</div>;
  const o = q.data;
  const open = (["backlog", "todo", "in_progress", "waiting_on_human"] as Status[]).reduce((n, s) => n + (o.by_status[s] ?? 0), 0);
  const total = BAR.reduce((n, b) => n + (o.by_status[b.status] ?? 0), 0);
  const load = [...o.by_member].sort((a, b) => b.open - a.open);
  const stat = (label: string, value: number, tone?: string, sub?: string) => (
    <div className="min-w-[150px] flex-1 border-r border-line px-4 py-3.5 last:border-r-0">
      <div className="text-[12px] text-ink-3">{label}</div>
      <div className={cx("mt-0.5 text-[24px] font-semibold tracking-[-0.02em] tabular-nums", tone)}>{value}</div>
      {sub && <div className="text-[12px] text-ink-3">{sub}</div>}
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      <TopBar crumbs={[{ label: "Overview", icon: <Building2 size={15} className="text-ink-3" /> }]} />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-6xl px-4 py-6 md:px-6">
          <div className="flex items-center gap-3.5">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-ink text-[18px] font-semibold text-canvas">{o.workspace.name.slice(0, 1)}</span>
            <div>
              <h1 className="text-[22px] font-semibold tracking-[-0.015em]">{o.workspace.name}</h1>
              <p className="text-[13px] text-ink-3">
                {(members.data ?? []).filter((m) => m.active && m.kind === "human").length} people ·{" "}
                {(members.data ?? []).filter((m) => m.active && m.kind === "agent").length} agents
              </p>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap overflow-hidden rounded-[10px] border border-line">
            {stat("Open tasks", open)}
            {stat("Waiting on a person", o.by_status.waiting_on_human ?? 0, o.by_status.waiting_on_human ? "text-[#e5791d]" : undefined, `${o.open_questions} open questions`)}
            {stat("Agents working now", o.active_runs.length, o.active_runs.length ? "text-agent" : undefined)}
            {stat("Done in last 7 days", o.done_7d, o.done_7d ? "text-[#1f9d5c]" : undefined)}
          </div>

          {total > 0 && (
            <section className="mt-8">
              <SectionTitle>Work by status</SectionTitle>
              <div className="flex h-2.5 gap-[2px] overflow-hidden rounded-full">
                {BAR.filter((b) => o.by_status[b.status]).map((b) => (
                  <div key={b.status} style={{ flexGrow: o.by_status[b.status], background: b.color }} title={`${STATUS_LABEL[b.status]}: ${o.by_status[b.status]}`} />
                ))}
              </div>
              <div className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-ink-2">
                {BAR.map((b) => (
                  <span key={b.status} className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full" style={{ background: b.color }} />
                    {STATUS_LABEL[b.status]} <span className="text-ink-3 tabular-nums">{o.by_status[b.status] ?? 0}</span>
                  </span>
                ))}
              </div>
            </section>
          )}

          <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_380px]">
            <section className="min-w-0">
              <SectionTitle>Recent activity</SectionTitle>
              <FeedList entries={o.recent} byId={byId} />
            </section>
            <div className="space-y-8">
              <section>
                <SectionTitle>Who's holding what</SectionTitle>
                {load.length ? (
                  <ul className="divide-y divide-line overflow-hidden rounded-[10px] border border-line">
                    {load.map((r) => {
                      const m = byId.get(r.member_id);
                      return (
                        <li key={r.member_id}>
                          <Link to={`/team/${m?.handle ?? r.member_id}`} className="flex h-11 items-center gap-2 px-3.5 text-[13px] hover:bg-hover">
                            <span className="min-w-0 flex-1 font-medium">
                              <MemberChip member={m} />
                            </span>
                            {r.waiting > 0 && <Tag tone="orange">{r.waiting} waiting</Tag>}
                            <span className="w-14 text-right text-ink-2 tabular-nums">{r.open} open</span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="text-[13px] text-ink-3">Nothing is assigned yet.</p>
                )}
              </section>
              <section>
                <SectionTitle>Agents working now</SectionTitle>
                {o.active_runs.length ? (
                  <ul className="divide-y divide-line overflow-hidden rounded-[10px] border border-line">
                    {o.active_runs.map((r) => (
                      <li key={r.id}>
                        <Link to={`/t/${r.task_key}?tab=activity`} className="block px-3.5 py-2.5 hover:bg-hover">
                          <div className="flex items-center gap-2 text-[13px]">
                            <MemberChip member={byId.get(r.agent_id)} />
                            <Tag tone="violet">
                              {r.status === "active" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
                              {r.status === "active" ? "Working" : r.status === "dispatched" ? "Starting" : "Waking"}
                            </Tag>
                            <span className="ml-auto text-[12px] text-ink-3">{timeAgo(r.last_activity_at ?? r.created_at)}</span>
                          </div>
                          <div className="mt-1 truncate text-[12px] text-ink-2">
                            {r.task_key} · {r.task_title}
                          </div>
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyState icon={<Zap size={18} />} title="No agent is working right now">
                    Agents are woken when someone assigns them a task, answers their question, or @mentions them.
                  </EmptyState>
                )}
              </section>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export { Activity, Users, AgentBadge };
