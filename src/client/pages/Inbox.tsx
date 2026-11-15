import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { type Inbox, api } from "../api";
import { AgentBadge, Avatar, Button, Markdown, timeAgo, useMembers } from "../components";

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
    <div>
      <header className="border-b border-zinc-200 px-4 py-2.5 md:px-6 dark:border-zinc-800">
        <h1 className="text-[15px] font-semibold">Needs you</h1>
      </header>
      <div className="mx-auto max-w-3xl space-y-8 px-4 py-6 md:px-6">
        {q.isLoading && <p className="text-zinc-400">Loading…</p>}
        {empty && (
          <div className="py-16 text-center text-sm text-zinc-400">
            Nothing needs you right now. Questions from agents and stuck runs will show up here.
          </div>
        )}
        {!!data?.questions.length && (
          <section>
            <h2 className="mb-2 text-xs font-medium tracking-wide text-zinc-500 uppercase">Questions from agents</h2>
            <ul className="space-y-2">
              {data.questions.map((qe) => {
                const author = byId.get(qe.author_id);
                return (
                  <li key={qe.id}>
                    <Link
                      to={`/t/${qe.task_key}`}
                      className="block rounded-lg border border-orange-200 bg-orange-50/50 p-3 hover:border-orange-300 dark:border-orange-500/30 dark:bg-orange-500/5"
                    >
                      <div className="mb-1 flex items-center gap-2 text-xs">
                        <Avatar member={author} size={16} />
                        <span className="font-medium">{author?.name}</span>
                        <AgentBadge />
                        <span className="text-zinc-500">
                          on {qe.task_key} · {qe.task_title}
                        </span>
                        <span className="ml-auto text-zinc-400">{timeAgo(qe.created_at)}</span>
                      </div>
                      <Markdown text={qe.body} className="text-[13px]" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        {!!data?.runs.length && (
          <section>
            <h2 className="mb-2 text-xs font-medium tracking-wide text-zinc-500 uppercase">Agent runs that need attention</h2>
            <ul className="space-y-2">
              {data.runs.map((r) => (
                <li key={r.id} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                  <div className="flex flex-wrap items-center gap-2 text-[13px]">
                    <span className={r.status === "failed" ? "text-red-600" : "text-amber-600"}>
                      {r.status === "failed" ? "Couldn't reach" : "No activity from"} {r.agent_name}
                    </span>
                    <Link to={`/t/${r.task_key}`} className="text-zinc-500 hover:underline">
                      {r.task_key} · {r.task_title}
                    </Link>
                    <span className="ml-auto text-xs text-zinc-400">{timeAgo(r.created_at)}</span>
                  </div>
                  {r.last_error && <p className="mt-1 truncate text-xs text-zinc-500">{r.last_error}</p>}
                  <div className="mt-2 flex gap-2">
                    <Button className="text-xs" onClick={() => runAction.mutate({ id: r.id, action: "retry" })}>
                      Wake again
                    </Button>
                    <Button variant="ghost" className="text-xs" onClick={() => runAction.mutate({ id: r.id, action: "dismiss" })}>
                      Dismiss
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
        {!!data?.mentions.length && (
          <section>
            <h2 className="mb-2 text-xs font-medium tracking-wide text-zinc-500 uppercase">Mentions</h2>
            <ul className="space-y-2">
              {data.mentions.map((e) => (
                <li key={e.id}>
                  <Link to={`/t/${e.task_key}`} className="block rounded-lg border border-zinc-200 p-3 hover:border-zinc-300 dark:border-zinc-800">
                    <div className="mb-1 flex items-center gap-2 text-xs">
                      <Avatar member={byId.get(e.author_id)} size={16} />
                      <span className="font-medium">{byId.get(e.author_id)?.name}</span>
                      <span className="text-zinc-500">
                        on {e.task_key} · {e.task_title}
                      </span>
                      <span className="ml-auto text-zinc-400">{timeAgo(e.created_at)}</span>
                    </div>
                    <Markdown text={e.body} className="text-[13px]" />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
