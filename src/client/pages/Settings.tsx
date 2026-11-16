import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bot, Globe, ImageUp, Settings, ShieldCheck, Trash2, Wand2, Webhook, X, Zap } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { type Member, type WorkspaceInfo, api } from "../api";
import { Avatar, Button, Menu, Tag, TopBar, WorkspaceLogo, cx, inputClass, useMe, useMembers, wakeRoute } from "../components";

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
                  <input className={inputClass} value={website} onChange={(e) => setWebsite(e.target.value)} disabled={!isAdmin} placeholder="impulze.ai" inputMode="url" />
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

            <AgentDispatch ws={ws} isAdmin={isAdmin} onSaved={setWs} />

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
                      placeholder={domains.length ? "Add another domain" : "e.g. impulze.ai"}
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
                <span className="font-medium">Send new unassigned tasks to the PM</span>
                <span className="block text-ink-3">When someone creates a task without an assignee, the PM is woken to pick the right agent or person.</span>
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
