import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Placeholder from "@tiptap/extension-placeholder";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Member } from "./api";
import { Avatar, cx, useMembers } from "./components";

export interface EditorHandle {
  getMarkdown: () => string;
  setMarkdown: (md: string) => void;
  focus: () => void;
  isEmpty: () => boolean;
}

/** An "@query" being typed right before the cursor. */
interface MentionState {
  query: string;
  from: number;
  to: number;
  left: number;
  top: number;
  bottom: number;
}

const MENTION_BEFORE_CURSOR = /(?:^|[^\w@])@([\w-]{0,40})$/;

function findMention(editor: Editor): MentionState | null {
  const { state, view } = editor;
  const sel = state.selection;
  if (!sel.empty) return null;
  const $from = sel.$from;
  if ($from.parent.type.spec.code) return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼");
  const m = MENTION_BEFORE_CURSOR.exec(before);
  if (!m) return null;
  const from = sel.from - m[1].length - 1;
  const c = view.coordsAtPos(from);
  return { query: m[1].toLowerCase(), from, to: sel.from, left: c.left, top: c.top, bottom: c.bottom };
}

function rankMembers(members: Member[], q: string) {
  const active = members.filter((m) => m.active);
  if (!q) return active.sort((a, b) => Number(b.kind === "agent") - Number(a.kind === "agent") || a.name.localeCompare(b.name)).slice(0, 8);
  const score = (m: Member) => {
    const h = m.handle.toLowerCase();
    const n = m.name.toLowerCase();
    if (h.startsWith(q)) return 0;
    if (n.startsWith(q) || n.split(/\s+/).some((w) => w.startsWith(q))) return 1;
    if (h.includes(q) || n.includes(q)) return 2;
    return 99;
  };
  return active
    .map((m) => [m, score(m)] as const)
    .filter(([, s]) => s < 99)
    .sort((a, b) => a[1] - b[1] || a[0].name.localeCompare(b[0].name))
    .slice(0, 8)
    .map(([m]) => m);
}

/**
 * Notion-style rich editor that reads and writes Markdown (the canonical format,
 * so agents and humans edit the same content). Supports markdown shortcuts:
 * "# " headings, "- " lists, "[ ] " to-dos, "```" code, "> " quotes.
 * Typing "@" suggests people and agents; picking one inserts "@handle".
 */
export const RichEditor = forwardRef<
  EditorHandle,
  {
    initial?: string;
    placeholder?: string;
    onChange?: (md: string) => void;
    onSubmit?: () => void;
    className?: string;
    autoFocus?: boolean;
  }
>(function RichEditor({ initial = "", placeholder, onChange, onSubmit, className, autoFocus }, ref) {
  const members = useMembers().data ?? [];
  const [mention, setMention] = useState<MentionState | null>(null);
  const [active, setActive] = useState(0);
  const options = mention ? rankMembers(members, mention.query) : [];

  // The editor's key handler is created once, so it reads the live suggestion state through refs.
  const live = useRef({ mention, options, active, onSubmit });
  live.current = { mention, options, active, onSubmit };
  const editorRef = useRef<Editor | null>(null);

  const pick = (m: Member) => {
    const ed = editorRef.current;
    const cur = live.current.mention;
    if (!ed || !cur) return;
    ed.chain().focus().insertContentAt({ from: cur.from, to: cur.to }, `@${m.handle} `).run();
    setMention(null);
  };
  const pickRef = useRef(pick);
  pickRef.current = pick;

  const refresh = (ed: Editor) => {
    const next = ed.isFocused ? findMention(ed) : null;
    setMention((prev) => {
      if (!next) return null;
      if (!prev || prev.query !== next.query) setActive(0);
      return next;
    });
  };

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder: placeholder ?? "Write something… (Markdown shortcuts work)" }),
      Markdown,
    ],
    content: initial,
    contentType: "markdown",
    autofocus: autoFocus ? "end" : false,
    onUpdate: ({ editor }) => {
      onChange?.(editor.getMarkdown());
      refresh(editor);
    },
    onSelectionUpdate: ({ editor }) => refresh(editor),
    onBlur: () => setTimeout(() => setMention(null), 120),
    editorProps: {
      handleKeyDown: (_view, event) => {
        const { mention, options, active, onSubmit } = live.current;
        if (mention && options.length) {
          if (event.key === "ArrowDown") {
            setActive((i) => (i + 1) % options.length);
            return true;
          }
          if (event.key === "ArrowUp") {
            setActive((i) => (i - 1 + options.length) % options.length);
            return true;
          }
          if ((event.key === "Enter" && !event.metaKey && !event.ctrlKey) || event.key === "Tab") {
            pickRef.current(options[Math.min(active, options.length - 1)]);
            return true;
          }
        }
        if (mention && event.key === "Escape") {
          setMention(null);
          return true;
        }
        if (onSubmit && event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          onSubmit();
          return true;
        }
        return false;
      },
    },
  });
  editorRef.current = editor;

  useImperativeHandle(
    ref,
    () => ({
      getMarkdown: () => editor?.getMarkdown() ?? "",
      setMarkdown: (md: string) => editor?.commands.setContent(md, { contentType: "markdown" }),
      focus: () => editor?.commands.focus("end"),
      isEmpty: () => editor?.isEmpty ?? true,
    }),
    [editor],
  );

  useEffect(() => () => editor?.destroy(), [editor]);

  // Place the list under the "@", or above it when there's no room below.
  const listHeight = Math.min(options.length, 8) * 40 + 8;
  const below = mention ? window.innerHeight - mention.bottom > listHeight + 12 : true;

  return (
    <>
      <EditorContent editor={editor} className={cx("text-[14px]", className)} />
      {mention &&
        options.length > 0 &&
        createPortal(
          <div
            role="listbox"
            aria-label="Mention someone"
            className="fixed z-[110] w-72 overflow-hidden rounded-[10px] bg-canvas p-1 text-ink shadow-pop"
            style={{
              left: Math.max(8, Math.min(mention.left, window.innerWidth - 296)),
              ...(below ? { top: mention.bottom + 6 } : { bottom: window.innerHeight - mention.top + 6 }),
            }}
            onMouseDown={(e) => e.preventDefault() /* keep focus in the editor */}
          >
            {options.map((m, i) => (
              <button
                key={m.id}
                type="button"
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(m)}
                className={cx("flex h-10 w-full items-center gap-2.5 rounded-md px-2 text-left", i === active && "bg-hover")}
              >
                <Avatar member={m} size={22} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{m.name}</span>
                  <span className="block truncate text-[12px] text-ink-3">
                    @{m.handle}
                    {m.kind === "agent" && m.description ? ` · ${m.description}` : ""}
                  </span>
                </span>
                {m.kind === "agent" && <span className="text-[11px] font-medium text-agent">{m.wake_on_mention ? "Wakes" : "Agent"}</span>}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
});
