import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type Member, api } from "../api";
import { AgentBadge, Avatar, Button, Modal, cx, inputClass, timeAgo, useMe, useMembers } from "../components";

interface Connection {
  id: string;
  client_name: string;
  scope: string[];
  created_at: string | null;
  connected_by: string | null;
}

export function MembersPage() {
  const me = useMe().data!.member!;
  const members = useMembers();
  const [editing, setEditing] = useState<Member | "new" | null>(null);
  const isAdmin = me.role === "admin";
  const agents = (members.data ?? []).filter((m) => m.kind === "agent");
  const humans = (members.data ?? []).filter((m) => m.kind === "human");

  return (
    <div>
      <header className="flex items-center border-b border-zinc-200 px-4 py-2.5 md:px-6 dark:border-zinc-800">
        <h1 className="text-[15px] font-semibold">Members & agents</h1>
        {isAdmin && (
          <Button variant="primary" className="ml-auto" onClick={() => setEditing("new")}>
            Add agent
          </Button>
        )}
      </header>
      <div className="mx-auto max-w-4xl space-y-8 px-4 py-6 md:px-6">
        <McpHelp />
        <section>
          <h2 className="mb-2 text-xs font-medium tracking-wide text-zinc-500 uppercase">Agents</h2>
          <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
            {agents.map((a) => (
              <li key={a.id} className={cx("flex items-center gap-3 px-4 py-3", !a.active && "opacity-50")}>
                <Avatar member={a} size={28} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {a.name} <span className="font-normal text-zinc-400">@{a.handle}</span>
                    {!a.active && <span className="text-xs text-zinc-400">deactivated</span>}
                  </div>
                  <div className="truncate text-xs text-zinc-500">{a.description || "No description"}</div>
                </div>
                <span className={cx("text-xs", a.has_webhook ? "text-emerald-600" : "text-amber-600")}>
                  {a.has_webhook ? "Webhook set" : "No webhook"}
                </span>
                {isAdmin && (
                  <Button variant="ghost" className="text-xs" onClick={() => setEditing(a)}>
                    Configure
                  </Button>
                )}
              </li>
            ))}
            {!agents.length && (
              <li className="px-4 py-8 text-center text-sm text-zinc-400">
                No agents yet. {isAdmin ? "Add one to start assigning work to it." : "Ask an admin to add one."}
              </li>
            )}
          </ul>
        </section>
        <section>
          <h2 className="mb-2 text-xs font-medium tracking-wide text-zinc-500 uppercase">People</h2>
          <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
            {humans.map((h) => (
              <HumanRow key={h.id} member={h} me={me} />
            ))}
          </ul>
        </section>
      </div>
      {editing && <AgentModal agent={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function McpHelp() {
  const url = `${location.origin}/mcp`;
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-sm dark:border-zinc-800 dark:bg-zinc-900/50">
      <div className="font-medium">Connect an assistant (Grok Bot, Claude, …)</div>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-[13px] text-zinc-600 dark:text-zinc-400">
        <li>Add the agent here, then paste its routine's webhook URL and key (Grok Bot: Routine → Trigger → Webhook).</li>
        <li>
          In the assistant, add a custom MCP server with this URL and sign in. Choose which agent the connection acts as.
          <div className="mt-1.5 flex items-center gap-2">
            <code className="rounded bg-white px-2 py-1 text-xs dark:bg-zinc-950">{url}</code>
            <button
              className="text-xs text-accent"
              onClick={() => {
                navigator.clipboard.writeText(url);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </li>
        <li>Use “Send test ping” to check the webhook. Assigning a task to the agent then wakes it.</li>
      </ol>
    </div>
  );
}

function HumanRow({ member, me }: { member: Member; me: Member }) {
  const qc = useQueryClient();
  const update = useMutation({
    mutationFn: (b: Record<string, unknown>) => api.patch(`/api/members/${member.id}`, b),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["members"] }),
  });
  const [showConn, setShowConn] = useState(false);
  const canManage = me.role === "admin" && member.id !== me.id;
  return (
    <li className={cx("px-4 py-3", !member.active && "opacity-50")}>
      <div className="flex items-center gap-3">
        <Avatar member={member} size={28} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">
            {member.name} <span className="font-normal text-zinc-400">@{member.handle}</span>
          </div>
          <div className="text-xs text-zinc-500">{member.email}</div>
        </div>
        <span className="text-xs text-zinc-500 capitalize">{member.role}</span>
        {(member.id === me.id || me.role === "admin") && (
          <Button variant="ghost" className="text-xs" onClick={() => setShowConn((s) => !s)}>
            Connections
          </Button>
        )}
        {canManage && (
          <>
            <Button variant="ghost" className="text-xs" onClick={() => update.mutate({ role: member.role === "admin" ? "member" : "admin" })}>
              {member.role === "admin" ? "Make member" : "Make admin"}
            </Button>
            <Button variant="ghost" className="text-xs" onClick={() => update.mutate({ active: !member.active })}>
              {member.active ? "Deactivate" : "Reactivate"}
            </Button>
          </>
        )}
      </div>
      {showConn && <Connections memberId={member.id} />}
    </li>
  );
}

function Connections({ memberId }: { memberId: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["connections", memberId], queryFn: () => api.get<Connection[]>(`/api/members/${memberId}/connections`) });
  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/api/members/${memberId}/connections/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["connections", memberId] }),
  });
  return (
    <div className="mt-3 rounded-md border border-zinc-200 p-3 text-xs dark:border-zinc-800">
      <div className="mb-1 font-medium text-zinc-500">MCP connections</div>
      {q.isLoading && <div className="text-zinc-400">Loading…</div>}
      {q.data?.length === 0 && <div className="text-zinc-400">No assistants connected.</div>}
      <ul className="space-y-1">
        {q.data?.map((c) => (
          <li key={c.id} className="flex items-center gap-2">
            <span className="font-medium">{c.client_name}</span>
            <span className="text-zinc-400">
              {c.connected_by ? `by ${c.connected_by}` : ""} {c.created_at ? `· ${timeAgo(c.created_at)}` : ""}
            </span>
            <button className="ml-auto text-red-600 hover:underline" onClick={() => revoke.mutate(c.id)}>
              Revoke
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AgentModal({ agent, onClose }: { agent: Member | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(agent?.name ?? "");
  const [handle, setHandle] = useState(agent?.handle ?? "");
  const [description, setDescription] = useState(agent?.description ?? "");
  const [avatar, setAvatar] = useState(agent?.avatar_url ?? "");
  const [webhookUrl, setWebhookUrl] = useState(agent?.webhook_url ?? "");
  const [webhookKey, setWebhookKey] = useState("");
  const [wakeOnMention, setWakeOnMention] = useState(agent?.wake_on_mention ?? true);
  const [maxRuns, setMaxRuns] = useState(agent?.max_runs_per_hour ?? 10);
  const [ping, setPing] = useState<{ ok: boolean; status: number; body: string } | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        name,
        description,
        avatar_url: avatar || null,
        webhook_url: webhookUrl || null,
        wake_on_mention: wakeOnMention,
        max_runs_per_hour: maxRuns,
      };
      if (webhookKey) body.webhook_key = webhookKey;
      if (agent) return api.patch<Member>(`/api/members/${agent.id}`, body);
      return api.post<Member>("/api/members/agents", { ...body, handle: handle || undefined });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["members"] });
      onClose();
    },
  });
  const testPing = useMutation({
    mutationFn: () => api.post<{ ok: boolean; status: number; body: string }>(`/api/members/${agent!.id}/test-ping`),
    onSuccess: setPing,
  });
  const toggleActive = useMutation({
    mutationFn: () => api.patch(`/api/members/${agent!.id}`, { active: !agent!.active }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["members"] });
      onClose();
    },
  });
  const label = "mb-1 block text-xs font-medium text-zinc-500";

  return (
    <Modal open onClose={onClose} wide>
      <form
        className="space-y-3 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) save.mutate();
        }}
      >
        <div className="flex items-center gap-2">
          <h2 className="font-semibold">{agent ? `Configure ${agent.name}` : "Add agent"}</h2>
          <AgentBadge />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className={label}>Name</label>
            <input autoFocus className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="Grok Bot – Research" />
          </div>
          <div>
            <label className={label}>Handle (for @mentions)</label>
            <input
              className={inputClass}
              value={handle}
              disabled={!!agent}
              onChange={(e) => setHandle(e.target.value)}
              placeholder="research-bot"
            />
          </div>
        </div>
        <div>
          <label className={label}>What is this agent good at?</label>
          <textarea className={inputClass} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Market research, competitor summaries, drafting briefs" />
        </div>
        <div>
          <label className={label}>Avatar URL (optional)</label>
          <input className={inputClass} value={avatar} onChange={(e) => setAvatar(e.target.value)} />
        </div>
        <div className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
          <div className="mb-2 text-xs font-medium">Wake-up webhook</div>
          <label className={label}>Webhook URL</label>
          <input className={inputClass} value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://…" />
          <label className={cx(label, "mt-2")}>Webhook key (sent as Bearer token)</label>
          <input
            className={inputClass}
            type="password"
            value={webhookKey}
            onChange={(e) => setWebhookKey(e.target.value)}
            placeholder={agent?.has_webhook ? "•••••• (unchanged — type to replace)" : "Paste the routine's secret key"}
          />
          <div className="mt-3 flex flex-wrap items-center gap-4 text-xs">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={wakeOnMention} onChange={(e) => setWakeOnMention(e.target.checked)} /> Wake when @mentioned
            </label>
            <label className="flex items-center gap-1.5">
              Max runs / hour
              <input
                type="number"
                min={1}
                max={1000}
                value={maxRuns}
                onChange={(e) => setMaxRuns(Number(e.target.value))}
                className="w-16 rounded border border-zinc-200 bg-transparent px-1.5 py-0.5 dark:border-zinc-700"
              />
            </label>
          </div>
          {agent && (
            <div className="mt-3 flex items-center gap-2">
              <Button type="button" className="text-xs" onClick={() => testPing.mutate()} disabled={testPing.isPending || !agent.has_webhook}>
                {testPing.isPending ? "Pinging…" : "Send test ping"}
              </Button>
              {ping && (
                <span className={cx("truncate text-xs", ping.ok ? "text-emerald-600" : "text-red-600")}>
                  {ping.ok ? "Agent accepted the ping (200). Check its chat for the run." : `Failed: ${ping.status || ""} ${ping.body}`}
                </span>
              )}
            </div>
          )}
        </div>
        {agent && <Connections memberId={agent.id} />}
        <div className="flex items-center gap-2 pt-2">
          {agent && (
            <Button type="button" variant="danger" onClick={() => toggleActive.mutate()}>
              {agent.active ? "Deactivate" : "Reactivate"}
            </Button>
          )}
          <Button type="button" variant="ghost" className="ml-auto" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!name.trim() || save.isPending}>
            {agent ? "Save" : "Add agent"}
          </Button>
        </div>
        {save.error && <p className="text-sm text-red-600">{(save.error as Error).message}</p>}
      </form>
    </Modal>
  );
}
