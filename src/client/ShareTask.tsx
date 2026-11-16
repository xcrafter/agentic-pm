import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Link2 } from "lucide-react";
import { useState } from "react";
import { api } from "./api";
import { Button, Field, Modal, ModalFooter, Tag, cx, inputClass, timeAgo, useMe, useMembers } from "./components";

export interface TaskShare {
  id: string;
  url: string;
  markdown_url: string;
  mode: "read" | "reply";
  label: string;
  created_by: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  use_count: number;
  active: boolean;
}

const EXPIRY = [
  { days: 1, label: "1 day" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 0, label: "Never" },
];

/** The text to paste into Claude, ChatGPT, Cursor… so it picks up the task and reports back. */
export function promptFor(s: TaskShare) {
  const lines = [`Please work on this task from our tracker. Read the full task here: ${s.markdown_url}`];
  if (s.mode === "reply") {
    lines.push(
      "",
      `When you make progress, get stuck, or finish, post an update back to the task: send a POST request to ${s.url}/messages with a JSON body like {"body": "what you did and anything still open", "type": "update", "author": "Claude"}. The task page has a curl example.`,
    );
  } else {
    lines.push("", "When you're done, give me a short summary I can paste back into the task.");
  }
  return lines.join("\n");
}

function CopyButton({ text, label, primary }: { text: string; label: string; primary?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      variant={primary ? "primary" : "secondary"}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          window.prompt("Copy this:", text);
        }
      }}
    >
      {done ? <Check size={13} /> : <Copy size={13} />}
      {done ? "Copied" : label}
    </Button>
  );
}

export function ShareTaskButton({ taskKey }: { taskKey: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Link2 size={14} />
        Share
      </Button>
      <ShareTaskModal open={open} onClose={() => setOpen(false)} taskKey={taskKey} />
    </>
  );
}

function ShareTaskModal({ open, onClose, taskKey }: { open: boolean; onClose: () => void; taskKey: string }) {
  const qc = useQueryClient();
  const me = useMe().data?.member;
  const members = useMembers().data ?? [];
  const nameOf = (id: string) => members.find((m) => m.id === id)?.name ?? "someone";
  const shares = useQuery({
    queryKey: ["shares", taskKey],
    queryFn: () => api.get<TaskShare[]>(`/api/tasks/${taskKey}/shares`),
    enabled: open,
  });
  const [mode, setMode] = useState<"read" | "reply">("reply");
  const [days, setDays] = useState(7);
  const [label, setLabel] = useState("Claude");
  const create = useMutation({
    mutationFn: () => api.post<TaskShare>(`/api/tasks/${taskKey}/shares`, { mode, expires_in_days: days, label }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["shares", taskKey] }),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/api/shares/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["shares", taskKey] }),
  });

  const list = (shares.data ?? []).filter((s) => s.active);

  return (
    <Modal open={open} onClose={onClose} wide title={`Share ${taskKey}`}>
      <div className="space-y-4 px-4 py-4">
        <p className="text-[13px] text-ink-2">
          Anyone with the link can read this task (description, checklists, notes, files and thread) without signing in. Use it to hand the
          task to Claude, ChatGPT, Cursor or someone outside the workspace.
        </p>

        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <Field label="Who it's for" hint="Shown next to messages they post back.">
            <input className={inputClass} value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} placeholder="Claude" />
          </Field>
          <Field label="Expires">
            <div className="flex h-8 overflow-hidden rounded-lg border border-line-strong">
              {EXPIRY.map((o) => (
                <button
                  key={o.days}
                  type="button"
                  onClick={() => setDays(o.days)}
                  className={cx("px-2.5 text-[12px] whitespace-nowrap", days === o.days ? "bg-accent text-white" : "bg-canvas text-ink-2 hover:bg-hover")}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </Field>
        </div>

        <label className="flex cursor-pointer items-start gap-2.5 text-[13px]">
          <input type="checkbox" className="mt-0.5" checked={mode === "reply"} onChange={(e) => setMode(e.target.checked ? "reply" : "read")} />
          <span>
            <span className="font-medium">Let them post updates back</span>
            <span className="block text-[12px] text-ink-3">
              The link also accepts messages, which show up in this task's thread. They can't change the task or wake agents.
            </span>
          </span>
        </label>

        {create.error && <p className="text-[12px] text-danger">{(create.error as Error).message}</p>}

        {list.length > 0 && (
          <div className="space-y-2">
            <div className="text-[13px] font-medium">Active links</div>
            <ul className="divide-y divide-line rounded-lg border border-line">
              {list.map((s) => (
                <li key={s.id} className="space-y-2 px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-ink-3">
                    <span className="font-medium text-ink">{s.label || "Share link"}</span>
                    <Tag tone={s.mode === "reply" ? "blue" : "gray"}>{s.mode === "reply" ? "Read & reply" : "Read only"}</Tag>
                    <span>
                      by {nameOf(s.created_by)} {timeAgo(s.created_at)}
                    </span>
                    <span>· {s.expires_at ? `expires ${new Date(s.expires_at).toLocaleDateString()}` : "never expires"}</span>
                    <span>· {s.use_count ? `opened ${s.use_count}×, last ${timeAgo(s.last_used_at!)}` : "not opened yet"}</span>
                  </div>
                  <input readOnly className={cx(inputClass, "font-mono text-[12px]")} value={s.url} onFocus={(e) => e.currentTarget.select()} />
                  <div className="flex flex-wrap gap-2">
                    <CopyButton primary text={promptFor(s)} label="Copy prompt for AI" />
                    <CopyButton text={s.url} label="Copy link" />
                    <a href={s.url} target="_blank" rel="noreferrer" className="inline-flex h-7 items-center rounded-lg px-2 text-[12px] text-ink-2 hover:bg-hover">
                      Open
                    </a>
                    {(s.created_by === me?.id || me?.role === "admin") && (
                      <Button size="sm" variant="ghost" className="ml-auto text-danger" disabled={revoke.isPending} onClick={() => revoke.mutate(s.id)}>
                        Turn off
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <ModalFooter hint="Turning a link off stops it working immediately.">
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
        <Button variant="primary" disabled={create.isPending} onClick={() => create.mutate()}>
          <Link2 size={14} />
          {create.isPending ? "Creating…" : "Create link"}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
