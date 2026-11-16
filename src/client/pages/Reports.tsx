import { useQuery } from "@tanstack/react-query";
import { BarChart3, Repeat } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { type Report, type ReportPerson, api } from "../api";
import { AgentBadge, Avatar, EmptyState, SectionTitle, TopBar, cx, timeAgo, useMembers } from "../components";

type Col = { key: keyof ReportPerson; label: string; hint: string; fmt?: (p: ReportPerson) => string; bad?: boolean };
const COLS: Col[] = [
  { key: "tasks_done", label: "Tasks done", hint: "Tasks assigned to them that were completed in the period" },
  {
    key: "avg_hours_to_done",
    label: "Avg. time to done",
    hint: "Average time from creating a task to finishing it",
    fmt: (p) => (p.avg_hours_to_done == null ? "—" : p.avg_hours_to_done < 48 ? `${p.avg_hours_to_done} h` : `${Math.round(p.avg_hours_to_done / 24)} d`),
  },
  { key: "updates", label: "Updates shared", hint: "Feed posts they wrote (not counting automatic ones)" },
  { key: "useful", label: "👍 Useful", hint: "👍 reactions from people on their feed posts" },
  { key: "open_tasks", label: "Open now", hint: "Tasks currently assigned and not finished" },
  { key: "overdue", label: "Overdue", hint: "Open tasks past their due date", bad: true },
  { key: "questions", label: "Questions asked", hint: "Times they asked a person for input on a task" },
  { key: "blockers", label: "Blockers", hint: "Feed posts marked as blockers", bad: true },
  { key: "failed_runs", label: "Failed runs", hint: "Agent runs that failed or went quiet", bad: true },
];

/** Who is moving work forward: output, speed, usefulness and problems per person and agent. */
export function ReportsPage() {
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [who, setWho] = useState<"all" | "human" | "agent">("all");
  const [sort, setSort] = useState<keyof ReportPerson>("tasks_done");
  const q = useQuery({ queryKey: ["report", days], queryFn: () => api.get<Report>(`/api/reports?days=${days}`) });
  const members = useMembers();
  const byId = new Map((members.data ?? []).map((m) => [m.id, m]));

  const rows = (q.data?.people ?? [])
    .filter((p) => who === "all" || p.kind === who)
    .sort((a, b) => {
      const av = a[sort] ?? -1;
      const bv = b[sort] ?? -1;
      if (sort === "avg_hours_to_done") return (av === -1 ? 1e9 : (av as number)) - (bv === -1 ? 1e9 : (bv as number));
      return (bv as number) - (av as number) || a.name.localeCompare(b.name);
    });
  const totals = rows.reduce((t, p) => ({ done: t.done + p.tasks_done, updates: t.updates + p.updates, useful: t.useful + p.useful, problems: t.problems + p.failed_runs }), {
    done: 0,
    updates: 0,
    useful: 0,
    problems: 0,
  });
  const dayList = Array.from({ length: days }, (_, i) => new Date(Date.now() - (days - 1 - i) * 86400_000).toISOString().slice(0, 10));
  const cell = "h-11 border-r border-b border-line px-3 text-[13px] whitespace-nowrap tabular-nums";

  return (
    <div className="flex h-full flex-col">
      <TopBar crumbs={[{ label: "Reports", icon: <BarChart3 size={15} className="text-ink-3" /> }]} />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-6xl px-4 py-6 md:px-6">
          <div className="flex flex-wrap items-center gap-3">
            <div>
              <h1 className="text-[22px] font-semibold tracking-[-0.015em]">Who's moving work forward</h1>
              <p className="text-[13px] text-ink-3">Output, speed, how useful people found their updates, and problems, for people and agents.</p>
            </div>
            <div className="ml-auto flex gap-2">
              <Seg value={who} onChange={setWho} options={[["all", "Everyone"], ["human", "People"], ["agent", "Agents"]]} />
              <Seg value={String(days) as "7" | "30" | "90"} onChange={(v) => setDays(Number(v) as 7 | 30 | 90)} options={[["7", "7 days"], ["30", "30 days"], ["90", "90 days"]]} />
            </div>
          </div>

          <div className="mt-6 flex flex-wrap overflow-hidden rounded-[10px] border border-line">
            {[
              ["Tasks done", totals.done, "text-[#1f9d5c]"],
              ["Updates shared", totals.updates, ""],
              ["👍 from people", totals.useful, ""],
              ["Failed or quiet runs", totals.problems, totals.problems ? "text-danger" : ""],
            ].map(([label, n, tone]) => (
              <div key={label as string} className="min-w-[150px] flex-1 border-r border-line px-4 py-3.5 last:border-r-0">
                <div className="text-[12px] text-ink-3">{label}</div>
                <div className={cx("mt-0.5 text-[24px] font-semibold tracking-[-0.02em] tabular-nums", tone as string)}>{n}</div>
              </div>
            ))}
          </div>

          <section className="mt-8">
            <SectionTitle>People and agents</SectionTitle>
            {q.isLoading ? (
              <p className="text-[13px] text-ink-3">Loading…</p>
            ) : (
              <div className="overflow-x-auto rounded-[10px] border border-line">
                <table className="w-full min-w-[1000px] border-separate border-spacing-0">
                  <thead className="bg-panel">
                    <tr>
                      <th className="h-9 border-r border-b border-line px-3 text-left text-[12px] font-medium text-ink-3">Name</th>
                      {COLS.map((c) => (
                        <th key={c.key} className="h-9 border-r border-b border-line px-3 text-right text-[12px] font-medium text-ink-3 last:border-r-0" title={c.hint}>
                          <button onClick={() => setSort(c.key)} className={cx("hover:text-ink", sort === c.key && "text-ink underline underline-offset-4")}>
                            {c.label}
                          </button>
                        </th>
                      ))}
                      <th className="h-9 border-b border-line px-3 text-left text-[12px] font-medium text-ink-3">Last active</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((p) => {
                      const quiet = p.tasks_done === 0 && p.updates === 0 && p.open_tasks === 0;
                      return (
                        <tr key={p.id} className={cx("hover:bg-hover", quiet && "text-ink-3")}>
                          <td className={cx(cell, "max-w-[240px]")}>
                            <Link to={`/team/${p.handle}`} className="flex min-w-0 items-center gap-2 font-medium hover:underline">
                              <Avatar member={p} size={20} />
                              <span className="truncate">{p.name}</span>
                              {p.kind === "agent" && <AgentBadge />}
                            </Link>
                          </td>
                          {COLS.map((c) => {
                            const v = p[c.key] as number | null;
                            return (
                              <td key={c.key} className={cx(cell, "text-right", c.bad && v ? "font-medium text-danger" : "", !v && "text-ink-3")}>
                                {c.fmt ? c.fmt(p) : v || "—"}
                              </td>
                            );
                          })}
                          <td className="h-11 border-b border-line px-3 text-[12px] whitespace-nowrap text-ink-3">{p.last_active ? timeAgo(p.last_active) : "never"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-2 text-[12px] text-ink-3">Hover a column name to see how it's counted. Click it to sort. Greyed rows had no activity in the period.</p>
          </section>

          <section className="mt-8">
            <SectionTitle>Routines</SectionTitle>
            {!q.data?.routines.length ? (
              <EmptyState icon={<Repeat size={18} />} title="No routines yet">
                When an agent posts with a routine name (for example <code className="text-ink-2">share_update(routine: "daily-blog")</code>), its consistency shows up here, day by day.
              </EmptyState>
            ) : (
              <ul className="divide-y divide-line overflow-hidden rounded-[10px] border border-line">
                {q.data.routines.map((r) => {
                  const author = byId.get(r.author_id);
                  const hit = new Set(r.days);
                  const missed = dayList.filter((d) => !hit.has(d)).length;
                  return (
                    <li key={`${r.routine}-${r.author_id}`} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                      <div className="w-56 min-w-0">
                        <Link to={`/feed?routine=${encodeURIComponent(r.routine)}`} className="flex items-center gap-1.5 text-[13px] font-medium hover:underline">
                          <Repeat size={13} className="text-agent" /> {r.routine}
                        </Link>
                        <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-ink-3">
                          <Avatar member={author} size={14} /> {author?.name ?? "Someone"} · last {timeAgo(r.last_at)}
                        </div>
                      </div>
                      <div className="flex min-w-0 flex-1 flex-wrap gap-[3px]" aria-label={`Posted on ${hit.size} of ${days} days`}>
                        {dayList.map((d) => (
                          <span
                            key={d}
                            title={`${d}: ${hit.has(d) ? "posted" : "nothing"}`}
                            className={cx("rounded-[2px]", days > 30 ? "h-2.5 w-1.5" : "h-3.5 w-2.5", hit.has(d) ? "bg-[#1f9d5c]" : "bg-active")}
                          />
                        ))}
                      </div>
                      <div className="w-36 text-right text-[12px]">
                        <span className="font-medium tabular-nums">{hit.size}</span>
                        <span className="text-ink-3"> of {days} days</span>
                        {missed > 0 && days <= 30 && <div className="text-ink-3">{r.posts} posts</div>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function Seg<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: [T, string][] }) {
  return (
    <div className="flex rounded-lg border border-line-strong bg-subtle p-0.5">
      {options.map(([v, label]) => (
        <button
          key={v}
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={cx("h-6 rounded-md px-2 text-[12px] font-medium", value === v ? "bg-canvas text-ink shadow-btn" : "text-ink-3 hover:text-ink-2")}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
