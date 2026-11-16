import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, AtSign, CheckCircle2, Inbox as InboxIcon, MessageSquare } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { type Inbox, api } from "../api";
import { AgentBadge, Avatar, Button, EmptyState, Markdown, Tag, TopBar, timeAgo, useMembers } from "../components";

function Group({ icon, title, count, children }: { icon: ReactNode; title: string; count: number; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold">
        <span className="text-ink-3">{icon}</span>
        {title}
        <span className="rounded-[5px] bg-active px-1.5 text-[11px] leading-[18px] text-ink-2">{count}</span>
      </div>
      <ul className="divide-y divide-line overflow-hidden rounded-[10px] border border-line">{children}</ul>
    </section>
  );
}

export function InboxPage() {
  const q = useQuery({ queryKey: ["inbox"], queryFn: () => api.get<Inbox>("/api/inbox") });
  const members = useMembers();
  const byId = new Map((members.data ?? []).map((m) => [m.id, m]));
  const qc = useQueryClient();
  const runAction = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "retry" | "dismiss" }) => api.post(`/api/runs/${id}/${action}`),
    onSuccess: () => qc.invalidateQueries(),
  });
  const data = q.data;
  const empty = data && !data.questions.length && !data.runs.length && !data.mentions.length;

  return (
    <div className="flex h-full flex-col">
      <TopBar crumbs={[{ label: "Needs you", icon: <InboxIcon size={15} className="text-ink-3" /> }]} />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-3xl space-y-8 px-4 py-6 md:px-6">
          {q.isLoading && <p className="text-[13px] text-ink-3">Loading…</p>}
          {empty && (
            <EmptyState icon={<CheckCircle2 size={18} />} title="You're all caught up">
              Questions from agents, agents that can't be reached, and @mentions of you show up here.
            </EmptyState>
          )}
          {!!data?.questions.length && (
            <Group icon={<MessageSquare size={15} />} title="Questions waiting for your answer" count={data.questions.length}>
              {data.questions.map((qe) => {
                const author = byId.get(qe.author_id);
                return (
                  <li key={qe.id}>
                    <Link to={`/t/${qe.task_key}?tab=activity`} className="block px-4 py-3 hover:bg-hover">
                      <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[13px]">
                        <Avatar member={author} size={18} />
                        <span className="font-semibold">{author?.name}</span>
                        <AgentBadge />
                        <span className="text-ink-3">asked on</span>
                        <span className="truncate font-medium">{qe.task_title}</span>
                        <span className="ml-auto text-[12px] text-ink-3">{timeAgo(qe.created_at)}</span>
                      </div>
                      <Markdown text={qe.body} className="pl-6 text-[13px] text-ink-2" />
                    </Link>
                  </li>
                );
              })}
            </Group>
          )}
          {!!data?.runs.length && (
            <Group icon={<AlertTriangle size={15} />} title="Agents that need a hand" count={data.runs.length}>
              {data.runs.map((r) => (
                <li key={r.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2 text-[13px]">
                    <Tag tone="red">{r.status === "failed" ? "Failed" : "Gone quiet"}</Tag>
                    <span className="font-semibold">{r.agent_name}</span>
                    <Link to={`/t/${r.task_key}`} className="truncate text-ink-2 hover:underline">
                      {r.task_key} · {r.task_title}
                    </Link>
                    <span className="ml-auto text-[12px] text-ink-3">{timeAgo(r.created_at)}</span>
                  </div>
                  {r.last_error && <p className="mt-1 truncate text-[12px] text-ink-3">{r.last_error}</p>}
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" onClick={() => runAction.mutate({ id: r.id, action: "retry" })}>
                      Wake again
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => runAction.mutate({ id: r.id, action: "dismiss" })}>
                      Dismiss
                    </Button>
                  </div>
                </li>
              ))}
            </Group>
          )}
          {!!data?.mentions.length && (
            <Group icon={<AtSign size={15} />} title="Mentions" count={data.mentions.length}>
              {data.mentions.map((e) => (
                <li key={e.id}>
                  <Link to={`/t/${e.task_key}?tab=activity`} className="block px-4 py-3 hover:bg-hover">
                    <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[13px]">
                      <Avatar member={byId.get(e.author_id)} size={18} />
                      <span className="font-semibold">{byId.get(e.author_id)?.name}</span>
                      <span className="text-ink-3">mentioned you on</span>
                      <span className="truncate font-medium">{e.task_title}</span>
                      <span className="ml-auto text-[12px] text-ink-3">{timeAgo(e.created_at)}</span>
                    </div>
                    <Markdown text={e.body} className="pl-6 text-[13px] text-ink-2" />
                  </Link>
                </li>
              ))}
            </Group>
          )}
        </div>
      </div>
    </div>
  );
}
