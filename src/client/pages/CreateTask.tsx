import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { type Priority, type Status, type Task, PRIORITIES, PRIORITY_LABEL, STATUSES, STATUS_LABEL, api } from "../api";
import { Avatar, Button, Menu, Modal, PriorityIcon, StatusIcon, assigneeOptions, useMembers, useProjects } from "../components";
import { type EditorHandle, RichEditor } from "../editor";

export function CreateTaskModal({
  open,
  onClose,
  defaultProjectId,
  defaultStatus,
}: {
  open: boolean;
  onClose: () => void;
  defaultProjectId?: string;
  defaultStatus?: Status;
}) {
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState<Status>(defaultStatus ?? "todo");
  const [priority, setPriority] = useState<Priority>("none");
  const [assignee, setAssignee] = useState<string>("none");
  const [project, setProject] = useState<string>(defaultProjectId ?? "none");
  const editor = useRef<EditorHandle>(null);
  const members = useMembers();
  const projects = useProjects();
  const qc = useQueryClient();
  const nav = useNavigate();

  useEffect(() => {
    if (open) {
      setTitle("");
      setStatus(defaultStatus ?? "todo");
      setPriority("none");
      setAssignee("none");
      setProject(defaultProjectId ?? "none");
    }
  }, [open, defaultProjectId, defaultStatus]);

  const create = useMutation({
    mutationFn: () =>
      api.post<Task>("/api/tasks", {
        title,
        description: editor.current?.getMarkdown() ?? "",
        status,
        priority,
        assignee_id: assignee === "none" ? null : assignee,
        project_id: project === "none" ? null : project,
      }),
    onSuccess: (t) => {
      qc.invalidateQueries({ queryKey: ["tasks"] });
      onClose();
      nav(`/t/${t.key}`);
    },
  });

  const selectedMember = members.data?.find((m) => m.id === assignee);
  const chip = "flex items-center gap-1.5 rounded-md border border-zinc-200 px-2 py-1 text-xs dark:border-zinc-700";

  return (
    <Modal open={open} onClose={onClose} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim()) create.mutate();
        }}
      >
        <div className="px-5 pt-5">
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Task title"
            className="w-full bg-transparent text-lg font-medium outline-none placeholder:text-zinc-400"
          />
          <div className="mt-2 max-h-[40vh] overflow-auto">
            <RichEditor ref={editor} placeholder="Add a description… what needs to happen, and what does done look like?" onSubmit={() => title.trim() && create.mutate()} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 px-5 py-3">
          <Menu
            trigger={
              <span className={chip}>
                <StatusIcon status={status} /> {STATUS_LABEL[status]}
              </span>
            }
            value={status}
            onChange={setStatus}
            options={STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s], icon: <StatusIcon status={s} /> }))}
          />
          <Menu
            trigger={
              <span className={chip}>
                <PriorityIcon priority={priority} /> {PRIORITY_LABEL[priority]}
              </span>
            }
            value={priority}
            onChange={setPriority}
            options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p], icon: <PriorityIcon priority={p} /> }))}
          />
          <Menu
            searchable
            trigger={
              <span className={chip}>
                <Avatar member={selectedMember} size={14} /> {selectedMember?.name ?? "Assignee"}
              </span>
            }
            value={assignee}
            onChange={setAssignee}
            options={assigneeOptions(members.data)}
          />
          <Menu
            searchable
            trigger={<span className={chip}>{projects.data?.find((p) => p.id === project)?.name ?? "No project"}</span>}
            value={project}
            onChange={setProject}
            options={[
              { value: "none", label: "No project" },
              ...(projects.data ?? []).filter((p) => p.status === "active").map((p) => ({ value: p.id, label: p.name })),
            ]}
          />
        </div>
        <div className="flex items-center justify-between border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">
          <span className="text-xs text-zinc-400">
            {selectedMember?.kind === "agent" ? `${selectedMember.name} will be woken when you create this.` : "⌘↵ to create"}
          </span>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!title.trim() || create.isPending}>
              Create task
            </Button>
          </div>
        </div>
        {create.error && <p className="px-5 pb-3 text-sm text-red-600">{(create.error as Error).message}</p>}
      </form>
    </Modal>
  );
}
