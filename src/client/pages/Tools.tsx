import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Pin, RefreshCw, Search, Sparkles, Wrench, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { type ToolEntry, api } from "../api";
import { Button, DeleteButton, EmptyState, IconButton, Markdown, TopBar, canDelete, cx, inputClass, textareaClass, timeAgo, useMe, useMembers } from "../components";

const useTools = () =>
  useQuery({
    queryKey: ["tools"],
    queryFn: () => api.get<ToolEntry[]>("/api/tools"),
    // Keep an eye on tools still being read for the first time.
    refetchInterval: (q) => (q.state.data?.some((t) => t.enriched_by === "pending") ? 3000 : false),
  });

function ToolIcon({ tool, size = 20 }: { tool: ToolEntry; size?: number }) {
  const [broken, setBroken] = useState(false);
  return tool.icon_url && !broken ? (
    <img src={tool.icon_url} alt="" width={size} height={size} referrerPolicy="no-referrer" onError={() => setBroken(true)} className="shrink-0 rounded-[5px] object-contain" />
  ) : (
    <span style={{ width: size, height: size }} className="flex shrink-0 items-center justify-center rounded-[5px] bg-subtle text-[11px] font-semibold text-ink-3 uppercase">
      {tool.name.charAt(0)}
    </span>
  );
}

const researching = (t: ToolEntry) => !!t.research_task && !["done", "canceled"].includes(t.research_task.status ?? "");

function Source({ tool }: { tool: ToolEntry }) {
  if (tool.enriched_by === "pending") return <span className="inline-flex items-center gap-1 text-agent"><Sparkles size={11} className="animate-pulse" /> Reading the site…</span>;
  if (researching(tool)) return <span className="inline-flex items-center gap-1 text-agent"><Sparkles size={11} /> Agent researching</span>;
  if (tool.enriched_by === "agent") return <span>Researched by an agent</span>;
  if (tool.enriched_by === "human") return <span>Edited by a person</span>;
  if (tool.enriched_by === "failed") return <span className="text-warn">Couldn't read the site</span>;
  return <span>AI summary</span>;
}

/** A quiet bookmark list of useful tools: paste a site, get a summary and tags. */
export function ToolsPage() {
  const [params, setParams] = useSearchParams();
  const selected = params.get("t");
  const tag = params.get("tag");
  const tools = useTools();
  const qc = useQueryClient();
  const me = useMe().data;
  const [url, setUrl] = useState("");
  const [q, setQ] = useState("");
  const hasPm = !!me?.workspace?.pm_agent_id;
  const add = useMutation({
    mutationFn: () => api.post<ToolEntry>("/api/tools", { url, research: hasPm }),
    onSuccess: () => {
      setUrl("");
      qc.invalidateQueries({ queryKey: ["tools"] });
    },
  });
  const set = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  const all = tools.data ?? [];
  const text = q.trim().toLowerCase();
  const rows = all.filter(
    (t) =>
      (!tag || t.tags.includes(tag)) &&
      (!text || `${t.name} ${t.domain} ${t.summary} ${t.tags.join(" ")} ${t.category ?? ""}`.toLowerCase().includes(text)),
  );
  const tagCounts = new Map<string, number>();
  for (const t of all) for (const g of t.tags) tagCounts.set(g, (tagCounts.get(g) ?? 0) + 1);
  const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 16);
  const current = all.find((t) => t.id === selected) ?? null;

  return (
    <div className="flex h-full flex-col">
      <TopBar crumbs={[{ label: "Tools", icon: <Wrench size={15} className="text-ink-3" /> }]} />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="space-y-2 border-b border-line px-3 py-2 md:px-5">
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (url.trim()) add.mutate();
              }}
            >
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="Paste a tool's website, e.g. linear.app"
                aria-label="Tool website"
                className={cx(inputClass, "h-7 w-full text-[12px] sm:w-72")}
              />
              <Button size="sm" variant="primary" disabled={!url.trim() || add.isPending}>
                {add.isPending ? "Adding…" : "Add tool"}
              </Button>
              <label className="flex h-7 w-52 items-center gap-1.5 rounded-lg border border-line-strong bg-canvas px-2 text-[12px] focus-within:border-accent/50 sm:ml-auto">
                <Search size={13} className="shrink-0 text-ink-3" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tools" aria-label="Search tools" className="w-full min-w-0 bg-transparent outline-none placeholder:text-ink-3" />
              </label>
            </form>
            {add.error && <p className="text-[12px] text-danger">{(add.error as Error).message}</p>}
            {!add.error && add.isSuccess && (
              <p className="text-[12px] text-ink-3">{hasPm ? "Added. A first summary appears in a few seconds, then your PM agent researches it." : "Added. A summary and tags appear in a few seconds."}</p>
            )}
            {topTags.length > 0 && (
              <div className="scroll-row flex flex-wrap items-center gap-1">
                {topTags.map(([g, n]) => (
                  <button
                    key={g}
                    aria-pressed={tag === g}
                    onClick={() => set("tag", tag === g ? null : g)}
                    className={cx("inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[12px]", tag === g ? "border-accent/40 bg-accent-soft text-accent" : "border-line text-ink-2 hover:bg-hover")}
                  >
                    {g} <span className="tabular-nums text-ink-3">{n}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {tools.isLoading ? (
              <p className="p-6 text-[13px] text-ink-3">Loading…</p>
            ) : !rows.length ? (
              <EmptyState icon={<Wrench size={18} />} title={all.length ? "No tools match" : "No tools yet"}>
                {all.length ? "Try another search or tag." : "Paste the website of a tool you found useful. It gets a short summary and tags automatically."}
              </EmptyState>
            ) : (
              <ul className="divide-y divide-line">
                {rows.map((t) => (
                  <li key={t.id}>
                    <button onClick={() => set("t", t.id)} className={cx("flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-hover md:px-5", selected === t.id && "bg-active")}>
                      <span className="pt-0.5">
                        <ToolIcon tool={t} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          {t.pinned_at && <Pin size={12} className="shrink-0 text-[#e5a00d]" fill="currentColor" aria-label="Pinned" />}
                          <span className="truncate text-[14px] font-medium">{t.name}</span>
                          <span className="truncate text-[12px] text-ink-3">{t.domain}</span>
                          {t.pricing && <span className="hidden shrink-0 text-[12px] text-ink-3 sm:inline">· {t.pricing}</span>}
                        </span>
                        {t.summary ? (
                          <span className="mt-0.5 line-clamp-2 block text-[13px] text-ink-2">{t.summary}</span>
                        ) : (
                          <span className="mt-0.5 block text-[12px] text-ink-3">
                            <Source tool={t} />
                          </span>
                        )}
                        {t.tags.length > 0 && (
                          <span className="mt-1 flex flex-wrap gap-1">
                            {t.tags.map((g) => (
                              <span key={g} className="rounded-[5px] bg-subtle px-1.5 text-[11px] leading-[18px] text-ink-2">
                                {g}
                              </span>
                            ))}
                          </span>
                        )}
                      </span>
                      <span className="hidden w-36 shrink-0 pt-0.5 text-right text-[12px] text-ink-3 md:block">
                        <Source tool={t} />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        {current && <ToolPanel key={current.id} tool={current} hasPm={hasPm} onClose={() => set("t", null)} />}
      </div>
    </div>
  );
}

function ToolPanel({ tool, hasPm, onClose }: { tool: ToolEntry; hasPm: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const me = useMe().data?.member;
  const members = useMembers();
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState({ name: tool.name, summary: tool.summary, tags: tool.tags.join(", "), category: tool.category ?? "", pricing: tool.pricing ?? "", notes: tool.notes });
  useEffect(() => {
    if (!editing) setF({ name: tool.name, summary: tool.summary, tags: tool.tags.join(", "), category: tool.category ?? "", pricing: tool.pricing ?? "", notes: tool.notes });
  }, [tool, editing]);
  const refresh = () => qc.invalidateQueries({ queryKey: ["tools"] });
  const patch = useMutation({ mutationFn: (b: Record<string, unknown>) => api.patch<ToolEntry>(`/api/tools/${tool.id}`, b), onSuccess: refresh });
  const reread = useMutation({ mutationFn: () => api.post(`/api/tools/${tool.id}/refresh`), onSuccess: refresh });
  const research = useMutation({ mutationFn: () => api.post<{ task_key: string }>(`/api/tools/${tool.id}/research`), onSuccess: refresh });
  const err = patch.error || reread.error || research.error;
  const field = (k: keyof typeof f, label: string, input: React.ReactNode) => (
    <label className="block">
      <span className="mb-1 block text-[12px] font-medium text-ink-3">{label}</span>
      {input}
    </label>
  );

  return (
    <aside className="fixed inset-0 z-40 flex flex-col bg-canvas md:static md:z-auto md:w-[420px] md:shrink-0 md:border-l md:border-line">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
        <ToolIcon tool={tool} size={18} />
        <span className="truncate text-[14px] font-semibold">{tool.name}</span>
        <span className="ml-auto flex items-center gap-0.5">
          <IconButton label={tool.pinned_at ? "Unpin" : "Pin to top"} className={cx(tool.pinned_at && "text-[#e5a00d]")} onClick={() => patch.mutate({ pinned: !tool.pinned_at })}>
            <Pin size={15} fill={tool.pinned_at ? "currentColor" : "none"} />
          </IconButton>
          <IconButton label="Close" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
        <a href={tool.url} target="_blank" rel="noreferrer noopener" className="inline-flex max-w-full items-center gap-1.5 text-[13px] text-accent hover:underline">
          <ExternalLink size={13} /> <span className="truncate">{tool.url.replace(/^https?:\/\//, "")}</span>
        </a>
        {editing ? (
          <form
            className="mt-4 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              patch.mutate({ ...f, tags: f.tags }, { onSuccess: () => setEditing(false) });
            }}
          >
            {field("name", "Name", <input className={inputClass} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />)}
            {field("summary", "Summary", <textarea className={textareaClass} rows={3} value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} />)}
            {field("tags", "Tags (comma separated)", <input className={inputClass} value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} />)}
            <div className="grid grid-cols-2 gap-3">
              {field("category", "Category", <input className={inputClass} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} />)}
              {field("pricing", "Pricing", <input className={inputClass} value={f.pricing} onChange={(e) => setF({ ...f, pricing: e.target.value })} placeholder="Freemium" />)}
            </div>
            {field("notes", "Notes (Markdown)", <textarea className={textareaClass} rows={6} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />)}
            <div className="flex gap-2">
              <Button size="sm" variant="primary" disabled={patch.isPending}>
                Save
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <>
            <p className="mt-3 text-[14px] leading-relaxed">{tool.summary || <span className="text-ink-3">No summary yet.</span>}</p>
            {tool.tags.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1">
                {tool.tags.map((g) => (
                  <Link key={g} to={`/tools?tag=${encodeURIComponent(g)}`} className="rounded-[5px] bg-subtle px-1.5 text-[12px] leading-5 text-ink-2 hover:text-ink">
                    {g}
                  </Link>
                ))}
              </div>
            )}
            <dl className="mt-4 grid grid-cols-[90px_1fr] gap-y-1.5 text-[13px]">
              <dt className="text-ink-3">Category</dt>
              <dd>{tool.category ?? "—"}</dd>
              <dt className="text-ink-3">Pricing</dt>
              <dd>{tool.pricing ?? "—"}</dd>
              <dt className="text-ink-3">Source</dt>
              <dd className="text-ink-2">
                <Source tool={tool} />
                {tool.research_task && (
                  <Link to={`/t/${tool.research_task.key}`} className="ml-1.5 text-accent hover:underline">
                    {tool.research_task.key}
                  </Link>
                )}
              </dd>
              <dt className="text-ink-3">Added</dt>
              <dd className="text-ink-2">
                {members.data?.find((m) => m.id === tool.created_by)?.name ?? "someone"} · {timeAgo(tool.created_at)}
              </dd>
            </dl>
            {tool.notes && (
              <div className="mt-4 rounded-lg bg-panel px-3 py-2 text-[13px]">
                <Markdown text={tool.notes} />
              </div>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => setEditing(true)}>
                Edit
              </Button>
              {hasPm && (
                <Button size="sm" onClick={() => research.mutate()} disabled={research.isPending || researching(tool)}>
                  <Sparkles size={13} /> {researching(tool) ? "Agent researching…" : "Ask agent to research"}
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => reread.mutate()} disabled={reread.isPending}>
                <RefreshCw size={13} className={cx(reread.isPending && "animate-spin")} /> Re-read site
              </Button>
            </div>
          </>
        )}
        {err && <p className="mt-3 text-[12px] text-danger">{(err as Error).message}</p>}
      </div>
      {canDelete(me, tool.created_by) && (
        <div className="flex shrink-0 justify-end border-t border-line px-4 py-2">
          <DeleteButton what="tool" name={tool.name} onDelete={() => api.del(`/api/tools/${tool.id}`)} onDone={() => (refresh(), onClose())} />
        </div>
      )}
    </aside>
  );
}

