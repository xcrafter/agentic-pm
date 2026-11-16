import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Globe, ImageUp, Settings, ShieldCheck, Trash2, Wand2, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { type WorkspaceInfo, api } from "../api";
import { Button, Tag, TopBar, WorkspaceLogo, cx, inputClass, useMe } from "../components";

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
