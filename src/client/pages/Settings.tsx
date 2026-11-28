import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Bot, CircleDot, Globe, ImageUp, KeyRound, Mail, PanelLeft, Link2, RotateCcw, Settings, ShieldCheck, Tag as TagIcon, Trash2, Wand2, Webhook, X, Zap } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import {
  type EmailLog,
  type Label,
  type Member,
  type SidebarItem,
  type SidebarItemKey,
  type SidebarProfile,
  type Status,
  type StatusDef,
  type WorkspaceInfo,
  DEFAULT_STATUSES,
  LABEL_COLORS,
  api,
} from "../api";
import {
  Avatar,
  Button,
  DeleteButton,
  Menu,
  Modal,
  ModalFooter,
  Popover,
  StatusIcon,
  Tag,
  TopBar,
  WorkspaceLogo,
  canDelete,
  cx,
  inputClass,
  timeAgo,
  useLabels,
  useMe,
  useMembers,
  wakeRoute,
} from "../components";

function Section({ icon, title, description, children }: { icon: ReactNode; title: string; description: string; children: ReactNode }) {
  return (
    <section className="grid gap-4 border-b border-line py-7 last:border-b-0 md:grid-cols-[240px_1fr] md:gap-10">
      <div>
        <h2 className="flex items-center gap-2 text-[14px] font-semibold">
          <span className="text-ink-3">{icon}</span>
          {title}
        </h2>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-3">{description}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : e ? String(e) : null);

export function SettingsPage() {
  const me = useMe().data!;
  const ws = me.workspace!;
  const isAdmin = me.member?.role === "admin";
  const qc = useQueryClient();
  const setWs = (w: WorkspaceInfo) => qc.setQueryData(["me"], { ...me, workspace: w, brand: { name: w.name, logo_url: w.logo_url } });

  const [name, setName] = useState(ws.name);
  const [website, setWebsite] = useState(ws.website ?? "");
  const [domains, setDomains] = useState<string[]>(ws.allowed_domains);
  const [domainInput, setDomainInput] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setName(ws.name);
    setWebsite(ws.website ?? "");
    setDomains(ws.allowed_domains);
  }, [ws.name, ws.website, ws.allowed_domains.join(",")]);

  const saveGeneral = useMutation({
    mutationFn: () => api.patch<WorkspaceInfo & { logo?: { found: boolean; error?: string } }>("/api/workspace", { name, website: website.trim() || null }),
    onSuccess: (w) => {
      setWs(w);
      setNotice(w.logo ? (w.logo.found ? "Saved. We found your logo on the website." : `Saved. ${w.logo.error}`) : "Saved.");
    },
  });
  const fetchLogo = useMutation({
    mutationFn: () => api.post<WorkspaceInfo & { logo_source: string }>("/api/workspace/logo/fetch", { website: website.trim() || undefined }),
    onSuccess: (w) => {
      setWs(w);
      setNotice(`Logo updated from ${new URL(w.logo_source).hostname}.`);
    },
  });
  const uploadLogo = useMutation({
    mutationFn: (f: File) => api.upload<WorkspaceInfo>("/api/workspace/logo", [f]),
    onSuccess: (w) => (setWs(w), setNotice("Logo uploaded.")),
  });
  const removeLogo = useMutation({
    mutationFn: () => api.del<WorkspaceInfo>("/api/workspace/logo"),
    onSuccess: (w) => (setWs(w), setNotice("Logo removed.")),
  });
  const saveDomains = useMutation({
    mutationFn: (list: string[] | null) => api.patch<WorkspaceInfo>("/api/workspace", { allowed_domains: list }),
    onSuccess: (w) => {
      setWs(w);
      setDomainInput("");
    },
  });

  const addDomain = () => {
    const parts = domainInput
      .split(/[\s,]+/)
      .map((d) => d.trim().toLowerCase().replace(/^@/, "").replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
      .filter(Boolean);
    if (parts.length) setDomains((d) => [...new Set([...d, ...parts])]);
    setDomainInput("");
  };
  const domainsDirty = domains.join(",") !== ws.allowed_domains.join(",") || !!domainInput.trim();
  const generalDirty = name !== ws.name || (website.trim() || null) !== (ws.website ?? null);
  const logoBusy = fetchLogo.isPending || uploadLogo.isPending || removeLogo.isPending;
  const logoError = errorText(fetchLogo.error || uploadLogo.error || removeLogo.error);

  return (
    <div className="flex h-full flex-col">
      <TopBar crumbs={[{ label: "Workspace settings", icon: <Settings size={15} className="text-ink-3" /> }]} />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-4xl px-4 py-6 md:px-6">
          <div className="flex items-center gap-3.5">
            <WorkspaceLogo name={ws.name} logoUrl={ws.logo_url} size={44} />
            <div>
              <h1 className="text-[22px] font-semibold tracking-[-0.015em]">{ws.name}</h1>
              <p className="text-[13px] text-ink-3">{isAdmin ? "You're an admin and can change these settings." : "Only admins can change these settings."}</p>
            </div>
          </div>
          {notice && (
            <div className="mt-5 flex items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2 text-[13px]">
              <span className="flex-1">{notice}</span>
              <button className="text-ink-3 hover:text-ink" onClick={() => setNotice(null)} aria-label="Dismiss">
                <X size={14} />
              </button>
            </div>
          )}

          <div className="mt-2">
            <Section icon={<Globe size={15} />} title="General" description="The workspace name appears in the sidebar and on the sign-in page. The website is used to find your logo.">
              <form
                className="max-w-md space-y-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  saveGeneral.mutate();
                }}
              >
                <label className="block">
                  <span className="mb-1.5 block text-[13px] font-medium">Workspace name</span>
                  <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} disabled={!isAdmin} maxLength={60} required />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-[13px] font-medium">Website</span>
                  <input className={inputClass} value={website} onChange={(e) => setWebsite(e.target.value)} disabled={!isAdmin} placeholder="example.com" inputMode="url" />
                </label>
                {errorText(saveGeneral.error) && <p className="text-[13px] text-[#c4312b]">{errorText(saveGeneral.error)}</p>}
                {isAdmin && (
                  <Button variant="primary" disabled={!generalDirty || saveGeneral.isPending}>
                    {saveGeneral.isPending ? "Saving…" : "Save"}
                  </Button>
                )}
              </form>
            </Section>

            <Section
              icon={<ImageUp size={15} />}
              title="Logo"
              description="Shown in the sidebar and on the sign-in page. We can pick it up from your website, or you can upload a square image (PNG, SVG, JPG; up to 1 MB)."
            >
              <div className="flex flex-wrap items-center gap-4">
                <WorkspaceLogo name={ws.name} logoUrl={ws.logo_url} size={64} />
                {isAdmin && (
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={() => fetchLogo.mutate()} disabled={logoBusy || !(website.trim() || ws.website)} title={website.trim() || ws.website ? undefined : "Add a website first"}>
                      <Wand2 size={14} /> {fetchLogo.isPending ? "Looking…" : "Get logo from website"}
                    </Button>
                    <Button onClick={() => fileInput.current?.click()} disabled={logoBusy}>
                      <ImageUp size={14} /> {uploadLogo.isPending ? "Uploading…" : "Upload"}
                    </Button>
                    {ws.logo_url && (
                      <Button variant="ghost" onClick={() => removeLogo.mutate()} disabled={logoBusy}>
                        <Trash2 size={14} /> Remove
                      </Button>
                    )}
                    <input
                      ref={fileInput}
                      type="file"
                      accept="image/png,image/jpeg,image/svg+xml,image/webp,image/gif,image/x-icon"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) uploadLogo.mutate(f);
                        e.target.value = "";
                      }}
                    />
                  </div>
                )}
              </div>
              {logoError && <p className="mt-3 text-[13px] text-[#c4312b]">{logoError}</p>}
            </Section>

            <StatusSettings isAdmin={isAdmin} />

            <LabelSettings />

            <AgentDispatch ws={ws} isAdmin={isAdmin} onSaved={setWs} />

            <LinkPreviews ws={ws} isAdmin={isAdmin} onSaved={setWs} />

            <ApiKeys isAdmin={isAdmin} />

            {isAdmin && <SidebarProfiles />}

            {isAdmin && <EmailSettings />}

            <Section
              icon={<ShieldCheck size={15} />}
              title="Allowed email domains"
              description="Only people with an email address at these domains can be invited or sign in. Agents connect through approved connections and aren't affected."
            >
              <div className="max-w-md">
                <div className={cx("flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg border border-line bg-canvas p-1.5", !isAdmin && "bg-panel")}>
                  {domains.map((d) => (
                    <Tag key={d} tone="blue">
                      @{d}
                      {isAdmin && (
                        <button className="-mr-0.5 ml-0.5 opacity-70 hover:opacity-100" onClick={() => setDomains((ds) => ds.filter((x) => x !== d))} aria-label={`Remove ${d}`}>
                          <X size={12} />
                        </button>
                      )}
                    </Tag>
                  ))}
                  {isAdmin && (
                    <input
                      className="h-7 min-w-[140px] flex-1 bg-transparent px-1 text-[13px] outline-none placeholder:text-ink-3"
                      placeholder={domains.length ? "Add another domain" : "e.g. example.com"}
                      value={domainInput}
                      onChange={(e) => setDomainInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === ",") {
                          e.preventDefault();
                          addDomain();
                        } else if (e.key === "Backspace" && !domainInput && domains.length) {
                          setDomains((ds) => ds.slice(0, -1));
                        }
                      }}
                      onBlur={addDomain}
                    />
                  )}
                  {!isAdmin && !domains.length && <span className="px-1 text-[13px] text-ink-3">Any domain</span>}
                </div>
                <p className="mt-2 text-[12px] text-ink-3">
                  {domains.length ? "Press Enter to add a domain. " : "With no domains listed, an admin can invite any email address. "}
                  {ws.allowed_domains_source === "default" && "Currently using the deployment's default list."}
                </p>
                {errorText(saveDomains.error) && <p className="mt-2 text-[13px] text-[#c4312b]">{errorText(saveDomains.error)}</p>}
                {isAdmin && (
                  <div className="mt-3 flex gap-2">
                    <Button
                      variant="primary"
                      disabled={!domainsDirty || saveDomains.isPending}
                      onClick={() => {
                        const pending = domainInput.split(/[\s,]+/).map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
                        saveDomains.mutate([...new Set([...domains, ...pending])]);
                      }}
                    >
                      {saveDomains.isPending ? "Saving…" : "Save domains"}
                    </Button>
                    {domainsDirty && (
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setDomains(ws.allowed_domains);
                          setDomainInput("");
                        }}
                      >
                        Cancel
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </Section>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The workspace PM agent and its webhook: the workspace-level wake-up for every agent without its own
 * webhook, plus (optionally) triage of new unassigned tasks.
 */
function AgentDispatch({ ws, isAdmin, onSaved }: { ws: WorkspaceInfo; isAdmin: boolean; onSaved: (w: WorkspaceInfo) => void }) {
  const qc = useQueryClient();
  const me = useMe().data;
  const members = useMembers().data ?? [];
  const agents = members.filter((m) => m.kind === "agent" && m.active);
  const pm = members.find((m) => m.id === ws.pm_agent_id) ?? null;
  const [url, setUrl] = useState(pm?.webhook_url ?? "");
  const [key, setKey] = useState("");
  const [ping, setPing] = useState<{ ok: boolean; status: number; body: string } | null>(null);
  useEffect(() => {
    setUrl(pm?.webhook_url ?? "");
    setKey("");
    setPing(null);
  }, [pm?.id, pm?.webhook_url]);

  const setPmField = useMutation({
    mutationFn: (body: { pm_agent_id?: string | null; pm_triage?: boolean }) => api.patch<WorkspaceInfo>("/api/workspace", body),
    onSuccess: onSaved,
  });
  const saveHook = useMutation({
    mutationFn: () => api.patch<Member>("/api/workspace/pm-webhook", { webhook_url: url.trim(), webhook_key: key || undefined }),
    onSuccess: () => {
      setKey("");
      qc.invalidateQueries({ queryKey: ["members"] });
    },
  });
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; status: number; body: string }>("/api/workspace/pm-webhook/test"),
    onSuccess: setPing,
  });

  const routes = agents.filter((a) => a.id !== pm?.id).map((a) => ({ a, r: wakeRoute(a, members, me) }));
  const viaPm = routes.filter((x) => x.r.kind === "pm");
  const own = routes.filter((x) => x.r.kind === "own");
  const none = routes.filter((x) => x.r.kind === null);
  const hookDirty = url.trim() !== (pm?.webhook_url ?? "") || !!key;
  const error = setPmField.error || saveHook.error || test.error;

  return (
    <Section
      icon={<Webhook size={15} />}
      title="Agent dispatch"
      description="Pick a PM agent (e.g. your Grok PM) and give it one webhook. Every agent without its own webhook is woken through it, and the PM hands the work to the right agent. Set a webhook on an agent to override this."
    >
      <div className="max-w-lg space-y-5">
        <div>
          <span className="mb-1.5 block text-[13px] font-medium">PM agent</span>
          {isAdmin ? (
            <Menu
              searchable
              width="w-72"
              className="h-9 w-full rounded-lg border border-line bg-canvas px-2.5 hover:border-line-strong"
              trigger={
                pm ? (
                  <span className="flex min-w-0 items-center gap-2 text-[13px]">
                    <Avatar member={pm} size={18} />
                    <span className="truncate font-medium">{pm.name}</span>
                    <span className="text-ink-3">@{pm.handle}</span>
                  </span>
                ) : (
                  <span className="text-[13px] text-ink-3">No PM: each agent needs its own webhook</span>
                )
              }
              value={ws.pm_agent_id ?? "none"}
              onChange={(id) => setPmField.mutate({ pm_agent_id: id === "none" ? null : id })}
              options={[
                { value: "none", label: "No PM" },
                ...agents.map((a) => ({ value: a.id, label: a.name, icon: <Avatar member={a} size={16} />, hint: `@${a.handle}` })),
              ]}
            />
          ) : (
            <div className="text-[13px]">{pm ? `${pm.name} (@${pm.handle})` : "None"}</div>
          )}
          {!agents.length && (
            <p className="mt-1.5 text-[12px] text-ink-3">
              No agents yet. Connect Grok over MCP or <Link to="/team" className="underline">add an agent</Link>.
            </p>
          )}
        </div>

        {pm && (
          <>
            <div className="rounded-[10px] border border-line bg-panel p-4">
              <div className="mb-3 flex items-center gap-2 text-[13px] font-semibold">
                <Bot size={14} className="text-agent" /> Workspace webhook
                <span className="font-normal text-ink-3">(the PM's)</span>
              </div>
              <div className="space-y-3">
                <label className="block">
                  <span className="mb-1.5 block text-[13px] font-medium">Webhook URL</span>
                  <input className={inputClass} value={url} onChange={(e) => setUrl(e.target.value)} disabled={!isAdmin} placeholder="https://… (the Grok PM routine's webhook)" />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-[13px] font-medium">Webhook key</span>
                  <input
                    className={inputClass}
                    type="password"
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    disabled={!isAdmin}
                    placeholder={pm.has_webhook ? "Saved. Type a new key to replace it." : "Sent as a Bearer token with every wake-up"}
                  />
                </label>
                {isAdmin && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="primary" disabled={!hookDirty || !url.trim() || (!pm.has_webhook && !key) || saveHook.isPending} onClick={() => saveHook.mutate()}>
                      {saveHook.isPending ? "Saving…" : "Save webhook"}
                    </Button>
                    <Button onClick={() => test.mutate()} disabled={!pm.has_webhook || test.isPending || hookDirty}>
                      <Zap size={13} /> {test.isPending ? "Pinging…" : "Send test ping"}
                    </Button>
                    {ping && (
                      <span className={cx("text-[12px]", ping.ok ? "text-[#1f9d5c]" : "text-danger")}>
                        {ping.ok ? "The PM accepted the ping." : `Ping failed: ${ping.status || ""} ${ping.body}`}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>

            <label className={cx("flex items-start gap-2.5 text-[13px]", !isAdmin && "opacity-70")}>
              <input
                type="checkbox"
                className="mt-0.5"
                checked={ws.pm_triage}
                disabled={!isAdmin || setPmField.isPending}
                onChange={(e) => setPmField.mutate({ pm_triage: e.target.checked })}
              />
              <span>
                <span className="font-medium">Also wake the PM for new unassigned tasks</span>
                <span className="block text-ink-3">
                  Off by default: the PM stays idle unless an agent is assigned or @mentioned. Turn this on to have it pick an assignee for every new task created without one.
                </span>
              </span>
            </label>

            <div className="text-[13px]">
              <div className="mb-1.5 font-medium">How agents are woken</div>
              <ul className="space-y-1 text-ink-2">
                <li>
                  <Tag tone="blue">Via PM</Tag> {viaPm.length ? viaPm.map((x) => `@${x.a.handle}`).join(", ") : <span className="text-ink-3">none</span>}
                </li>
                <li>
                  <Tag tone="green">Own webhook</Tag> {own.length ? own.map((x) => `@${x.a.handle}`).join(", ") : <span className="text-ink-3">none</span>}
                </li>
                {!pm.has_webhook && none.length > 0 && (
                  <li>
                    <Tag tone="amber">Can't be woken yet</Tag> {none.map((x) => `@${x.a.handle}`).join(", ")}: save the PM's webhook above.
                  </li>
                )}
              </ul>
            </div>
          </>
        )}
        {error && <p className="text-[13px] text-danger">{(error as Error).message}</p>}
      </div>
    </Section>
  );
}

const PREVIEW_OPTIONS = [
  { value: "off", label: "Off", hint: "Previews show “Agentic PM”. Task details stay behind sign-in." },
  { value: "title", label: "Task title", hint: "Previews show the key and title, e.g. “IMP-30: Launch post”, with its status." },
  { value: "full", label: "Title and description", hint: "Also shows the first couple of lines of the description." },
] as const;

type ApiKey = { id: string; name: string; prefix: string; member?: { id: string; name: string }; created_at: string; last_used_at: string | null };

function ApiKeys({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const me = useMe().data?.member;
  const keys = useQuery({ queryKey: ["api-keys"], queryFn: () => api.get<ApiKey[]>("/api/keys") });
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const create = useMutation({
    mutationFn: () => api.post<ApiKey & { key: string }>("/api/keys", { name }),
    onSuccess: (k) => {
      setCreated({ name: k.name, key: k.key });
      setCopied(false);
      setName("");
      qc.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/api/keys/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["api-keys"] }),
  });
  return (
    <Section
      icon={<KeyRound size={15} />}
      title="API keys"
      description={`Call the API from scripts and other tools as yourself: send Authorization: Bearer <key> to any /api endpoint. A key can do what you can do, so keep it secret.${isAdmin ? " As an admin you also see, and can revoke, everyone's keys." : ""}`}
    >
      <div className="max-w-xl space-y-3">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <input className={inputClass} placeholder="What will use it, e.g. Zapier or nightly report" value={name} onChange={(e) => setName(e.target.value)} aria-label="Key name" />
          <Button type="submit" disabled={!name.trim() || create.isPending}>
            Create key
          </Button>
        </form>
        {create.error && <p className="text-[12px] text-danger">{errorText(create.error)}</p>}
        {created && (
          <div className="rounded-lg border border-line bg-panel p-3 text-[13px]">
            <p className="font-medium">Copy your key for “{created.name}” now. It won't be shown again.</p>
            <div className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md border border-line bg-canvas px-2 py-1.5 text-[12px]">{created.key}</code>
              <Button
                size="sm"
                onClick={() => navigator.clipboard.writeText(created.key).then(() => setCopied(true))}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setCreated(null)}>
                Done
              </Button>
            </div>
          </div>
        )}
        {keys.data && keys.data.length > 0 && (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {keys.data.map((k) => (
              <li key={k.id} className="flex items-center gap-3 px-3 py-2 text-[13px]">
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{k.name}</span>{" "}
                  <code className="text-[12px] text-ink-3">{k.prefix}…</code>
                  <span className="block text-[12px] text-ink-3">
                    {k.member && k.member.id !== me?.id ? `${k.member.name}'s key. ` : ""}
                    Created {timeAgo(k.created_at)}. {k.last_used_at ? `Last used ${timeAgo(k.last_used_at)}.` : "Never used."}
                  </span>
                </span>
                <Button size="sm" variant="ghost" disabled={revoke.isPending} onClick={() => revoke.mutate(k.id)}>
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
        {keys.data?.length === 0 && !created && <p className="text-[12px] text-ink-3">No keys yet.</p>}
      </div>
    </Section>
  );
}

function LinkPreviews({ ws, isAdmin, onSaved }: { ws: WorkspaceInfo; isAdmin: boolean; onSaved: (w: WorkspaceInfo) => void }) {
  const save = useMutation({
    mutationFn: (link_previews: WorkspaceInfo["link_previews"]) => api.patch<WorkspaceInfo>("/api/workspace", { link_previews }),
    onSuccess: onSaved,
  });
  return (
    <Section
      icon={<Link2 size={15} />}
      title="Link previews"
      description="What WhatsApp, Slack, iMessage and similar apps show when someone pastes a task link (like /t/IMP-30). Share links always show the task."
    >
      <div className="max-w-lg space-y-2">
        {PREVIEW_OPTIONS.map((o) => (
          <label key={o.value} className={cx("flex items-start gap-2.5 text-[13px]", !isAdmin && "opacity-70")}>
            <input
              type="radio"
              name="link_previews"
              className="mt-0.5"
              checked={ws.link_previews === o.value}
              disabled={!isAdmin || save.isPending}
              onChange={() => save.mutate(o.value)}
            />
            <span>
              <span className="font-medium">{o.label}</span>
              <span className="block text-ink-3">{o.hint}</span>
            </span>
          </label>
        ))}
        {ws.link_previews !== "off" && (
          <p className="rounded-lg border border-line bg-panel px-3 py-2 text-[12px] leading-relaxed text-ink-2">
            Preview apps aren't signed in, so while this is on, anyone who guesses a task link can read{" "}
            {ws.link_previews === "full" ? "its title and the start of its description" : "its title"}. Nothing else on the task is shown.
          </p>
        )}
        {save.error && <p className="text-[12px] text-danger">{errorText(save.error)}</p>}
      </div>
    </Section>
  );
}

function SidebarProfiles() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["sidebar-profiles"],
    queryFn: () => api.get<{ items: SidebarItem[]; profiles: SidebarProfile[] }>("/api/sidebar-profiles"),
  });
  const members = useMembers();
  const [editing, setEditing] = useState<SidebarProfile | "new" | null>(null);
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/api/sidebar-profiles/${id}`),
    onSuccess: () => (qc.invalidateQueries({ queryKey: ["sidebar-profiles"] }), qc.invalidateQueries({ queryKey: ["sidebar"] })),
  });
  const people = (members.data ?? []).filter((m) => m.kind === "human" && m.active);
  return (
    <Section
      icon={<PanelLeft size={15} />}
      title="Sidebar profiles"
      description="Group sidebar choices into profiles, like Sales or Engineering, and assign them to people. Everyone can still show or hide items for themselves. Hidden pages stay reachable by link and search, so this tidies the sidebar but doesn't restrict access."
    >
      <div className="max-w-xl space-y-3">
        {q.data && q.data.profiles.length > 0 && (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {q.data.profiles.map((p) => {
              const names = p.member_ids.map((id) => people.find((m) => m.id === id)?.name).filter(Boolean);
              return (
                <li key={p.id} className="flex items-center gap-3 px-3 py-2 text-[13px]">
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{p.name}</span> {p.is_default && <Tag tone="blue">Default</Tag>}
                    <span className="block text-[12px] text-ink-3">
                      {p.hidden.length ? `Hides ${p.hidden.map((k) => q.data.items.find((i) => i.key === k)?.label).join(", ")}.` : "Shows everything."}{" "}
                      {names.length ? `Used by ${names.join(", ")}.` : p.is_default ? "Used by everyone without a profile." : "Not assigned to anyone."}
                    </span>
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" disabled={del.isPending} onClick={() => del.mutate(p.id)} aria-label={`Delete ${p.name}`}>
                    <Trash2 size={13} />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        {q.data?.profiles.length === 0 && <p className="text-[12px] text-ink-3">No profiles yet. Everyone sees the full sidebar unless they hide items themselves.</p>}
        {del.error && <p className="text-[12px] text-danger">{errorText(del.error)}</p>}
        <Button onClick={() => setEditing("new")}>New profile</Button>
      </div>
      {editing && q.data && (
        <SidebarProfileModal profile={editing === "new" ? null : editing} items={q.data.items} people={people} onClose={() => setEditing(null)} />
      )}
    </Section>
  );
}

function SidebarProfileModal({
  profile,
  items,
  people,
  onClose,
}: {
  profile: SidebarProfile | null;
  items: SidebarItem[];
  people: Member[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(profile?.name ?? "");
  const [hidden, setHidden] = useState<Set<SidebarItemKey>>(new Set(profile?.hidden ?? []));
  const [assigned, setAssigned] = useState<Set<string>>(new Set(profile?.member_ids ?? []));
  const [isDefault, setIsDefault] = useState(profile?.is_default ?? false);
  const save = useMutation({
    mutationFn: () => {
      const body = { name, hidden: [...hidden], member_ids: [...assigned], is_default: isDefault };
      return profile ? api.patch(`/api/sidebar-profiles/${profile.id}`, body) : api.post("/api/sidebar-profiles", body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sidebar-profiles"] });
      qc.invalidateQueries({ queryKey: ["sidebar"] });
      qc.invalidateQueries({ queryKey: ["members"] });
      onClose();
    },
  });
  const toggle = <T,>(set: Set<T>, v: T, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(v);
    else next.delete(v);
    return next;
  };
  const groups: [SidebarItem["group"], string][] = [
    ["main", "Pages"],
    ["team", "Team"],
    ["sections", "Lists"],
  ];
  return (
    <Modal open onClose={onClose} title={profile ? `Edit ${profile.name}` : "New sidebar profile"}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) save.mutate();
        }}
      >
        <div className="space-y-5 p-4">
          <label className="block text-[13px]">
            <span className="mb-1 block font-medium">Name</span>
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sales" maxLength={60} autoFocus required />
          </label>
          <div>
            <div className="mb-1.5 text-[13px] font-medium">Show in the sidebar</div>
            <div className="grid gap-4 sm:grid-cols-3">
              {groups.map(([g, title]) => (
                <div key={g}>
                  <div className="mb-1 text-[12px] text-ink-3">{title}</div>
                  {items
                    .filter((i) => i.group === g)
                    .map((i) => (
                      <label key={i.key} className="flex items-center gap-2 py-0.5 text-[13px]">
                        <input type="checkbox" checked={!hidden.has(i.key)} onChange={(e) => setHidden(toggle(hidden, i.key, !e.target.checked))} />
                        {i.label}
                      </label>
                    ))}
                </div>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-1.5 text-[13px] font-medium">People</div>
            <div className="grid max-h-48 gap-1 overflow-y-auto sm:grid-cols-2">
              {people.map((m) => {
                const elsewhere = m.sidebar_profile_id && m.sidebar_profile_id !== profile?.id && !assigned.has(m.id);
                return (
                  <label key={m.id} className="flex items-center gap-2 py-0.5 text-[13px]">
                    <input type="checkbox" checked={assigned.has(m.id)} onChange={(e) => setAssigned(toggle(assigned, m.id, e.target.checked))} />
                    <Avatar member={m} size={18} />
                    <span className="truncate">{m.name}</span>
                    {elsewhere && <span className="text-[11px] text-ink-3">(has another profile)</span>}
                  </label>
                );
              })}
            </div>
            <p className="mt-1 text-[12px] text-ink-3">Ticking someone who has another profile moves them to this one.</p>
          </div>
          <label className="flex items-start gap-2.5 text-[13px]">
            <input type="checkbox" className="mt-0.5" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
            <span>
              Use for everyone without a profile
              <span className="block text-[12px] text-ink-3">Includes people who join later.</span>
            </span>
          </label>
          {save.error && <p className="text-[12px] text-danger">{errorText(save.error)}</p>}
        </div>
        <ModalFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!name.trim() || save.isPending}>
            {profile ? "Save profile" : "Create profile"}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

function EmailSettings() {
  const log = useQuery({ queryKey: ["email-log"], queryFn: () => api.get<EmailLog>("/api/email-log") });
  const test = useMutation({
    mutationFn: () => api.post<{ status: string; error: string | null; to: string }>("/api/email-test"),
    onSettled: () => log.refetch(),
  });
  const d = log.data;
  return (
    <Section
      icon={<Mail size={15} />}
      title="Email"
      description="Emails people when a task is assigned to them, they're @mentioned, an agent asks them a question, or an agent they started fails. Each person chooses which they get from their menu. Invites and password resets are emailed too."
    >
      <div className="max-w-xl space-y-3 text-[13px]">
        {d && !d.enabled && (
          <div className="rounded-lg border border-line bg-panel p-3">
            <p className="font-medium">Email is off for this workspace.</p>
            <p className="mt-1 text-ink-3">To turn it on, someone with access to the Cloudflare account:</p>
            <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-ink-3">
              <li>Makes sure the account is on the Workers Paid plan.</li>
              <li>Onboards the company's domain under Email Service → Email Sending (the domain's DNS must be on Cloudflare).</li>
              <li>
                Adds the build variable <code>APM_EMAIL_FROM</code>, for example <code>notifications@yourcompany.com</code>, and retries the latest
                build.
              </li>
            </ol>
            <p className="mt-1 text-ink-3">The setup guide (docs/SETUP.md) has the details.</p>
          </div>
        )}
        {d?.enabled && (
          <>
            <p>
              Sending from <span className="font-medium">{d.from}</span>.
              {!d.binding && <span className="text-danger"> The email connection is missing from this deployment; retry the latest build.</span>}
            </p>
            <div className="flex items-center gap-3">
              <Button disabled={test.isPending} onClick={() => test.mutate()}>
                {test.isPending ? "Sending…" : "Send me a test email"}
              </Button>
              {test.data && (
                <span className={test.data.status === "sent" ? "text-ink-3" : "text-danger"}>
                  {test.data.status === "sent" ? `Sent to ${test.data.to}. Check your inbox (and spam).` : `Not sent: ${test.data.error}`}
                </span>
              )}
              {test.error && <span className="text-danger">{errorText(test.error)}</span>}
            </div>
          </>
        )}
        {d && d.items.length > 0 && (
          <div>
            <div className="mb-1.5 text-[12px] font-medium text-ink-3">Recent emails</div>
            <ul className="divide-y divide-line rounded-lg border border-line">
              {d.items.map((e) => (
                <li key={e.id} className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">{e.subject}</span>
                    <Tag tone={e.status === "sent" ? "green" : e.status === "failed" ? "red" : "gray"}>{e.status}</Tag>
                  </div>
                  <div className="text-[12px] text-ink-3">
                    To {e.to_email}, {timeAgo(e.created_at)}
                    {e.error ? `. ${e.error}` : ""}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Section>
  );
}

// ---------- Task statuses & labels ----------

function ColorPicker({ value, onChange, disabled, label }: { value: string; onChange: (c: string) => void; disabled?: boolean; label: string }) {
  const swatch = <span className="block h-4 w-4 rounded-full border border-black/10" style={{ background: value }} />;
  if (disabled) return <span className="flex h-7 w-7 items-center justify-center">{swatch}</span>;
  return (
    <Popover label={label} width="w-auto" trigger={<span className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-hover">{swatch}</span>}>
      {(close) => (
        <div className="p-1.5">
          <div className="grid grid-cols-5 gap-1.5">
            {LABEL_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Color ${c}`}
                onClick={() => (onChange(c), close())}
                className={cx("h-6 w-6 rounded-full border border-black/10", c === value.toLowerCase() && "ring-2 ring-accent ring-offset-2 ring-offset-canvas")}
                style={{ background: c }}
              />
            ))}
            <label className="relative h-6 w-6 cursor-pointer overflow-hidden rounded-full border border-dashed border-line-strong" title="Custom color">
              <input
                type="color"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                aria-label="Custom color"
              />
              <span className="flex h-full w-full items-center justify-center text-[11px] text-ink-3">+</span>
            </label>
          </div>
        </div>
      )}
    </Popover>
  );
}

/** A name that saves when you leave the field (or press Enter); Escape puts it back. */
function InlineName({ value, onSave, disabled, label }: { value: string; onSave: (v: string) => void; disabled?: boolean; label: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  if (disabled) return <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{value}</span>;
  const commit = () => {
    const next = v.trim();
    if (next && next !== value) onSave(next);
    else setV(value);
  };
  return (
    <input
      aria-label={label}
      value={v}
      maxLength={40}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.preventDefault(), (e.target as HTMLInputElement).blur());
        if (e.key === "Escape") (setV(value), (e.target as HTMLInputElement).blur());
      }}
      className="h-7 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 text-[13px] font-medium outline-none hover:border-line-strong focus:border-accent"
    />
  );
}

const builtinName = (key: Status) => DEFAULT_STATUSES.find((d) => d.key === key)!.name;

function StatusSettings({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["statuses"], queryFn: () => api.get<StatusDef[]>("/api/statuses") });
  const list = q.data ?? DEFAULT_STATUSES;
  const [name, setName] = useState("");
  const [category, setCategory] = useState<Status>("in_progress");
  const [color, setColor] = useState(DEFAULT_STATUSES[2].color);
  const [notice, setNotice] = useState<string | null>(null);
  const done = () => {
    qc.invalidateQueries({ queryKey: ["statuses"] });
    qc.invalidateQueries({ queryKey: ["tasks"] });
    qc.invalidateQueries({ queryKey: ["task"] });
  };
  const update = useMutation({
    mutationFn: ({ key, body }: { key: string; body: { name?: string; color?: string } }) => api.patch(`/api/statuses/${key}`, body),
    onSettled: done,
  });
  const reorder = useMutation({
    mutationFn: (keys: string[]) => api.put("/api/statuses/order", { keys }),
    onMutate: (keys) => qc.setQueryData<StatusDef[]>(["statuses"], (old) => keys.map((k) => old!.find((s) => s.key === k)!)),
    onSettled: done,
  });
  const create = useMutation({
    mutationFn: () => api.post<StatusDef>("/api/statuses", { name, category, color }),
    onSuccess: () => {
      setName("");
      done();
    },
  });
  const remove = useMutation({
    mutationFn: (s: StatusDef) => api.del<{ moved?: number; moved_to?: Status; reset?: boolean }>(`/api/statuses/${s.key}`),
    onSuccess: (r, s) => {
      setNotice(
        r.reset
          ? `${builtinName(s.key as Status)} is back to its original name and color.`
          : `Removed ${s.name}.${r.moved ? ` Its ${r.moved} task${r.moved === 1 ? " is" : "s are"} now ${list.find((x) => x.key === r.moved_to)?.name ?? r.moved_to}.` : ""}`,
      );
      done();
    },
  });
  const move = (i: number, dir: -1 | 1) => {
    const keys = list.map((s) => s.key);
    [keys[i], keys[i + dir]] = [keys[i + dir], keys[i]];
    reorder.mutate(keys);
  };
  const error = errorText(update.error || reorder.error || create.error || remove.error);
  const builtins = DEFAULT_STATUSES;

  return (
    <Section
      icon={<CircleDot size={15} />}
      title="Task statuses"
      description="The statuses tasks move through, in board order. Rename or recolor any of them, and add your own. Each custom status behaves like one of the built-in ones: a status that behaves like Done finishes the task, closes agent runs and posts to the feed."
    >
      <div className="max-w-xl space-y-3">
        <ul className="divide-y divide-line rounded-lg border border-line">
          {list.map((s, i) => {
            const def = builtins.find((d) => d.key === s.key);
            const changed = !!def && (def.name !== s.name || def.color !== s.color.toLowerCase());
            return (
              <li key={s.key} className="flex items-center gap-1.5 py-1 pr-2 pl-1.5">
                {isAdmin && (
                  <span className="flex flex-col">
                    <button type="button" aria-label={`Move ${s.name} up`} disabled={i === 0 || reorder.isPending} onClick={() => move(i, -1)} className="text-ink-3 hover:text-ink disabled:opacity-25">
                      <ArrowUp size={12} />
                    </button>
                    <button type="button" aria-label={`Move ${s.name} down`} disabled={i === list.length - 1 || reorder.isPending} onClick={() => move(i, 1)} className="text-ink-3 hover:text-ink disabled:opacity-25">
                      <ArrowDown size={12} />
                    </button>
                  </span>
                )}
                <ColorPicker label={`Color of ${s.name}`} value={s.color} disabled={!isAdmin} onChange={(c) => update.mutate({ key: s.key, body: { color: c } })} />
                <StatusIcon status={s.key} />
                <InlineName label={`Name of ${s.name}`} value={s.name} disabled={!isAdmin} onSave={(n) => update.mutate({ key: s.key, body: { name: n } })} />
                <span className="hidden shrink-0 text-[12px] text-ink-3 sm:inline">
                  {s.builtin ? (s.name !== builtinName(s.key as Status) ? `Built in: ${builtinName(s.key as Status)}` : "Built in") : `Behaves like ${list.find((x) => x.key === s.category)?.name ?? s.category}`}
                </span>
                <span className="w-14 shrink-0 text-right text-[12px] text-ink-3 tabular-nums" title="Tasks in this status (not counting archived)">
                  {s.task_count ?? 0} task{s.task_count === 1 ? "" : "s"}
                </span>
                {isAdmin &&
                  (s.builtin ? (
                    <button
                      type="button"
                      aria-label={`Reset ${s.name}`}
                      title="Back to the original name and color"
                      disabled={!changed || remove.isPending}
                      onClick={() => remove.mutate(s)}
                      className="flex h-7 w-7 items-center justify-center rounded-md text-ink-3 hover:bg-hover hover:text-ink disabled:invisible"
                    >
                      <RotateCcw size={13} />
                    </button>
                  ) : (
                    <DeleteButton
                      icon
                      what="status"
                      name={s.name}
                      detail={
                        s.task_count
                          ? `Its ${s.task_count} task${s.task_count === 1 ? " moves" : "s move"} to ${list.find((x) => x.key === s.category)?.name ?? s.category}. Nothing else about them changes.`
                          : undefined
                      }
                      onDelete={() => remove.mutateAsync(s)}
                      className="h-7 w-7"
                    />
                  ))}
              </li>
            );
          })}
        </ul>
        {isAdmin ? (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) create.mutate();
            }}
          >
            <ColorPicker label="Color of the new status" value={color} onChange={setColor} />
            <input className={cx(inputClass, "w-48 flex-1")} placeholder="New status, e.g. In review" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} aria-label="New status name" />
            <span className="text-[12px] text-ink-3">behaves like</span>
            <Menu
              label="Behaves like"
              trigger={
                <span className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-strong bg-canvas px-2 text-[13px] shadow-btn hover:bg-hover">
                  <StatusIcon status={category} /> {list.find((x) => x.key === category)?.name}
                </span>
              }
              value={category}
              onChange={(c) => {
                setCategory(c);
                setColor(list.find((x) => x.key === c)?.color ?? color);
              }}
              options={builtins.map((b) => ({ value: b.key as Status, label: list.find((x) => x.key === b.key)?.name ?? b.name, icon: <StatusIcon status={b.key} /> }))}
            />
            <Button type="submit" disabled={!name.trim() || create.isPending}>
              Add status
            </Button>
          </form>
        ) : (
          <p className="text-[12px] text-ink-3">Only admins can change statuses.</p>
        )}
        {notice && <p className="text-[12px] text-ink-2">{notice}</p>}
        {error && <p className="text-[12px] text-danger">{error}</p>}
      </div>
    </Section>
  );
}

function LabelSettings() {
  const qc = useQueryClient();
  const me = useMe().data?.member;
  const labels = useLabels();
  const [name, setName] = useState("");
  const [color, setColor] = useState(LABEL_COLORS[1]);
  const done = () => {
    qc.invalidateQueries({ queryKey: ["labels"] });
    qc.invalidateQueries({ queryKey: ["tasks"] });
    qc.invalidateQueries({ queryKey: ["task"] });
  };
  const create = useMutation({
    mutationFn: () => api.post<Label>("/api/labels", { name, color }),
    onSuccess: () => {
      setName("");
      setColor(LABEL_COLORS[Math.floor(Math.random() * LABEL_COLORS.length)]);
      done();
    },
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { name?: string; color?: string } }) => api.patch(`/api/labels/${id}`, body),
    onSettled: done,
  });
  const canEdit = (l: Label) => !!me && (me.role === "admin" || l.created_by === me.id);
  const error = errorText(create.error || update.error);
  return (
    <Section
      icon={<TagIcon size={15} />}
      title="Labels"
      description="Tag tasks by theme, area or anything else, and filter task lists by them. Anyone can add labels, here or straight from a task. Admins, or whoever created a label, can rename or delete it."
    >
      <div className="max-w-xl space-y-3">
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <ColorPicker label="Color of the new label" value={color} onChange={setColor} />
          <input className={inputClass} placeholder="New label, e.g. Bug or Marketing" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} aria-label="New label name" />
          <Button type="submit" disabled={!name.trim() || create.isPending}>
            Add label
          </Button>
        </form>
        {labels.data && labels.data.length > 0 ? (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {labels.data.map((l) => (
              <li key={l.id} className="flex items-center gap-1.5 py-1 pr-2 pl-1.5">
                <ColorPicker label={`Color of ${l.name}`} value={l.color} disabled={!canEdit(l)} onChange={(c) => update.mutate({ id: l.id, body: { color: c } })} />
                <InlineName label={`Name of ${l.name}`} value={l.name} disabled={!canEdit(l)} onSave={(n) => update.mutate({ id: l.id, body: { name: n } })} />
                <span className="shrink-0 text-[12px] text-ink-3 tabular-nums">
                  {l.task_count} task{l.task_count === 1 ? "" : "s"}
                </span>
                {canDelete(me, l.created_by) ? (
                  <DeleteButton
                    icon
                    what="label"
                    name={l.name}
                    detail={l.task_count ? `It's removed from ${l.task_count} task${l.task_count === 1 ? "" : "s"}. The tasks themselves stay.` : undefined}
                    onDelete={() => api.del(`/api/labels/${l.id}`)}
                    onDone={done}
                    className="h-7 w-7"
                  />
                ) : (
                  <span className="w-7" />
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12px] text-ink-3">No labels yet.</p>
        )}
        {error && <p className="text-[12px] text-danger">{error}</p>}
      </div>
    </Section>
  );
}
