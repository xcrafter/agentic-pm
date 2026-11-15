import { Link } from "react-router";
import type { FeedEntry, Member } from "../api";
import { AgentBadge, Avatar, EmptyState, timeAgo } from "../components";
import { Activity } from "lucide-react";

const VERB: Record<string, string> = {
  comment: "commented on",
  update: "posted an update on",
  question: "asked a question on",
  answer: "answered on",
  note_created: "added a note to",
  checklist_created: "added a checklist to",
  attachment_added: "attached a file to",
};

/** Cross-task activity list used by the workspace and member record pages. */
export function FeedList({ entries, byId, showAuthor = true }: { entries: FeedEntry[]; byId: Map<string, Member>; showAuthor?: boolean }) {
  if (!entries.length)
    return (
      <EmptyState icon={<Activity size={18} />} title="No activity yet">
        Comments, updates, questions and answers show up here as work happens.
      </EmptyState>
    );
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-[10px] border border-line">
      {entries.map((e) => {
        const author = byId.get(e.author_id);
        const excerpt = e.body || e.data?.title || e.data?.filename || "";
        return (
          <li key={e.id}>
            <Link to={`/t/${e.task_key}?tab=activity`} className="flex gap-3 px-3.5 py-3 hover:bg-hover">
              {showAuthor && <Avatar member={author} size={22} />}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
                  {showAuthor && <span className="font-semibold">{author?.name ?? "Someone"}</span>}
                  {showAuthor && author?.kind === "agent" && <AgentBadge />}
                  <span className="text-ink-3">{VERB[e.type] ?? e.type}</span>
                  <span className="truncate font-medium">{e.task_title}</span>
                  <span className="text-[12px] text-ink-3 tabular-nums">{e.task_key}</span>
                  <span className="ml-auto text-[12px] text-ink-3">{timeAgo(e.created_at)}</span>
                </div>
                {excerpt && <p className="mt-0.5 line-clamp-2 text-[13px] text-ink-2">{excerpt.replace(/[#*_`>]/g, "")}</p>}
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
