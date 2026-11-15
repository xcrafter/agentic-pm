import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { type Inbox, api } from "../api";
import { Avatar, Button, cx, inputClass, useMe, useProjects, useRealtime } from "../components";
import { CreateTaskModal } from "./CreateTask";

export function Layout() {
  const me = useMe();
  const signedIn = !!me.data?.member;
  useRealtime(signedIn);
  const [creating, setCreating] = useState(false);
  const loc = useLocation();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)) return;
      if (e.key === "c" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setCreating(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  if (me.isLoading) return <div className="p-8 text-zinc-400">Loading…</div>;
  if (!signedIn) return <Login google={!!me.data?.auth.google} setup={!!me.data?.auth.setup} />;

  const projectMatch = /^\/projects\/([^/]+)/.exec(loc.pathname);
  return (
    <div className="flex h-full">
      <Sidebar onCreate={() => setCreating(true)} />
      <main className="min-w-0 flex-1 overflow-auto">
        <Outlet />
      </main>
      <CreateTaskModal open={creating} onClose={() => setCreating(false)} defaultProjectId={projectMatch?.[1]} />
    </div>
  );
}

function Sidebar({ onCreate }: { onCreate: () => void }) {
  const me = useMe().data!;
  const projects = useProjects();
  const inbox = useQuery({ queryKey: ["inbox"], queryFn: () => api.get<Inbox>("/api/inbox") });
  const inboxCount = (inbox.data?.questions.length ?? 0) + (inbox.data?.runs.length ?? 0) + (inbox.data?.mentions.length ?? 0);
  const qc = useQueryClient();
  const link = ({ isActive }: { isActive: boolean }) =>
    cx(
      "flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px]",
      isActive ? "bg-zinc-200/70 font-medium dark:bg-zinc-800" : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800/60",
    );
  return (
    <aside className="hidden w-56 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50 px-3 py-3 md:flex dark:border-zinc-800 dark:bg-zinc-900/40">
      <div className="mb-3 flex items-center justify-between px-1">
        <div className="flex items-center gap-2 font-semibold">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent text-xs text-white">
            {me.workspace?.name.slice(0, 1)}
          </span>
          {me.workspace?.name}
        </div>
      </div>
      <Button variant="secondary" className="mb-3 w-full justify-start" onClick={onCreate}>
        <span className="text-base leading-none">+</span> New task
        <kbd className="ml-auto text-[11px] text-zinc-400">C</kbd>
      </Button>
      <nav className="flex flex-col gap-0.5">
        <NavLink to="/inbox" className={link}>
          Needs you
          {inboxCount > 0 && (
            <span className="ml-auto rounded-full bg-orange-500 px-1.5 text-[11px] font-semibold text-white">{inboxCount}</span>
          )}
        </NavLink>
        <NavLink to="/my" className={link}>
          My tasks
        </NavLink>
        <NavLink to="/" end className={link}>
          All tasks
        </NavLink>
        <NavLink to="/members" className={link}>
          Members & agents
        </NavLink>
      </nav>
      <div className="mt-5 mb-1 flex items-center justify-between px-2 text-[11px] font-medium uppercase tracking-wide text-zinc-400">
        <NavLink to="/projects" className="hover:text-zinc-600">
          Projects
        </NavLink>
      </div>
      <nav className="flex flex-col gap-0.5 overflow-auto">
        {projects.data
          ?.filter((p) => p.status === "active")
          .map((p) => (
            <NavLink key={p.id} to={`/projects/${p.id}`} className={link}>
              <span className="h-2 w-2 rounded-sm bg-zinc-400" />
              <span className="truncate">{p.name}</span>
            </NavLink>
          ))}
      </nav>
      <div className="mt-auto flex items-center gap-2 px-1 pt-3">
        <Avatar member={me.member} size={22} />
        <span className="truncate text-[13px]">{me.member?.name}</span>
        <button
          className="ml-auto text-xs text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
          onClick={async () => {
            await api.post("/auth/logout");
            qc.invalidateQueries();
          }}
        >
          Sign out
        </button>
      </div>
    </aside>
  );
}

/** Where to go after signing in: ?next=… (e.g. back to an MCP consent screen) or the current page. */
function afterSignIn() {
  const next = new URLSearchParams(location.search).get("next");
  const safe = next && next.startsWith("/") && !next.startsWith("//") ? next : location.pathname;
  location.assign(safe);
}

export function AuthCard({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center bg-zinc-50 px-4 dark:bg-zinc-950">
      <div className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-8 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-accent font-semibold text-white">A</div>
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="mt-1 mb-6 text-sm text-zinc-500">{subtitle}</p>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, ...props }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="mb-3 block text-[13px] font-medium">
      {label}
      <input {...props} className={cx(inputClass, "mt-1 py-2 font-normal")} />
    </label>
  );
}

function Login({ google, setup }: { google: boolean; setup: boolean }) {
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
      title={setup ? "Set up Agentic PM" : "Sign in to Agentic PM"}
      subtitle={setup ? "Create the first account. You'll be the workspace admin and can invite your team." : "Where humans and agents get work done."}
    >
      <form onSubmit={submit}>
        {setup && <Field label="Your name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />}
        <Field label="Work email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus={!setup} />
        <Field
          label="Password"
          type="password"
          autoComplete={setup ? "new-password" : "current-password"}
          minLength={setup ? 8 : undefined}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
        <Button variant="primary" className="w-full justify-center py-2" disabled={busy}>
          {busy ? "…" : setup ? "Create admin account" : "Sign in"}
        </Button>
      </form>
      {!setup && <p className="mt-4 text-xs text-zinc-500">No account or forgot your password? Ask an admin for a link.</p>}
      {google && (
        <a href={`/auth/google?next=${next}`} className="mt-3 block">
          <Button className="w-full justify-center py-2">Continue with Google</Button>
        </a>
      )}
    </AuthCard>
  );
}
