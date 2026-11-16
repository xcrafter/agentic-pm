/**
 * Deleting things. Only people can delete (agents can't, over MCP or otherwise):
 * admins can delete anything; anyone can delete what they wrote themselves.
 * Deleting a whole task is admins only. Everything removed is logged in the activity table.
 */
import type { Actor, MemberRow, TaskRow, WorkspaceRow } from "./domain";
import { addSystemEntry, logActivity, notify, taskKey } from "./domain";
import { type AppEnv, HttpError, forbidden, notFound, nowIso } from "./util";

function requireCanDelete(me: MemberRow, ownerId: string | null, what: string) {
  if (me.kind !== "human") throw forbidden("Agents can't delete");
  if (me.role !== "admin" && ownerId !== me.id) throw forbidden(`Only admins or whoever added this ${what} can delete it`);
}

async function taskOf(env: AppEnv, ws: WorkspaceRow, taskId: string) {
  const t = await env.DB.prepare("SELECT * FROM tasks WHERE id = ? AND workspace_id = ?").bind(taskId, ws.id).first<TaskRow>();
  if (!t) throw notFound("Task");
  return t;
}

export async function deleteNote(env: AppEnv, ws: WorkspaceRow, actor: Actor, noteId: string) {
  const note = await env.DB.prepare(
    "SELECT n.* FROM notes n JOIN tasks t ON t.id = n.task_id WHERE n.id = ? AND t.workspace_id = ?",
  )
    .bind(noteId, ws.id)
    .first<{ id: string; task_id: string; title: string; content: string; created_by: string }>();
  if (!note) throw notFound("Note");
  requireCanDelete(actor.member, note.created_by, "note");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM note_revisions WHERE note_id = ?").bind(noteId),
    env.DB.prepare("DELETE FROM notes WHERE id = ?").bind(noteId),
  ]);
  await logActivity(env, ws.id, actor, "note", noteId, "deleted", { task_id: note.task_id, title: note.title, content: note.content });
  await addSystemEntry(env, await taskOf(env, ws, note.task_id), actor.member, "note_deleted", { title: note.title });
  await notify(env, ws.id, { type: "notes", task_id: note.task_id });
}

export async function deleteChecklist(env: AppEnv, ws: WorkspaceRow, actor: Actor, checklistId: string) {
  const cl = await env.DB.prepare(
    "SELECT c.* FROM checklists c JOIN tasks t ON t.id = c.task_id WHERE c.id = ? AND t.workspace_id = ?",
  )
    .bind(checklistId, ws.id)
    .first<{ id: string; task_id: string; title: string; created_by: string }>();
  if (!cl) throw notFound("Checklist");
  requireCanDelete(actor.member, cl.created_by, "checklist");
  const items = await env.DB.prepare("SELECT text, done FROM checklist_items WHERE checklist_id = ?").bind(checklistId).all();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM checklist_items WHERE checklist_id = ?").bind(checklistId),
    env.DB.prepare("DELETE FROM checklists WHERE id = ?").bind(checklistId),
  ]);
  await logActivity(env, ws.id, actor, "checklist", checklistId, "deleted", { task_id: cl.task_id, title: cl.title, items: items.results });
  await addSystemEntry(env, await taskOf(env, ws, cl.task_id), actor.member, "checklist_deleted", { title: cl.title });
  await notify(env, ws.id, { type: "checklists", task_id: cl.task_id });
}

export async function deleteAttachment(env: AppEnv, ws: WorkspaceRow, actor: Actor, attachmentId: string) {
  const a = await env.DB.prepare(
    "SELECT a.* FROM attachments a JOIN tasks t ON t.id = a.task_id WHERE a.id = ? AND t.workspace_id = ?",
  )
    .bind(attachmentId, ws.id)
    .first<{ id: string; task_id: string; filename: string; r2_key: string; uploaded_by: string; size: number }>();
  if (!a) throw notFound("File");
  requireCanDelete(actor.member, a.uploaded_by, "file");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM attachments WHERE id = ?").bind(attachmentId),
    // The thread keeps "X attached file.pdf", marked as removed.
    env.DB.prepare(
      "UPDATE thread_entries SET data = json_set(data, '$.deleted', json('true')) WHERE task_id = ? AND type = 'attachment_added' AND json_extract(data, '$.attachment_id') = ?",
    ).bind(a.task_id, attachmentId),
  ]);
  await env.FILES.delete(a.r2_key);
  await logActivity(env, ws.id, actor, "attachment", attachmentId, "deleted", { task_id: a.task_id, filename: a.filename, size: a.size });
  await addSystemEntry(env, await taskOf(env, ws, a.task_id), actor.member, "attachment_deleted", { filename: a.filename });
  await notify(env, ws.id, { type: "thread", task_id: a.task_id });
}

/**
 * Thread messages are blanked rather than removed, so replies and agent runs that point at them stay
 * intact; the thread shows "message deleted". Open questions must be answered first.
 */
export async function deleteEntry(env: AppEnv, ws: WorkspaceRow, actor: Actor, entryId: string) {
  const e = await env.DB.prepare(
    "SELECT e.* FROM thread_entries e JOIN tasks t ON t.id = e.task_id WHERE e.id = ? AND t.workspace_id = ?",
  )
    .bind(entryId, ws.id)
    .first<{ id: string; task_id: string; author_id: string; type: string; body: string; data: string }>();
  if (!e) throw notFound("Message");
  if (!["comment", "update", "answer", "question"].includes(e.type)) throw new HttpError(400, "Only messages can be deleted");
  if (e.type === "question" && JSON.parse(e.data || "{}").state === "open") {
    throw new HttpError(400, "Answer this question before deleting it, so the agent isn't left waiting");
  }
  requireCanDelete(actor.member, e.author_id, "message");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM thread_entry_revisions WHERE entry_id = ?").bind(entryId),
    env.DB.prepare("UPDATE thread_entries SET body = '', data = json_set(data, '$.deleted', json('true'), '$.deleted_by', ?), edited_at = ? WHERE id = ?").bind(
      actor.member.id,
      nowIso(),
      entryId,
    ),
  ]);
  await logActivity(env, ws.id, actor, "thread_entry", entryId, "deleted", { task_id: e.task_id, type: e.type, body: e.body });
  await notify(env, ws.id, { type: "thread", task_id: e.task_id });
}

/** Admins only. Removes the task and everything on it, including files in storage. */
export async function deleteTask(env: AppEnv, ws: WorkspaceRow, actor: Actor, task: TaskRow) {
  if (actor.member.kind !== "human" || actor.member.role !== "admin") throw forbidden("Only admins can delete tasks");
  const files = await env.DB.prepare("SELECT r2_key FROM attachments WHERE task_id = ?").bind(task.id).all<{ r2_key: string }>();
  const id = task.id;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM thread_entry_revisions WHERE entry_id IN (SELECT id FROM thread_entries WHERE task_id = ?)").bind(id),
    env.DB.prepare("DELETE FROM note_revisions WHERE note_id IN (SELECT id FROM notes WHERE task_id = ?)").bind(id),
    env.DB.prepare("DELETE FROM notes WHERE task_id = ?").bind(id),
    env.DB.prepare("DELETE FROM checklist_items WHERE checklist_id IN (SELECT id FROM checklists WHERE task_id = ?)").bind(id),
    env.DB.prepare("DELETE FROM checklists WHERE task_id = ?").bind(id),
    env.DB.prepare("DELETE FROM attachments WHERE task_id = ?").bind(id),
    env.DB.prepare("DELETE FROM agent_runs WHERE task_id = ?").bind(id),
    env.DB.prepare("DELETE FROM task_shares WHERE task_id = ?").bind(id),
    env.DB.prepare("UPDATE posts SET task_id = NULL WHERE task_id = ?").bind(id),
    env.DB.prepare("UPDATE ideas SET converted_task_id = NULL WHERE converted_task_id = ?").bind(id),
    env.DB.prepare("DELETE FROM read_cursors WHERE task_id = ?").bind(id),
    env.DB.prepare("UPDATE thread_entries SET reply_to_id = NULL WHERE task_id = ?").bind(id),
    env.DB.prepare("DELETE FROM thread_entries WHERE task_id = ?").bind(id),
    env.DB.prepare("DELETE FROM tasks WHERE id = ?").bind(id),
  ]);
  if (files.results.length) await env.FILES.delete(files.results.map((f) => f.r2_key));
  await logActivity(env, ws.id, actor, "task", id, "deleted", {
    key: taskKey(ws, task),
    title: task.title,
    description: task.description,
    status: task.status,
    assignee_id: task.assignee_id,
    files: files.results.length,
  });
  await notify(env, ws.id, { type: "task", task_id: id, deleted: true });
}
