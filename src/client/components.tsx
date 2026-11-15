import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Marked, type Tokens } from "marked";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  type Me,
  type Member,
  type MemberRef,
  type Priority,
  type Project,
  type Status,
  PRIORITY_LABEL,
  STATUS_LABEL,
  api,
} from "./api";

// ---------- Data hooks ----------

export const useMe = () => useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/me") });
export const useMembers = () => useQuery({ queryKey: ["members"], queryFn: () => api.get<Member[]>("/api/members") });
export const useProjects = () => useQuery({ queryKey: ["projects"], queryFn: () => api.get<Project[]>("/api/projects") });

/** One websocket per tab; server events just invalidate the matching queries. */
export function useRealtime(enabled: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 0;
    let ping: ReturnType<typeof setInterval>;
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => {
        retry = 0;
        ping = setInterval(() => ws?.readyState === 1 && ws.send("ping"), 25_000);
      };
      ws.onmessage = (ev) => {
        if (ev.data === "pong") return;
        try {
          const msg = JSON.parse(ev.data) as { type: string; task_id?: string };
          qc.invalidateQueries({ queryKey: ["tasks"] });
          qc.invalidateQueries({ queryKey: ["inbox"] });
          if (msg.task_id) qc.invalidateQueries({ queryKey: ["task"] });
          if (msg.type === "members") qc.invalidateQueries({ queryKey: ["members"] });
          if (msg.type === "projects") qc.invalidateQueries({ queryKey: ["projects"] });
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        clearInterval(ping);
        if (closed) return;
        retry = Math.min(retry + 1, 6);
        setTimeout(connect, 500 * 2 ** retry);
      };
    };
    connect();
    return () => {
      closed = true;
      clearInterval(ping);
      ws?.close();
    };
  }, [enabled, qc]);
}

// ---------- Small UI ----------

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

const AVATAR_COLORS = ["bg-rose-500", "bg-amber-500", "bg-emerald-500", "bg-sky-500", "bg-violet-500", "bg-pink-500", "bg-teal-500"];

export function Avatar({ member, size = 20 }: { member: MemberRef | Member | null | undefined; size?: number }) {
  if (!member)
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center rounded-full border border-dashed border-zinc-300 dark:border-zinc-600"
        style={{ width: size, height: size }}
        title="Unassigned"
      />
    );
  const color = AVATAR_COLORS[member.name.split("").reduce((a, ch) => a + ch.charCodeAt(0), 0) % AVATAR_COLORS.length];
  const isAgent = member.kind === "agent";
  return (
    <span className="relative inline-flex shrink-0" title={`${member.name}${isAgent ? " (agent)" : ""}`} style={{ width: size, height: size }}>
      {member.avatar_url ? (
        <img
          src={member.avatar_url}
          alt=""
          className={cx("h-full w-full object-cover", isAgent ? "rounded-md" : "rounded-full")}
          referrerPolicy="no-referrer"
        />
      ) : (
        <span
          className={cx(
            "flex h-full w-full items-center justify-center font-semibold text-white",
            isAgent ? "rounded-md bg-zinc-800 dark:bg-zinc-200 dark:text-zinc-900" : cx("rounded-full", color),
          )}
          style={{ fontSize: size * 0.45 }}
        >
          {isAgent ? <BotGlyph size={size * 0.62} /> : member.name.slice(0, 1).toUpperCase()}
        </span>
      )}
    </span>
  );
}

export function BotGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <rect x="2.5" y="5" width="11" height="8" rx="2.2" />
      <path d="M8 2.2V5M5.8 8.6v.8M10.2 8.6v.8" strokeLinecap="round" />
    </svg>
  );
}

export function AgentBadge() {
  return (
    <span className="inline-flex items-center gap-0.5 rounded bg-zinc-100 px-1 py-px text-[10px] font-medium uppercase tracking-wide text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
      Agent
    </span>
  );
}

const STATUS_COLOR: Record<Status, string> = {
  backlog: "#a1a1aa",
  todo: "#71717a",
  in_progress: "#eab308",
  waiting_on_human: "#f97316",
  done: "#5b5bd6",
  canceled: "#a1a1aa",
};

export function StatusIcon({ status, size = 14 }: { status: Status; size?: number }) {
  const c = STATUS_COLOR[status];
  const r = 6;
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-label={STATUS_LABEL[status]} className="shrink-0">
      {status === "backlog" && <circle cx="8" cy="8" r={r} fill="none" stroke={c} strokeWidth="1.6" strokeDasharray="2.2 2" />}
      {status === "todo" && <circle cx="8" cy="8" r={r} fill="none" stroke={c} strokeWidth="1.6" />}
      {status === "in_progress" && (
        <>
          <circle cx="8" cy="8" r={r} fill="none" stroke={c} strokeWidth="1.6" />
          <path d={`M8 8 L8 ${8 - 3.6} A3.6 3.6 0 0 1 8 ${8 + 3.6} Z`} fill={c} />
        </>
      )}
      {status === "waiting_on_human" && (
        <>
          <circle cx="8" cy="8" r={r} fill="none" stroke={c} strokeWidth="1.6" />
          <path d="M8 4.8v3.6M8 10.6v.2" stroke={c} strokeWidth="1.8" strokeLinecap="round" />
        </>
      )}
      {status === "done" && (
        <>
          <circle cx="8" cy="8" r={r + 0.8} fill={c} />
          <path d="M5.2 8.2l1.9 1.9 3.7-3.9" fill="none" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
      {status === "canceled" && (
        <>
          <circle cx="8" cy="8" r={r + 0.8} fill={c} />
          <path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" stroke="white" strokeWidth="1.6" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

export function PriorityIcon({ priority, size = 14 }: { priority: Priority; size?: number }) {
  if (priority === "urgent")
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-label="Urgent" className="shrink-0">
        <rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="#f97316" />
        <path d="M8 4.5v4.5M8 11.2v.3" stroke="white" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  const bars = { none: 0, low: 1, medium: 2, high: 3 }[priority];
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-label={PRIORITY_LABEL[priority]} className="shrink-0">
      {priority === "none" ? (
        <path d="M3 8h2M7 8h2M11 8h2" stroke="#a1a1aa" strokeWidth="1.6" strokeLinecap="round" />
      ) : (
        [0, 1, 2].map((i) => (
          <rect
            key={i}
            x={2.5 + i * 4}
            y={10 - i * 3}
            width="3"
            height={4 + i * 3}
            rx="1"
            className={i < bars ? "fill-zinc-600 dark:fill-zinc-300" : "fill-zinc-200 dark:fill-zinc-700"}
          />
        ))
      )}
    </svg>
  );
}

export function timeAgo(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ---------- Markdown ----------

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const md = new Marked({ gfm: true, breaks: true });
md.use({
  renderer: {
    html({ text }: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(text);
    },
    link(token: Tokens.Link) {
      const { href } = token;
      const inner = this.parser.parseInline(token.tokens);
      if (href.startsWith("mention:")) return `<span class="mention">${inner}</span>`;
      if (!/^(https?:|mailto:|\/)/i.test(href)) return inner;
      return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
    },
    image({ href, text }: Tokens.Image) {
      if (!/^(https?:|\/)/i.test(href)) return "";
      return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}" loading="lazy">`;
    },
  },
});

export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => {
    const withMentions = text.replace(/(^|[^\w@[])@([a-z0-9][a-z0-9_-]*)/gi, "$1[@$2](mention:$2)");
    return md.parse(withMentions, { async: false }) as string;
  }, [text]);
  return <div className={cx("md", className)} dangerouslySetInnerHTML={{ __html: html }} />;
}

// ---------- Popover menu ----------

export function Menu<T extends string>({
  trigger,
  options,
  value,
  onChange,
  searchable,
  align = "left",
}: {
  trigger: ReactNode;
  options: { value: T; label: string; icon?: ReactNode; hint?: string }[];
  value?: T | null;
  onChange: (v: T) => void;
  searchable?: boolean;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const filtered = options.filter((o) => !q || o.label.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          setOpen((o) => !o);
          setQ("");
        }}
        className="flex items-center"
      >
        {trigger}
      </button>
      {open && (
        <div
          className={cx(
            "absolute z-50 mt-1 max-h-80 w-60 overflow-auto rounded-lg border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-800 dark:bg-zinc-900",
            align === "right" ? "right-0" : "left-0",
          )}
          onClick={(e) => e.stopPropagation()}
        >
          {searchable && (
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search…"
              className="mb-1 w-full rounded-md border-0 bg-zinc-100 px-2 py-1.5 text-sm outline-none dark:bg-zinc-800"
            />
          )}
          {filtered.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={(e) => {
                e.preventDefault();
                onChange(o.value);
                setOpen(false);
              }}
              className={cx(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800",
                value === o.value && "bg-zinc-100 dark:bg-zinc-800",
              )}
            >
              {o.icon}
              <span className="flex-1 truncate">{o.label}</span>
              {o.hint && <span className="text-xs text-zinc-400">{o.hint}</span>}
            </button>
          ))}
          {!filtered.length && <div className="px-2 py-1.5 text-sm text-zinc-400">No matches</div>}
        </div>
      )}
    </div>
  );
}

export function assigneeOptions(members: Member[] | undefined) {
  return [
    { value: "none", label: "Unassigned", icon: <Avatar member={null} size={16} /> },
    ...(members ?? [])
      .filter((m) => m.active)
      .map((m) => ({ value: m.id, label: m.name, icon: <Avatar member={m} size={16} />, hint: m.kind === "agent" ? "agent" : undefined })),
  ];
}

export function Button({
  children,
  variant = "secondary",
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" }) {
  return (
    <button
      {...props}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors disabled:opacity-50",
        variant === "primary" && "bg-accent text-white hover:bg-accent-hover",
        variant === "secondary" &&
          "border border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800",
        variant === "ghost" && "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800",
        variant === "danger" && "text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Modal({ open, onClose, children, wide }: { open: boolean; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 px-4 pt-[12vh] dark:bg-black/60" onMouseDown={onClose}>
      <div
        className={cx(
          "w-full rounded-xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-900",
          wide ? "max-w-2xl" : "max-w-md",
        )}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

export const inputClass =
  "w-full rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-accent dark:border-zinc-800 dark:bg-zinc-950";
