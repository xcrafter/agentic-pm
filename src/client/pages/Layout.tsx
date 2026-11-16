import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Building2,
  ChevronsUpDown,
  CircleUser,
  FolderKanban,
  Inbox as InboxIcon,
  ListTodo,
  LogOut,
  Plus,
  Search,
  Users,
  Settings,
  Layers,
  Megaphone,
  BarChart3,
  Lightbulb,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { type Inbox, type Task, api } from "../api";
import {
  Avatar,
  Button,
  Kbd,
  type ShellContext,
  StatusIcon,
  cx,
  inputClass,
  projectTone,
  useMe,
  useMembers,
  useProjects,
  useRealtime,
  useSavedViews,
  WorkspaceLogo,
} from "../components";
import { CreateTaskModal } from "./CreateTask";

export function Layout() {
  const me = useMe();
  const signedIn = !!me.data?.member;
  useRealtime(signedIn);
  const [creating, setCreating] = useState(false);
  const [searching, setSearching] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const loc = useLocation();

  useEffect(() => setNavOpen(false), [loc.pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearching((s) => !s);
        return;
      }
      const t = e.target as HTMLElement;
      if (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)) return;
      if (e.key === "c" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setCreating(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  if (me.isLoading) return <div className="p-8 text-ink-3">Loading…</div>;
  if (!signedIn) return <Login google={!!me.data?.auth.google} setup={!!me.data?.auth.setup} />;

  const projectMatch = /^\/projects\/([^/]+)/.exec(loc.pathname);
  const shell: ShellContext = {
    openNav: () => setNavOpen(true),
    openSearch: () => setSearching(true),
    createTask: () => setCreating(true),
  };
  return (
    <div className="flex h-full bg-canvas">
      <div className="hidden md:flex">
        <Sidebar shell={shell} />
      </div>
      {navOpen && (
        <div className="fixed inset-0 z-40 flex md:hidden" onClick={() => setNavOpen(false)}>
          <div className="absolute inset-0 bg-[rgba(16,24,40,0.28)]" />
          <div className="relative flex shadow-pop" onClick={(e) => e.stopPropagation()}>
            <Sidebar shell={shell} />
          </div>
        </div>
      )}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Outlet context={shell} />
      </main>
      <CreateTaskModal open={creating} onClose={() => setCreating(false)} defaultProjectId={projectMatch?.[1]} />
      {searching && <CommandPalette onClose={() => setSearching(false)} onCreate={() => (setSearching(false), setCreating(true))} />}
    </div>
  );
}

function NavItem({ to, icon, children, end, badge }: { to: string; icon: ReactNode; children: ReactNode; end?: boolean; badge?: number }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cx(
          "flex h-8 items-center gap-2 rounded-md px-2 text-[13px] font-medium",
          isActive ? "bg-active text-ink" : "text-ink-2 hover:bg-hover hover:text-ink",
        )
      }
    >
      <span className="flex w-4 justify-center text-ink-3">{icon}</span>
      <span className="truncate">{children}</span>
      {!!badge && <span className="ml-auto rounded-[5px] bg-[#e5791d] px-1.5 text-[11px] leading-[18px] font-semibold text-white">{badge}</span>}
    </NavLink>
  );
}

function Sidebar({ shell }: { shell: ShellContext }) {
  const me = useMe().data!;
  const projects = useProjects();
  const views = useSavedViews();
  const location = useLocation();
  const inbox = useQuery({ queryKey: ["inbox"], queryFn: () => api.get<Inbox>("/api/inbox") });
  const inboxCount = (inbox.data?.questions.length ?? 0) + (inbox.data?.runs.length ?? 0) + (inbox.data?.mentions.length ?? 0);
  const qc = useQueryClient();
  const nav = useNavigate();
  const [userMenu, setUserMenu] = useState(false);

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-line bg-panel">
      <div className="px-3 pt-3">
        <button
          onClick={() => nav("/workspace")}
          className="flex h-9 w-full items-center gap-2 rounded-lg px-1.5 text-left hover:bg-hover"
          title="Open the workspace record"
        >
          <WorkspaceLogo name={me.workspace?.name ?? ""} logoUrl={me.workspace?.logo_url} size={24} />
          <span className="flex-1 truncate text-[14px] font-semibold">{me.workspace?.name}</span>
        </button>
        <div className="mt-2 flex flex-col gap-0.5">
          <button onClick={shell.openSearch} className="flex h-8 items-center gap-2 rounded-md px-2 text-[13px] font-medium text-ink-2 hover:bg-hover hover:text-ink">
            <Search size={15} className="text-ink-3" /> Search
            <span className="ml-auto flex gap-0.5">
              <Kbd>⌘</Kbd>
              <Kbd>K</Kbd>
            </span>
          </button>
          <button onClick={shell.createTask} className="flex h-8 items-center gap-2 rounded-md px-2 text-[13px] font-medium text-ink-2 hover:bg-hover hover:text-ink">
            <Plus size={15} className="text-ink-3" /> New task
            <span className="ml-auto">
              <Kbd>C</Kbd>
            </span>
          </button>
        </div>
      </div>

      <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-3">
        <nav className="flex flex-col gap-0.5">
          <NavItem to="/inbox" icon={<InboxIcon size={15} />} badge={inboxCount}>
            Needs you
          </NavItem>
          <NavItem to="/feed" icon={<Megaphone size={15} />}>
            Feed
          </NavItem>
          <NavItem to="/my" icon={<CircleUser size={15} />}>
            My tasks
          </NavItem>
          <NavItem to="/ideas" icon={<Lightbulb size={15} />}>
            Ideas
          </NavItem>
          <NavItem to="/" end icon={<ListTodo size={15} />}>
            All tasks
          </NavItem>
        </nav>

        <div className="mt-5 mb-1 px-2 text-[12px] font-medium text-ink-3">Team</div>
        <nav className="flex flex-col gap-0.5">
          <NavItem to="/workspace" icon={<Building2 size={15} />}>
            Overview
          </NavItem>
          <NavItem to="/team" icon={<Users size={15} />}>
            Members & agents
          </NavItem>
          <NavItem to="/reports" icon={<BarChart3 size={15} />}>
            Reports
          </NavItem>
          <NavItem to="/projects" end icon={<FolderKanban size={15} />}>
            Projects
          </NavItem>
          <NavItem to="/settings" icon={<Settings size={15} />}>
            Workspace settings
          </NavItem>
        </nav>

        {!!views.data?.length && (
          <>
            <div className="mt-5 mb-1 px-2 text-[12px] font-medium text-ink-3">Views</div>
            <nav className="flex flex-col gap-0.5">
              {views.data.map((v) => {
                const active = location.pathname === "/" && new URLSearchParams(location.search).get("view") === v.id;
                return (
                  <Link
                    key={v.id}
                    to={`/?view=${v.id}`}
                    aria-current={active ? "page" : undefined}
                    className={cx(
                      "flex h-8 items-center gap-2 rounded-md px-2 text-[13px] font-medium",
                      active ? "bg-active text-ink" : "text-ink-2 hover:bg-hover hover:text-ink",
                    )}
                  >
                    <span className="flex w-4 justify-center text-ink-3">
                      <Layers size={14} />
                    </span>
                    <span className="truncate">{v.name}</span>
                  </Link>
                );
              })}
            </nav>
          </>
        )}

        {!!projects.data?.filter((p) => p.status === "active").length && (
          <>
            <div className="mt-5 mb-1 px-2 text-[12px] font-medium text-ink-3">Projects</div>
            <nav className="flex flex-col gap-0.5">
              {projects.data
                .filter((p) => p.status === "active")
                .map((p) => (
                  <NavItem key={p.id} to={`/projects/${p.id}`} icon={<ProjectDot id={p.id} />}>
                    {p.name}
                  </NavItem>
                ))}
            </nav>
          </>
        )}
      </div>

      <div className="relative border-t border-line p-3">
        <button onClick={() => setUserMenu((o) => !o)} className="flex h-9 w-full items-center gap-2 rounded-lg px-1.5 text-left hover:bg-hover">
          <Avatar member={me.member} size={22} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium">{me.member?.name}</span>
          </span>
          <ChevronsUpDown size={14} className="text-ink-3" />
        </button>
        {userMenu && (
          <div className="absolute right-3 bottom-14 left-3 z-50 rounded-[10px] bg-canvas p-1 shadow-pop">
            <button
              onClick={() => nav(`/team/${me.member!.handle}`)}
              className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-[13px] hover:bg-hover"
            >
              <CircleUser size={14} className="text-ink-3" /> My profile
            </button>
            <button
              onClick={async () => {
                await api.post("/auth/logout");
                qc.invalidateQueries();
              }}
              className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-[13px] hover:bg-hover"
            >
              <LogOut size={14} className="text-ink-3" /> Sign out
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}

export function ProjectDot({ id, size = 10 }: { id: string; size?: number }) {
  const colors: Record<string, string> = {
    blue: "#2b6feb",
    green: "#1f9d5c",
    amber: "#d49b00",
    pink: "#d9467a",
    teal: "#1a9aa0",
    orange: "#e5791d",
  };
  return <span className="inline-block shrink-0 rounded-[3px]" style={{ width: size, height: size, background: colors[projectTone(id)] }} />;
}

// ---------- ⌘K ----------

interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  run: () => void;
}

function CommandPalette({ onClose, onCreate }: { onClose: () => void; onCreate: () => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const nav = useNavigate();
  const members = useMembers();
  const projects = useProjects();
  const tasks = useQuery({
    queryKey: ["tasks", "search", q],
    queryFn: () => api.get<Task[]>(`/api/tasks?${new URLSearchParams(q ? { q } : {})}`),
    staleTime: 5_000,
  });
  const go = (to: string) => () => (onClose(), nav(to));
  const items = useMemo<PaletteItem[]>(() => {
    const match = (s: string) => !q || s.toLowerCase().includes(q.toLowerCase());
    const pages: PaletteItem[] = [
      { id: "new", label: "Create task", icon: <Plus size={15} />, run: onCreate },
      { id: "inbox", label: "Needs you", icon: <InboxIcon size={15} />, run: go("/inbox") },
      { id: "my", label: "My tasks", icon: <CircleUser size={15} />, run: go("/my") },
      { id: "all", label: "All tasks", icon: <ListTodo size={15} />, run: go("/") },
      { id: "ws", label: "Team overview", icon: <Building2 size={15} />, run: go("/workspace") },
      { id: "settings", label: "Workspace settings", icon: <Settings size={15} />, run: go("/settings") },
      { id: "feed", label: "Feed", icon: <Megaphone size={15} />, run: go("/feed") },
      { id: "ideas", label: "Ideas", icon: <Lightbulb size={15} />, run: go("/ideas") },
      { id: "reports", label: "Reports", icon: <BarChart3 size={15} />, run: go("/reports") },
      { id: "team", label: "Members & agents", icon: <Users size={15} />, run: go("/team") },
      { id: "projects", label: "Projects", icon: <FolderKanban size={15} />, run: go("/projects") },
    ].filter((p) => match(p.label));
    const ppl: PaletteItem[] = (members.data ?? [])
      .filter((m) => m.active && (match(m.name) || match(m.handle)))
      .slice(0, 5)
      .map((m) => ({ id: m.id, label: m.name, hint: m.kind === "agent" ? "Agent" : "Person", icon: <Avatar member={m} size={16} />, run: go(`/team/${m.handle}`) }));
    const prj: PaletteItem[] = (projects.data ?? [])
      .filter((p) => match(p.name))
      .slice(0, 4)
      .map((p) => ({ id: p.id, label: p.name, hint: "Project", icon: <ProjectDot id={p.id} />, run: go(`/projects/${p.id}`) }));
    const tsk: PaletteItem[] = (tasks.data ?? [])
      .slice(0, 8)
      .map((t) => ({ id: t.id, label: t.title, hint: t.key, icon: <StatusIcon status={t.status} />, run: go(`/t/${t.key}`) }));
    return [...tsk, ...ppl, ...prj, ...pages];
  }, [q, members.data, projects.data, tasks.data]);
  useEffect(() => setSel(0), [q]);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-[rgba(16,24,40,0.28)] px-4 pt-[12vh] dark:bg-black/60" onMouseDown={onClose}>
      <div className="w-full max-w-xl overflow-hidden rounded-xl bg-canvas shadow-pop" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex h-12 items-center gap-2 border-b border-line px-4">
          <Search size={16} className="text-ink-3" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (e.key === "ArrowDown") (e.preventDefault(), setSel((s) => Math.min(s + 1, items.length - 1)));
              if (e.key === "ArrowUp") (e.preventDefault(), setSel((s) => Math.max(s - 1, 0)));
              if (e.key === "Enter") items[sel]?.run();
            }}
            placeholder="Search tasks, people, projects…"
            className="h-full flex-1 bg-transparent text-[14px] outline-none placeholder:text-ink-3"
          />
          <Kbd>esc</Kbd>
        </div>
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto p-1.5">
          {items.map((it, i) => (
            <button
              key={it.id}
              data-i={i}
              onMouseMove={() => setSel(i)}
              onClick={it.run}
              className={cx("flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px]", i === sel && "bg-hover")}
            >
              <span className="flex w-4 justify-center text-ink-3">{it.icon}</span>
              <span className="min-w-0 flex-1 truncate">{it.label}</span>
              {it.hint && <span className="text-[12px] text-ink-3">{it.hint}</span>}
            </button>
          ))}
          {!items.length && <div className="px-3 py-6 text-center text-[13px] text-ink-3">Nothing matches “{q}”.</div>}
        </div>
      </div>
    </div>
  );
}

// ---------- Sign-in ----------

/** Where to go after signing in: ?next=… (e.g. back to an MCP consent screen) or the current page. */
function afterSignIn() {
  const next = new URLSearchParams(location.search).get("next");
  const safe = next && next.startsWith("/") && !next.startsWith("//") ? next : location.pathname;
  location.assign(safe);
}

export function AuthCard({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  const brand = useMe().data?.brand;
  return (
    <div className="flex min-h-full items-center justify-center bg-panel px-4 py-10">
      <div className="w-full max-w-[380px]">
        <div className="mb-6">
          <WorkspaceLogo name={brand?.name ?? "A"} logoUrl={brand?.logo_url} size={36} />
        </div>
        <h1 className="text-[22px] font-semibold tracking-[-0.015em]">{title}</h1>
        <p className="mt-1.5 mb-7 text-[14px] leading-relaxed text-ink-2">{subtitle}</p>
        {children}
      </div>
    </div>
  );
}

export function AuthField({ label, ...props }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="mb-4 block">
      <span className="mb-1.5 block text-[13px] font-medium">{label}</span>
      <input {...props} className={cx(inputClass, "h-9")} />
    </label>
  );
}

function Login({ google, setup }: { google: boolean; setup: boolean }) {
  const brandName = useMe().data?.brand.name ?? "Agentic PM";
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const next = encodeURIComponent(new URLSearchParams(location.search).get("next") ?? location.pathname);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(setup ? "/auth/setup" : "/auth/login", setup ? { name, email, password } : { email, password });
      afterSignIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
      setBusy(false);
    }
  };

  return (
    <AuthCard
      title={setup ? "Set up your workspace" : `Sign in to ${brandName}`}
      subtitle={
        setup
          ? "Create the first account. You'll be the admin and can invite your team and connect agents."
          : "The task tracker your people and agents share."
      }
    >
      <form onSubmit={submit}>
        {setup && <AuthField label="Your name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />}
        <AuthField label="Work email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus={!setup} />
        <AuthField
          label="Password"
          type="password"
          autoComplete={setup ? "new-password" : "current-password"}
          minLength={setup ? 8 : undefined}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {error && <p className="mb-4 text-[13px] text-[#c4312b]">{error}</p>}
        <Button variant="primary" className="h-9 w-full" disabled={busy}>
          {busy ? "Signing in…" : setup ? "Create admin account" : "Sign in"}
        </Button>
      </form>
      {google && (
        <a href={`/auth/google?next=${next}`} className="mt-3 block">
          <Button className="h-9 w-full">Continue with Google</Button>
        </a>
      )}
      {!setup && <p className="mt-6 text-[13px] text-ink-3">No account, or forgot your password? Ask a workspace admin for a link.</p>}
    </AuthCard>
  );
}
