import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { Avatar, Button, Menu, Modal, assigneeOptions, cx, inputClass, useMembers, useProjects } from "../components";

export function ProjectsPage() {
  const projects = useProjects();
  const members = useMembers();
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
    mutationFn: ({ id, status }: { id: string; status: "active" | "archived" }) => api.patch(`/api/projects/${id}`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
  const byId = new Map((members.data ?? []).map((m) => [m.id, m]));

  return (
    <div>
      <header className="flex items-center border-b border-zinc-200 px-4 py-2.5 md:px-6 dark:border-zinc-800">
        <h1 className="text-[15px] font-semibold">Projects</h1>
        <Button variant="primary" className="ml-auto" onClick={() => setOpen(true)}>
          New project
        </Button>
      </header>
      <div className="mx-auto max-w-4xl px-4 py-6 md:px-6">
        <p className="mb-4 text-sm text-zinc-500">Projects group related tasks. Tasks don't need a project.</p>
        <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {projects.data?.map((p) => {
            const pct = p.task_count ? Math.round((p.done_count / p.task_count) * 100) : 0;
            return (
              <li key={p.id} className={cx("flex items-center gap-4 px-4 py-3", p.status === "archived" && "opacity-50")}>
                <div className="min-w-0 flex-1">
                  <Link to={`/projects/${p.id}`} className="font-medium hover:underline">
                    {p.name}
                  </Link>
                  {p.description && <p className="truncate text-xs text-zinc-500">{p.description}</p>}
                </div>
                <div className="hidden w-32 sm:block">
                  <div className="h-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                    <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="mt-1 text-[11px] text-zinc-400">
                    {p.done_count}/{p.task_count} done
                  </div>
                </div>
                <Avatar member={p.lead_member_id ? byId.get(p.lead_member_id) : null} size={20} />
                <Button variant="ghost" className="text-xs" onClick={() => archive.mutate({ id: p.id, status: p.status === "active" ? "archived" : "active" })}>
                  {p.status === "active" ? "Archive" : "Restore"}
                </Button>
              </li>
            );
          })}
          {!projects.data?.length && <li className="px-4 py-8 text-center text-sm text-zinc-400">No projects yet.</li>}
        </ul>
      </div>
      <Modal open={open} onClose={() => setOpen(false)}>
        <form
          className="space-y-3 p-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <h2 className="font-semibold">New project</h2>
          <input autoFocus className={inputClass} placeholder="Project name" value={name} onChange={(e) => setName(e.target.value)} />
          <textarea className={inputClass} rows={3} placeholder="What is this project about?" value={description} onChange={(e) => setDescription(e.target.value)} />
          <div className="flex items-center gap-2 text-sm">
            <span className="text-zinc-500">Lead</span>
            <Menu
              searchable
              trigger={
                <span className="flex items-center gap-1.5 rounded-md border border-zinc-200 px-2 py-1 text-xs dark:border-zinc-700">
                  <Avatar member={byId.get(lead)} size={14} /> {byId.get(lead)?.name ?? "No lead"}
                </span>
              }
              value={lead}
              onChange={setLead}
              options={assigneeOptions(members.data)}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!name.trim() || create.isPending}>
              Create project
            </Button>
          </div>
          {create.error && <p className="text-sm text-red-600">{(create.error as Error).message}</p>}
        </form>
      </Modal>
    </div>
  );
}
