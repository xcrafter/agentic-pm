import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleDot, FolderKanban, ListTodo, Plus, UserRound } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { type Project, api } from "../api";
import { Button, Chip, EmptyState, Field, MemberChip, Menu, Modal, ModalFooter, Tag, TopBar, assigneeOptions, cx, inputClass, textareaClass, useMembers, useProjects, ChevronDown } from "../components";
import { ProjectDot } from "./Layout";

export function ProjectsPage() {
  const projects = useProjects();
  const members = useMembers();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [lead, setLead] = useState("none");
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: () => api.post("/api/projects", { name, description, lead_member_id: lead === "none" ? null : lead }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      setOpen(false);
      setName("");
      setDescription("");
      setLead("none");
    },
  });
  const archive = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "active" | "archived" }) => api.post(`/api/projects/${id}/${status === "archived" ? "archive" : "restore"}`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
      setConfirming(null);
    },
  });
  const [confirming, setConfirming] = useState<Project | null>(null);
  const byId = new Map((members.data ?? []).map((m) => [m.id, m]));
  const cell = "h-11 border-r border-b border-line px-3 text-[13px] whitespace-nowrap";
  const th = "h-9 border-r border-b border-line px-3 text-left text-[12px] font-medium text-ink-3";

  return (
    <div className="flex h-full flex-col">
      <TopBar
        crumbs={[{ label: "Projects", icon: <FolderKanban size={15} className="text-ink-3" /> }]}
        actions={
          <Button variant="primary" onClick={() => setOpen(true)}>
            <Plus size={15} /> New project
          </Button>
        }
      />
      {!projects.data?.length ? (
        <EmptyState
          icon={<FolderKanban size={18} />}
          title="No projects yet"
          action={
            <Button variant="primary" onClick={() => setOpen(true)}>
              <Plus size={15} /> New project
            </Button>
          }
        >
          Projects group related tasks, like a campaign or a launch. Tasks don't need one.
        </EmptyState>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full min-w-[820px] border-separate border-spacing-0">
            <thead className="sticky top-0 bg-canvas">
              <tr>
                <th className={cx(th, "w-[40%]")}>
                  <span className="flex items-center gap-1.5"><FolderKanban size={13} /> Project</span>
                </th>
                <th className={cx(th, "w-[220px]")}>
                  <span className="flex items-center gap-1.5"><ListTodo size={13} /> Progress</span>
                </th>
                <th className={cx(th, "w-[200px]")}>
                  <span className="flex items-center gap-1.5"><UserRound size={13} /> Lead</span>
                </th>
                <th className={cx(th, "w-[120px]")}>
                  <span className="flex items-center gap-1.5"><CircleDot size={13} /> State</span>
                </th>
                <th className="border-b border-line" />
              </tr>
            </thead>
            <tbody>
              {projects.data.map((p) => {
                const pct = p.task_count ? Math.round((p.done_count / p.task_count) * 100) : 0;
                return (
                  <tr key={p.id} onClick={() => nav(`/projects/${p.id}`)} className={cx("group cursor-pointer", p.status === "archived" && "opacity-55")}>
                    <td className={cx(cell, "max-w-0 group-hover:bg-hover")}>
                      <span className="flex min-w-0 items-center gap-2">
                        <ProjectDot id={p.id} />
                        <span className="font-medium">{p.name}</span>
                        {p.description && <span className="truncate text-ink-3">{p.description}</span>}
                      </span>
                    </td>
                    <td className={cx(cell, "group-hover:bg-hover")}>
                      <span className="flex items-center gap-2.5">
                        <span className="h-1.5 w-24 overflow-hidden rounded-full bg-active">
                          <span className="block h-full rounded-full bg-[#1f9d5c]" style={{ width: `${pct}%` }} />
                        </span>
                        <span className="text-[12px] text-ink-3 tabular-nums">
                          {p.done_count} of {p.task_count}
                        </span>
                      </span>
                    </td>
                    <td className={cx(cell, "group-hover:bg-hover")}>
                      {p.lead_member_id ? <MemberChip member={byId.get(p.lead_member_id)} /> : <span className="text-ink-3">—</span>}
                    </td>
                    <td className={cx(cell, "group-hover:bg-hover")}>
                      <span className="flex items-center gap-2">
                        <Tag tone={p.status === "active" ? "green" : "gray"}>{p.status === "active" ? "Active" : "Archived"}</Tag>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 opacity-0 group-hover:opacity-100 focus:opacity-100"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (p.status === "active") (archive.reset(), setConfirming(p));
                            else archive.mutate({ id: p.id, status: "active" });
                          }}
                        >
                          {p.status === "active" ? "Archive" : "Restore"}
                        </Button>
                      </span>
                    </td>
                    <td className="border-b border-line group-hover:bg-hover" />
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <Modal open={!!confirming} onClose={() => setConfirming(null)} title={`Archive ${confirming?.name ?? "project"}?`}>
        {confirming && (
          <>
            <div className="space-y-2 p-4 text-[13px] text-ink-2">
              <p>
                {confirming.task_count
                  ? `Its ${confirming.task_count} task${confirming.task_count === 1 ? " is" : "s are"} archived with it${
                      confirming.open_count ? `, including ${confirming.open_count} not done yet` : ""
                    }. They leave task lists and search, and agents won't be woken on them.`
                  : "It has no tasks."}
              </p>
              <p className="text-ink-3">Restore the project any time to bring everything back as it was. Nothing is deleted.</p>
              {archive.error && <p className="text-danger">{(archive.error as Error).message}</p>}
            </div>
            <ModalFooter>
              <Button type="button" variant="ghost" onClick={() => setConfirming(null)}>
                Cancel
              </Button>
              <Button variant="primary" disabled={archive.isPending} onClick={() => archive.mutate({ id: confirming.id, status: "archived" })}>
                {confirming.task_count ? "Archive project and tasks" : "Archive project"}
              </Button>
            </ModalFooter>
          </>
        )}
      </Modal>
      <Modal open={open} onClose={() => setOpen(false)} title="New project">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <div className="space-y-4 p-4">
            <Field label="Name">
              <input autoFocus className={inputClass} placeholder="Q1 outbound to SaaS founders" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Description" hint="Optional.">
              <textarea className={textareaClass} rows={3} placeholder="What is this project for?" value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
            <Field label="Lead">
              <Menu
                searchable
                trigger={
                  <Chip>
                    <MemberChip member={byId.get(lead)} size={16} /> <ChevronDown size={13} />
                  </Chip>
                }
                value={lead}
                onChange={setLead}
                options={assigneeOptions(members.data)}
              />
            </Field>
            {create.error && <p className="text-[13px] text-[#c4312b]">{(create.error as Error).message}</p>}
          </div>
          <ModalFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!name.trim() || create.isPending}>
              Create project
            </Button>
          </ModalFooter>
        </form>
      </Modal>
    </div>
  );
}
