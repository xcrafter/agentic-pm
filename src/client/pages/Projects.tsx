import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleDot, FolderKanban, ListTodo, Pencil, Plus, Trash2, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { type Project, api } from "../api";
import {
  Button,
  Chip,
  EmptyState,
  Field,
  IconButton,
  MemberChip,
  Menu,
  Modal,
  ModalFooter,
  Tag,
  TopBar,
  assigneeOptions,
  canDelete,
  cx,
  inputClass,
  textareaClass,
  useMe,
  useMembers,
  useProjects,
  ChevronDown,
} from "../components";
import { ProjectDot } from "./Layout";

export function ProjectsPage() {
  const projects = useProjects();
  const members = useMembers();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const me = useMe().data?.member;
  const qc = useQueryClient();
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
                    <td className="border-b border-line px-2 group-hover:bg-hover">
                      <span className="flex items-center justify-end gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                        <IconButton
                          label={`Edit ${p.name}`}
                          className="h-7 w-7"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditing(p);
                          }}
                        >
                          <Pencil size={13} />
                        </IconButton>
                        {canDelete(me, p.created_by) && (
                          <IconButton
                            label={`Delete ${p.name}`}
                            className="h-7 w-7 hover:text-danger"
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeleting(p);
                            }}
                          >
                            <Trash2 size={13} />
                          </IconButton>
                        )}
                      </span>
                    </td>
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
      <ProjectFormModal open={open} onClose={() => setOpen(false)} />
      <ProjectFormModal open={!!editing} project={editing} onClose={() => setEditing(null)} />
      <DeleteProjectModal project={deleting} onClose={() => setDeleting(null)} />
    </div>
  );
}

/** Create a project, or edit one when `project` is given. */
export function ProjectFormModal({ open, project, onClose }: { open: boolean; project?: Project | null; onClose: () => void }) {
  const members = useMembers();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [lead, setLead] = useState("none");
  const byId = new Map((members.data ?? []).map((m) => [m.id, m]));
  useEffect(() => {
    if (!open) return;
    setName(project?.name ?? "");
    setDescription(project?.description ?? "");
    setLead(project?.lead_member_id ?? "none");
    save.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project?.id]);
  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), description, lead_member_id: lead === "none" ? null : lead };
      return project ? api.patch(`/api/projects/${project.id}`, body) : api.post("/api/projects", body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
      onClose();
    },
  });
  return (
    <Modal open={open} onClose={onClose} title={project ? `Edit ${project.name}` : "New project"}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) save.mutate();
        }}
      >
        <div className="space-y-4 p-4">
          <Field label="Name">
            <input autoFocus className={inputClass} placeholder="Q1 outbound to SaaS founders" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
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
          {save.error && <p className="text-[13px] text-danger">{(save.error as Error).message}</p>}
        </div>
        <ModalFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!name.trim() || save.isPending}>
            {project ? (save.isPending ? "Saving…" : "Save changes") : "Create project"}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

/**
 * Delete a project. Its tasks stay (moved out to "no project") unless the person ticks the box to delete
 * them too, which only admins can do.
 */
export function DeleteProjectModal({ project, onClose, onDeleted }: { project: Project | null; onClose: () => void; onDeleted?: () => void }) {
  const me = useMe().data?.member;
  const qc = useQueryClient();
  const [withTasks, setWithTasks] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  useEffect(() => {
    setWithTasks(false);
    setConfirmText("");
    remove.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);
  const remove = useMutation({
    mutationFn: () => api.del(`/api/projects/${project!.id}${withTasks ? "?tasks=delete" : ""}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
      qc.invalidateQueries({ queryKey: ["task"] });
      onClose();
      onDeleted?.();
    },
  });
  const n = project?.task_count ?? 0;
  const tasksWord = `${n} task${n === 1 ? "" : "s"}`;
  const isAdmin = me?.role === "admin";
  // Deleting tasks can't be undone, so ask for the project's name first.
  const needsConfirm = withTasks && n > 0;
  const confirmed = !needsConfirm || confirmText.trim() === project?.name;
  return (
    <Modal open={!!project} onClose={() => !remove.isPending && onClose()} title={`Delete ${project?.name ?? "project"}?`}>
      {project && (
        <>
          <div className="space-y-3 p-4 text-[13px] leading-relaxed text-ink-2">
            <p>
              The project will be deleted. This can't be undone.{" "}
              {n === 0
                ? "It has no tasks."
                : withTasks
                  ? `Its ${tasksWord} will be deleted too, with their threads, notes, checklists and files.`
                  : `Its ${tasksWord} will stay, with no project${project.status === "archived" ? ", and come back into task lists" : ""}.`}
            </p>
            {n > 0 &&
              (isAdmin ? (
                <label className="flex w-fit cursor-pointer items-start gap-2 rounded-lg border border-line px-2.5 py-2 text-ink hover:bg-hover">
                  <input type="checkbox" className="mt-0.5" checked={withTasks} onChange={(e) => setWithTasks(e.target.checked)} />
                  <span>
                    Also delete its {tasksWord}
                    {project.open_count ? <span className="text-ink-3"> ({project.open_count} not done yet)</span> : null}
                  </span>
                </label>
              ) : (
                <p className="text-ink-3">Only admins can delete a project's tasks along with it.</p>
              ))}
            {needsConfirm && (
              <Field label={`Type ${project.name} to confirm`}>
                <input className={inputClass} value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoFocus />
              </Field>
            )}
            {remove.error && <p className="text-danger">{(remove.error as Error).message}</p>}
          </div>
          <ModalFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={remove.isPending}>
              Cancel
            </Button>
            <Button variant="danger" disabled={remove.isPending || !confirmed} onClick={() => remove.mutate()}>
              {remove.isPending ? "Deleting…" : withTasks && n > 0 ? `Delete project and ${tasksWord}` : "Delete project"}
            </Button>
          </ModalFooter>
        </>
      )}
    </Modal>
  );
}
