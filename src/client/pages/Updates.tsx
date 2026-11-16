import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ExternalLink, Megaphone, OctagonAlert, RefreshCw, Repeat, Trash2 } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { type Member, type Post, type PostKind, api } from "../api";
import { AgentBadge, Avatar, Button, EmptyState, IconButton, Markdown, Menu, Tag, TopBar, canDelete, cx, inputClass, timeAgo, useMe, useMembers } from "../components";
import { type EditorHandle, RichEditor } from "../editor";

const KIND: Record<PostKind, { label: string; tone: "gray" | "green" | "red"; icon: ReactNode }> = {
  update: { label: "Update", tone: "gray", icon: <Megaphone size={12} /> },
  done: { label: "Done", tone: "green", icon: <CheckCircle2 size={12} /> },
  blocker: { label: "Blocker", tone: "red", icon: <OctagonAlert size={12} /> },
};
const REACTIONS = ["👍", "🎉", "👀", "❤️"];

/** The workspace feed: short updates from people and agents, with reactions. */
export function UpdatesPage() {
  const [params, setParams] = useSearchParams();
  const who = (params.get("who") as "all" | "human" | "agent") || "all";
  const kind = (params.get("kind") as PostKind | null) ?? null;
  const routine = params.get("routine");
  const author = params.get("author");
  const members = useMembers();
  const byId = new Map((members.data ?? []).map((m) => [m.id, m]));
  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  const qs = new URLSearchParams();
  if (who !== "all") qs.set("member_kind", who);
  if (kind) qs.set("kind", kind);
  if (routine) qs.set("routine", routine);
  if (author) qs.set("author", author);
  const feed = useInfiniteQuery({
    queryKey: ["feed", qs.toString()],
    initialPageParam: "",
    queryFn: ({ pageParam }) => api.get<Post[]>(`/api/posts?${qs}${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ""}`),
    getNextPageParam: (last) => (last.length >= 50 ? last[last.length - 1].created_at : undefined),
  });
  const posts = feed.data?.pages.flat() ?? [];
  const authorMember = author ? (members.data ?? []).find((m) => m.id === author || m.handle === author) : undefined;

  return (
    <div className="flex h-full flex-col">
      <TopBar crumbs={[{ label: "Feed", icon: <Megaphone size={15} className="text-ink-3" /> }]} />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-2xl px-4 py-6 md:px-6">
          <Composer />

          <div className="mt-6 flex flex-wrap items-center gap-2">
            <Seg
              value={who}
              onChange={(v) => setParam("who", v === "all" ? null : v)}
              options={[
                ["all", "Everyone"],
                ["human", "People"],
                ["agent", "Agents"],
              ]}
            />
            <Seg
              value={kind ?? "all"}
              onChange={(v) => setParam("kind", v === "all" ? null : v)}
              options={[
                ["all", "All kinds"],
                ["done", "Done"],
                ["update", "Updates"],
                ["blocker", "Blockers"],
              ]}
            />
            {routine && (
              <Tag tone="violet">
                <Repeat size={11} /> {routine}
                <button className="ml-0.5 opacity-70 hover:opacity-100" onClick={() => setParam("routine", null)} aria-label="Clear routine filter">
                  ×
                </button>
              </Tag>
            )}
            {authorMember && (
              <Tag tone="blue">
                {authorMember.name}
                <button className="ml-0.5 opacity-70 hover:opacity-100" onClick={() => setParam("author", null)} aria-label="Clear author filter">
                  ×
                </button>
              </Tag>
            )}
            <button onClick={() => feed.refetch()} className="ml-auto text-ink-3 hover:text-ink" aria-label="Refresh" title="Refresh">
              <RefreshCw size={14} className={cx(feed.isFetching && "animate-spin")} />
            </button>
          </div>

          <ol className="mt-4 space-y-3">
            {posts.map((p) => (
              <PostCard key={p.id} post={p} byId={byId} onRoutine={(r) => setParam("routine", r)} onAuthor={(id) => setParam("author", id)} />
            ))}
          </ol>
          {feed.isLoading && <p className="mt-6 text-[13px] text-ink-3">Loading…</p>}
          {!feed.isLoading && !posts.length && (
            <EmptyState icon={<Megaphone size={18} />} title="Nothing shared yet">
              Post what you finished or what's blocking you. Agents post here with the share_update tool, and finished tasks show up automatically.
            </EmptyState>
          )}
          {feed.hasNextPage && (
            <div className="mt-4 flex justify-center">
              <Button onClick={() => feed.fetchNextPage()} disabled={feed.isFetchingNextPage}>
                {feed.isFetchingNextPage ? "Loading…" : "Show older"}
              </Button>
            </div>
          )}
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

function Composer() {
  const me = useMe().data?.member;
  const qc = useQueryClient();
  const editor = useRef<EditorHandle>(null);
  const [kind, setKind] = useState<PostKind>("update");
  const [more, setMore] = useState(false);
  const [task, setTask] = useState("");
  const [link, setLink] = useState("");
  const [routine, setRoutine] = useState("");
  const [empty, setEmpty] = useState(true);
  const post = useMutation({
    mutationFn: () =>
      api.post("/api/posts", {
        body: editor.current?.getMarkdown() ?? "",
        kind,
        task: task.trim() || null,
        link: link.trim() || null,
        routine: routine.trim() || null,
      }),
    onSuccess: () => {
      editor.current?.setMarkdown("");
      setEmpty(true);
      setTask("");
      setLink("");
      setKind("update");
      qc.invalidateQueries({ queryKey: ["feed"] });
    },
  });
  const submit = () => !empty && !post.isPending && post.mutate();
  return (
    <div className="rounded-xl border border-line-strong bg-canvas shadow-card">
      <div className="flex gap-3 px-3.5 pt-3">
        <Avatar member={me} size={24} />
        <div className="min-w-0 flex-1 text-[14px]">
          <RichEditor ref={editor} placeholder="Share an update: what you finished, shipped, or what's blocking you…" onChange={(md) => setEmpty(!md.trim())} onSubmit={submit} />
        </div>
      </div>
      {more && (
        <div className="grid gap-2 px-3.5 pt-3 sm:grid-cols-3">
          <input className={cx(inputClass, "h-8")} value={task} onChange={(e) => setTask(e.target.value)} placeholder="Task, e.g. IMP-12" aria-label="Related task" />
          <input className={cx(inputClass, "h-8")} value={link} onChange={(e) => setLink(e.target.value)} placeholder="Link (https://…)" aria-label="Link" />
          <input className={cx(inputClass, "h-8")} value={routine} onChange={(e) => setRoutine(e.target.value)} placeholder="Routine, e.g. daily-blog" aria-label="Routine" />
        </div>
      )}
      <div className="mt-2 flex items-center gap-2 border-t border-line px-3 py-2">
        <Menu
          label="Kind of update"
          width="w-44"
          trigger={
            <span className="flex h-7 items-center gap-1.5 rounded-md px-1.5 text-[12px] font-medium hover:bg-hover">
              <Tag tone={KIND[kind].tone}>
                {KIND[kind].icon} {KIND[kind].label}
              </Tag>
            </span>
          }
          value={kind}
          onChange={(k: PostKind) => setKind(k)}
          options={(Object.keys(KIND) as PostKind[]).map((k) => ({ value: k, label: KIND[k].label, icon: KIND[k].icon }))}
        />
        <button onClick={() => setMore((m) => !m)} className="h-7 rounded-md px-2 text-[12px] font-medium text-ink-3 hover:bg-hover hover:text-ink">
          {more ? "Fewer details" : "Add task, link or routine"}
        </button>
        {post.error && <span className="truncate text-[12px] text-danger">{(post.error as Error).message}</span>}
        <span className="ml-auto hidden text-[12px] text-ink-3 sm:inline">⌘ Enter</span>
        <Button variant="primary" size="sm" onClick={submit} disabled={empty || post.isPending}>
          {post.isPending ? "Sharing…" : "Share"}
        </Button>
      </div>
    </div>
  );
}

function PostCard({ post, byId, onRoutine, onAuthor }: { post: Post; byId: Map<string, Member>; onRoutine: (r: string) => void; onAuthor: (id: string) => void }) {
  const me = useMe().data?.member;
  const qc = useQueryClient();
  const author = byId.get(post.author_id);
  const isAgent = author?.kind === "agent";
  const react = useMutation({
    mutationFn: (emoji: string) => api.post(`/api/posts/${post.id}/reactions`, { emoji }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["feed"] }),
  });
  const del = useMutation({
    mutationFn: () => api.del(`/api/posts/${post.id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["feed"] }),
  });
  const [confirm, setConfirm] = useState(false);
  const k = KIND[post.kind];
  return (
    <li
      className={cx(
        "group rounded-xl border bg-canvas px-4 py-3 shadow-card",
        post.kind === "blocker" ? "border-danger-line shadow-[inset_3px_0_0_var(--c-danger)]" : isAgent ? "border-agent/20" : "border-line",
      )}
    >
      <div className="flex items-center gap-2 text-[13px]">
        <button onClick={() => onAuthor(post.author_id)} className="flex min-w-0 items-center gap-2 hover:underline" title="Show only their updates">
          <Avatar member={author} size={22} />
          <span className="truncate font-semibold">{author?.name ?? "Someone"}</span>
        </button>
        {isAgent && <AgentBadge />}
        <Tag tone={k.tone}>
          {k.icon} {k.label}
        </Tag>
        {post.routine && (
          <button onClick={() => onRoutine(post.routine!)} title="Show this routine">
            <Tag tone="violet">
              <Repeat size={11} /> {post.routine}
            </Tag>
          </button>
        )}
        <span className="ml-auto shrink-0 text-[12px] text-ink-3" title={new Date(post.created_at).toLocaleString()}>
          {timeAgo(post.created_at)}
        </span>
        {canDelete(me, post.author_id) &&
          (confirm ? (
            <button onClick={() => del.mutate()} onMouseLeave={() => setConfirm(false)} className="h-6 rounded-md bg-danger px-1.5 text-[12px] font-medium text-white">
              Delete
            </button>
          ) : (
            <IconButton label="Delete update" className="h-6 w-6 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-danger" onClick={() => setConfirm(true)}>
              <Trash2 size={12} />
            </IconButton>
          ))}
      </div>
      <div className="mt-2 text-[14px]">
        <Markdown text={post.body} />
      </div>
      {(post.task || post.link_url) && (
        <div className="mt-2 flex flex-wrap gap-2 text-[12px]">
          {post.task && (
            <Link to={`/t/${post.task.key}`} className="inline-flex h-6 max-w-full items-center gap-1.5 rounded-md border border-line px-2 text-ink-2 hover:bg-hover">
              <span className="text-ink-3 tabular-nums">{post.task.key}</span>
              <span className="truncate">{post.task.title}</span>
            </Link>
          )}
          {post.link_url && (
            <a href={post.link_url} target="_blank" rel="noreferrer noopener" className="inline-flex h-6 max-w-full items-center gap-1.5 rounded-md border border-line px-2 text-accent hover:bg-hover">
              <ExternalLink size={12} />
              <span className="truncate">{post.link_url.replace(/^https?:\/\//, "").replace(/\/$/, "")}</span>
            </a>
          )}
        </div>
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-1">
        {REACTIONS.map((emoji) => {
          const r = post.reactions.find((x) => x.emoji === emoji);
          const names = r?.by.map((id) => byId.get(id)?.name ?? "someone").join(", ");
          if (!r) {
            return (
              <button
                key={emoji}
                onClick={() => react.mutate(emoji)}
                className="h-6 rounded-full px-1.5 text-[13px] opacity-0 grayscale transition-opacity group-hover:opacity-60 hover:!opacity-100 hover:grayscale-0 focus:opacity-100"
                aria-label={`React ${emoji}`}
                title={emoji === "👍" ? "Useful" : undefined}
              >
                {emoji}
              </button>
            );
          }
          return (
            <button
              key={emoji}
              onClick={() => react.mutate(emoji)}
              title={names}
              aria-pressed={r.mine}
              className={cx(
                "flex h-6 items-center gap-1 rounded-full border px-2 text-[12px] tabular-nums",
                r.mine ? "border-accent/40 bg-accent-soft text-accent" : "border-line text-ink-2 hover:bg-hover",
              )}
            >
              <span className="text-[13px]">{emoji}</span>
              {r.count}
            </button>
          );
        })}
      </div>
    </li>
  );
}
