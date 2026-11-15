import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { type Priority, type Status, type Task, PRIORITIES, PRIORITY_LABEL, STATUSES, STATUS_LABEL, api } from "../api";
import { Button, Chip, MemberChip, Menu, Modal, ModalFooter, PriorityIcon, StatusIcon, assigneeOptions, useMembers, useProjects } from "../components";
import { FolderKanban } from "lucide-react";
import { ProjectDot } from "./Layout";
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

  return (
    <Modal open={open} onClose={onClose} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim()) create.mutate();
        }}
      >
        <div className="px-4 pt-4">
          <div className="mb-3 text-[12px] font-medium text-ink-3">New task</div>
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Task title"
            aria-label="Task title"
            className="w-full bg-transparent text-[18px] font-semibold tracking-[-0.01em] outline-none placeholder:text-ink-3"
          />
          <div className="mt-2 max-h-[40vh] overflow-auto text-[14px]">
            <RichEditor ref={editor} placeholder="Add a description… what needs to happen, and what does done look like?" onSubmit={() => title.trim() && create.mutate()} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <Menu
            trigger={
              <Chip>
                <StatusIcon status={status} size={13} /> {STATUS_LABEL[status]}
              </Chip>
            }
            value={status}
            onChange={setStatus}
            options={STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s], icon: <StatusIcon status={s} /> }))}
          />
          <Menu
            trigger={
              <Chip>
                <PriorityIcon priority={priority} size={13} /> {PRIORITY_LABEL[priority]}
              </Chip>
            }
            value={priority}
            onChange={setPriority}
            options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p], icon: <PriorityIcon priority={p} /> }))}
          />
          <Menu
            searchable
            trigger={
              <Chip>
                <MemberChip member={selectedMember} size={15} />
              </Chip>
            }
            value={assignee}
            onChange={setAssignee}
            options={assigneeOptions(members.data)}
          />
          <Menu
            searchable
            trigger={
              <Chip>
                {project !== "none" ? <ProjectDot id={project} /> : <FolderKanban size={13} />}
                {projects.data?.find((p) => p.id === project)?.name ?? "No project"}
              </Chip>
            }
            value={project}
            onChange={setProject}
            options={[
              { value: "none", label: "No project" },
              ...(projects.data ?? []).filter((p) => p.status === "active").map((p) => ({ value: p.id, label: p.name, icon: <ProjectDot id={p.id} /> })),
            ]}
          />
        </div>
        {create.error && <p className="px-4 pb-3 text-[13px] text-[#c4312b]">{(create.error as Error).message}</p>}
        <ModalFooter
          hint={
            selectedMember?.kind === "agent" ? (
              <span className="text-agent">{selectedMember.name} is woken as soon as you create this.</span>
            ) : (
              "⌘ Enter to create"
            )
          }
        >
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!title.trim() || create.isPending}>
            Create task
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
