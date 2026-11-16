import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Marked, type Tokens } from "marked";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Bot, Check, ChevronDown, Menu as MenuIcon, Search, X } from "lucide-react";
import { Link, useOutletContext } from "react-router";
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
          if (msg.type === "workspace") qc.invalidateQueries({ queryKey: ["me"] });
          if (msg.type === "members") qc.invalidateQueries({ queryKey: ["member-record"] });
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

const AVATAR_TONES = [
  "bg-[#e8f0fe] text-[#1f5fd6]",
  "bg-[#e6f6ec] text-[#16794a]",
  "bg-[#fdf0e1] text-[#b25b0b]",
  "bg-[#fde8ee] text-[#c0315a]",
  "bg-[#e3f5f6] text-[#0f7b80]",
  "bg-[#f0f0f2] text-[#4b4d52]",
];

/** People are round; agents are violet rounded squares with a bot glyph, everywhere. */
export function Avatar({ member, size = 20 }: { member: MemberRef | Member | null | undefined; size?: number }) {
  if (!member)
    return (
      <span
        className="inline-flex shrink-0 rounded-full border border-dashed border-line-strong"
        style={{ width: size, height: size }}
        title="Unassigned"
      />
    );
  const isAgent = member.kind === "agent";
  const tone = AVATAR_TONES[member.name.split("").reduce((a, ch) => a + ch.charCodeAt(0), 0) % AVATAR_TONES.length];
  const radius = isAgent ? (size > 24 ? "rounded-lg" : "rounded-[5px]") : "rounded-full";
  return (
    <span className="relative inline-flex shrink-0" title={`${member.name}${isAgent ? " (agent)" : ""}`} style={{ width: size, height: size }}>
      {member.avatar_url ? (
        <img src={member.avatar_url} alt="" className={cx("h-full w-full object-cover", radius)} referrerPolicy="no-referrer" />
      ) : (
        <span
          className={cx("flex h-full w-full items-center justify-center font-semibold", radius, isAgent ? "bg-agent text-white" : tone)}
          style={{ fontSize: Math.max(9, size * 0.44) }}
        >
          {isAgent ? <Bot size={size * 0.62} strokeWidth={2} /> : member.name.slice(0, 1).toUpperCase()}
        </span>
      )}
    </span>
  );
}

/** Workspace logo, or its first letter when there's no logo. */
export function WorkspaceLogo({ name, logoUrl, size = 24 }: { name: string; logoUrl: string | null | undefined; size?: number }) {
  const [broken, setBroken] = useState(false);
  const radius = size > 28 ? "rounded-[10px]" : "rounded-md";
  if (logoUrl && !broken)
    return (
      <span className={cx("inline-flex shrink-0 items-center justify-center overflow-hidden border border-line bg-canvas", radius)} style={{ width: size, height: size }}>
        <img src={logoUrl} alt="" className="h-full w-full object-contain" onError={() => setBroken(true)} />
      </span>
    );
  return (
    <span
      className={cx("inline-flex shrink-0 items-center justify-center bg-ink font-semibold text-canvas", radius)}
      style={{ width: size, height: size, fontSize: size * 0.48 }}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function AgentBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-[5px] bg-agent-soft px-1.5 py-px text-[11px] font-medium text-agent">
      <Bot size={11} strokeWidth={2.2} /> Agent
    </span>
  );
}

/** A member reference rendered like an Attio record chip: avatar + name. */
export function MemberChip({ member, size = 18, muted }: { member: MemberRef | Member | null | undefined; size?: number; muted?: boolean }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Avatar member={member} size={size} />
      <span className={cx("truncate", !member && "text-ink-3", muted && "text-ink-2")}>{member?.name ?? "Unassigned"}</span>
    </span>
  );
}

// ---------- Tags ----------

export type Tone = "gray" | "blue" | "green" | "amber" | "orange" | "red" | "violet" | "teal" | "pink";
const TONES: Record<Tone, string> = {
  gray: "bg-[#f0f0f2] text-[#4b4d52] dark:bg-white/8 dark:text-[#c4c6cc]",
  blue: "bg-[#e8f0fe] text-[#1f5fd6] dark:bg-[#4d86f0]/15 dark:text-[#8db1f5]",
  green: "bg-[#e6f6ec] text-[#16794a] dark:bg-[#3fb27f]/15 dark:text-[#7dd3a8]",
  amber: "bg-[#fdf5dc] text-[#946200] dark:bg-[#e5b53a]/15 dark:text-[#ecc76a]",
  orange: "bg-[#fdf0e1] text-[#b25b0b] dark:bg-[#f08c3a]/15 dark:text-[#f5ac6e]",
  red: "bg-[#fde9e8] text-[#c4312b] dark:bg-[#ef5350]/15 dark:text-[#f28b88]",
  violet: "bg-agent-soft text-agent",
  teal: "bg-[#e3f5f6] text-[#0f7b80] dark:bg-[#2fb5bb]/15 dark:text-[#72d1d5]",
  pink: "bg-[#fde8ee] text-[#c0315a] dark:bg-[#ec5c86]/15 dark:text-[#f190ac]",
};

export function Tag({ tone = "gray", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cx("inline-flex h-[22px] max-w-full items-center gap-1 rounded-[6px] px-1.5 text-[12px] font-medium whitespace-nowrap", TONES[tone], className)}>
      {children}
    </span>
  );
}

/** Deterministic colour for a project tag. */
export function projectTone(id: string): Tone {
  const tones: Tone[] = ["blue", "green", "amber", "pink", "teal", "orange"];
  return tones[id.split("").reduce((a, ch) => a + ch.charCodeAt(0), 0) % tones.length];
}

export const STATUS_TONE: Record<Status, Tone> = {
  backlog: "gray",
  todo: "gray",
  in_progress: "blue",
  waiting_on_human: "orange",
  done: "green",
  canceled: "gray",
};

const STATUS_COLOR: Record<Status, string> = {
  backlog: "#a3a5ab",
  todo: "#7c7e85",
  in_progress: "#2b6feb",
  waiting_on_human: "#e5791d",
  done: "#1f9d5c",
  canceled: "#a3a5ab",
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

export function StatusTag({ status }: { status: Status }) {
  return (
    <Tag tone={STATUS_TONE[status]}>
      <StatusIcon status={status} size={12} />
      {STATUS_LABEL[status]}
    </Tag>
  );
}

export function PriorityIcon({ priority, size = 14 }: { priority: Priority; size?: number }) {
  if (priority === "urgent")
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-label="Urgent" className="shrink-0">
        <rect x="1.5" y="1.5" width="13" height="13" rx="3.5" fill="#e5543d" />
        <path d="M8 4.5v4.5M8 11.2v.3" stroke="white" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  const bars = { none: 0, low: 1, medium: 2, high: 3 }[priority];
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-label={PRIORITY_LABEL[priority]} className="shrink-0">
      {priority === "none" ? (
        <path d="M3 8h2M7 8h2M11 8h2" stroke="var(--c-ink-3)" strokeWidth="1.6" strokeLinecap="round" />
      ) : (
        [0, 1, 2].map((i) => (
          <rect key={i} x={2.5 + i * 4} y={10 - i * 3} width="3" height={4 + i * 3} rx="1" fill={i < bars ? "var(--c-ink-2)" : "var(--c-line-strong)"} />
        ))
      )}
    </svg>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border border-line-strong bg-canvas px-1 font-sans text-[11px] text-ink-3">
      {children}
    </kbd>
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
  width = "w-60",
}: {
  trigger: ReactNode;
  options: { value: T; label: string; icon?: ReactNode; hint?: ReactNode }[];
  value?: T | null;
  onChange: (v: T) => void;
  searchable?: boolean;
  align?: "left" | "right";
  width?: string;
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
    <div className="relative min-w-0" ref={ref}>
      <button
        type="button"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          setOpen((o) => !o);
          setQ("");
        }}
        className="flex max-w-full min-w-0 items-center rounded-md text-left"
      >
        {trigger}
      </button>
      {open && (
        <div
          className={cx(
            "absolute z-50 mt-1 max-h-80 overflow-auto rounded-[10px] bg-canvas p-1 shadow-pop",
            width,
            align === "right" ? "right-0" : "left-0",
          )}
          onClick={(e) => e.stopPropagation()}
        >
          {searchable && (
            <div className="mb-1 flex items-center gap-1.5 border-b border-line px-2 pb-1.5 pt-1">
              <Search size={13} className="text-ink-3" />
              <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="w-full bg-transparent text-[13px] outline-none" />
            </div>
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
              className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-hover"
            >
              {o.icon}
              <span className="flex-1 truncate">{o.label}</span>
              {o.hint && <span className="text-[12px] text-ink-3">{o.hint}</span>}
              {value === o.value && <Check size={14} className="text-accent" />}
            </button>
          ))}
          {!filtered.length && <div className="px-2 py-1.5 text-[13px] text-ink-3">No matches</div>}
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
      .map((m) => ({
        value: m.id,
        label: m.name,
        icon: <Avatar member={m} size={16} />,
        hint: m.kind === "agent" ? <span className="text-agent">Agent</span> : undefined,
      })),
  ];
}

// ---------- Buttons, inputs, modals ----------

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
};

export function Button({ children, variant = "secondary", size = "md", className, ...props }: ButtonProps) {
  return (
    <button
      {...props}
      className={cx(
        "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50",
        size === "sm" ? "h-7 px-2 text-[12px]" : "h-8 px-2.5 text-[13px]",
        variant === "primary" && "bg-accent text-white shadow-btn hover:bg-accent-hover",
        variant === "secondary" && "border border-line-strong bg-canvas text-ink shadow-btn hover:bg-hover",
        variant === "ghost" && "text-ink-2 hover:bg-hover hover:text-ink",
        variant === "danger" && "border border-line-strong bg-canvas text-[#c4312b] shadow-btn hover:bg-[#fde9e8] dark:text-[#f28b88] dark:hover:bg-[#ef5350]/10",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function IconButton({ label, children, className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...props}
      className={cx("inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-hover hover:text-ink", className)}
    >
      {children}
    </button>
  );
}

export function Modal({
  open,
  onClose,
  children,
  wide,
  title,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  title?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-[rgba(16,24,40,0.28)] px-4 pt-[10vh] dark:bg-black/60" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal
        className={cx("w-full overflow-hidden rounded-xl bg-canvas shadow-pop", wide ? "max-w-2xl" : "max-w-md")}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="flex h-12 items-center gap-2 border-b border-line px-4 text-[14px] font-semibold">
            {title}
            <IconButton label="Close" className="ml-auto" onClick={onClose}>
              <X size={16} />
            </IconButton>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

export function ModalFooter({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-t border-line bg-panel px-4 py-3">
      <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3">{hint}</span>
      {children}
    </div>
  );
}

export const inputClass =
  "w-full h-8 rounded-lg border border-line-strong bg-canvas px-2.5 text-[13px] shadow-btn outline-none placeholder:text-ink-3 focus:border-accent focus:ring-3 focus:ring-[var(--c-focus)]";
export const textareaClass =
  "w-full rounded-lg border border-line-strong bg-canvas px-2.5 py-2 text-[13px] shadow-btn outline-none placeholder:text-ink-3 focus:border-accent focus:ring-3 focus:ring-[var(--c-focus)]";

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[12px] text-ink-3">{hint}</span>}
    </label>
  );
}

/** Small chip button used in toolbars and for picking attributes ("Status: Todo"). */
export function Chip({ children, active, className }: { children: ReactNode; active?: boolean; className?: string }) {
  return (
    <span
      className={cx(
        "inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-lg border px-2 text-[12px] font-medium whitespace-nowrap",
        active ? "border-accent/30 bg-accent-soft text-accent" : "border-line-strong bg-canvas text-ink-2 shadow-btn hover:bg-hover",
        className,
      )}
    >
      {children}
    </span>
  );
}

// ---------- Page chrome ----------

export interface ShellContext {
  openNav: () => void;
  openSearch: () => void;
  createTask: () => void;
}
export const useShell = () => useOutletContext<ShellContext>();

/** Breadcrumb bar at the top of every page. */
export function TopBar({ crumbs, actions }: { crumbs: { label: ReactNode; to?: string; icon?: ReactNode }[]; actions?: ReactNode }) {
  const shell = useShell();
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3 md:px-5">
      <IconButton label="Open navigation" className="md:hidden" onClick={shell?.openNav}>
        <MenuIcon size={16} />
      </IconButton>
      <nav className="flex min-w-0 items-center gap-1 text-[14px]">
        {crumbs.map((c, i) => (
          <span key={i} className="flex min-w-0 items-center gap-1">
            {i > 0 && <span className="px-0.5 text-ink-3">/</span>}
            {c.to ? (
              <Link to={c.to} className="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-ink-2 hover:bg-hover hover:text-ink">
                {c.icon}
                <span className="truncate">{c.label}</span>
              </Link>
            ) : (
              <span className="flex min-w-0 items-center gap-1.5 px-1.5 py-1 font-medium">
                {c.icon}
                <span className="truncate">{c.label}</span>
              </span>
            )}
          </span>
        ))}
      </nav>
      <div className="ml-auto flex items-center gap-2">{actions}</div>
    </header>
  );
}

/** Underlined tabs, Attio record-page style. */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  className,
}: {
  tabs: { value: T; label: string; icon?: ReactNode; count?: number }[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div role="tablist" className={cx("flex items-end gap-4 overflow-x-auto border-b border-line px-4 md:px-6", className)}>
      {tabs.map((t) => (
        <button
          key={t.value}
          role="tab"
          aria-selected={value === t.value}
          onClick={() => onChange(t.value)}
          className={cx(
            "-mb-px flex h-10 shrink-0 items-center gap-1.5 border-b-2 text-[13px] font-medium",
            value === t.value ? "border-ink text-ink" : "border-transparent text-ink-3 hover:text-ink-2",
          )}
        >
          {t.icon}
          {t.label}
          {t.count !== undefined && t.count > 0 && (
            <span className="rounded-[5px] bg-active px-1.5 text-[11px] leading-[18px] text-ink-2">{t.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-16 text-center">
      {icon && <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-panel text-ink-3 shadow-card">{icon}</div>}
      <div className="text-[14px] font-medium">{title}</div>
      {children && <div className="mt-1 max-w-sm text-[13px] text-ink-3">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** Attribute row on a record page: grey label on the left, editable value on the right. */
export function AttrRow({ icon, label, children }: { icon?: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-9 items-center gap-2">
      <span className="flex w-28 shrink-0 items-center gap-2 text-[13px] text-ink-3">
        {icon}
        {label}
      </span>
      <div className="min-w-0 flex-1 text-[13px]">{children}</div>
    </div>
  );
}

/** Hover target used as the trigger inside an AttrRow. */
export const attrValue = "flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-md px-1.5 hover:bg-hover";

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <h2 className="text-[13px] font-semibold text-ink">{children}</h2>
      <div className="ml-auto">{action}</div>
    </div>
  );
}

export { ChevronDown };
