import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Placeholder from "@tiptap/extension-placeholder";
import { Code, Heading1, Heading2, Heading3, List, ListOrdered, ListTodo, Minus, Quote, Type } from "lucide-react";
import { type ReactNode, forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
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

/** A "/query" typed at the start of a line or after a space: the block-type menu. */
const SLASH_BEFORE_CURSOR = /(?:^|\s)\/([a-z0-9 ]{0,20})$/i;

function findSlash(editor: Editor): MentionState | null {
  const { state, view } = editor;
  const sel = state.selection;
  if (!sel.empty) return null;
  const $from = sel.$from;
  if ($from.parent.type.spec.code) return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼");
  const m = SLASH_BEFORE_CURSOR.exec(before);
  if (!m || m[1].startsWith(" ")) return null;
  const from = sel.from - m[1].length - 1;
  const c = view.coordsAtPos(from);
  return { query: m[1].toLowerCase().trim(), from, to: sel.from, left: c.left, top: c.top, bottom: c.bottom };
}

interface BlockCommand {
  id: string;
  label: string;
  hint: string;
  keywords: string;
  icon: ReactNode;
  run: (ed: Editor, range: { from: number; to: number }) => void;
}

const BLOCKS: BlockCommand[] = [
  { id: "text", label: "Text", hint: "Plain paragraph", keywords: "paragraph plain normal", icon: <Type size={16} />, run: (ed, r) => ed.chain().focus().deleteRange(r).setParagraph().run() },
  { id: "h1", label: "Heading 1", hint: "Big section heading", keywords: "title h1 #", icon: <Heading1 size={16} />, run: (ed, r) => ed.chain().focus().deleteRange(r).setHeading({ level: 1 }).run() },
  { id: "h2", label: "Heading 2", hint: "Medium heading", keywords: "subtitle h2 ##", icon: <Heading2 size={16} />, run: (ed, r) => ed.chain().focus().deleteRange(r).setHeading({ level: 2 }).run() },
  { id: "h3", label: "Heading 3", hint: "Small heading", keywords: "h3 ###", icon: <Heading3 size={16} />, run: (ed, r) => ed.chain().focus().deleteRange(r).setHeading({ level: 3 }).run() },
  { id: "bullet", label: "Bulleted list", hint: "Simple list", keywords: "ul unordered bullets -", icon: <List size={16} />, run: (ed, r) => ed.chain().focus().deleteRange(r).toggleBulletList().run() },
  { id: "numbered", label: "Numbered list", hint: "Steps in order", keywords: "ol ordered steps 1.", icon: <ListOrdered size={16} />, run: (ed, r) => ed.chain().focus().deleteRange(r).toggleOrderedList().run() },
  { id: "todo", label: "To-do list", hint: "Checklist with boxes", keywords: "task check checkbox [ ]", icon: <ListTodo size={16} />, run: (ed, r) => ed.chain().focus().deleteRange(r).toggleTaskList().run() },
  { id: "quote", label: "Quote", hint: "Callout or quotation", keywords: "blockquote callout >", icon: <Quote size={16} />, run: (ed, r) => ed.chain().focus().deleteRange(r).toggleBlockquote().run() },
  { id: "code", label: "Code block", hint: "Monospaced code", keywords: "snippet pre ```", icon: <Code size={16} />, run: (ed, r) => ed.chain().focus().deleteRange(r).toggleCodeBlock().run() },
  { id: "divider", label: "Divider", hint: "Horizontal line", keywords: "hr rule separator line ---", icon: <Minus size={16} />, run: (ed, r) => ed.chain().focus().deleteRange(r).setHorizontalRule().run() },
];

function rankBlocks(q: string) {
  if (!q) return BLOCKS;
  const score = (b: BlockCommand) => {
    const l = b.label.toLowerCase();
    if (l.startsWith(q)) return 0;
    if (l.split(/\s+/).some((w) => w.startsWith(q))) return 1;
    if (b.keywords.split(/\s+/).some((w) => w.startsWith(q))) return 2;
    if (l.includes(q)) return 3;
    return 99;
  };
  return BLOCKS.map((b) => [b, score(b)] as const)
    .filter(([, s]) => s < 99)
    .sort((a, b) => a[1] - b[1])
    .map(([b]) => b);
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
    /** Typing "/" opens a menu of block types (headings, lists, to-dos, quote, code, divider). */
    slash?: boolean;
  }
>(function RichEditor({ initial = "", placeholder, onChange, onSubmit, className, autoFocus, slash }, ref) {
  const members = useMembers().data ?? [];
  const [mention, setMention] = useState<MentionState | null>(null);
  const [menu, setMenu] = useState<MentionState | null>(null);
  const [active, setActive] = useState(0);
  const options = mention ? rankMembers(members, mention.query) : [];
  const blocks = menu ? rankBlocks(menu.query) : [];
  const count = mention ? options.length : blocks.length;

  // The editor's key handler is created once, so it reads the live suggestion state through refs.
  const live = useRef({ mention, options, menu, blocks, count, active, onSubmit, slash });
  live.current = { mention, options, menu, blocks, count, active, onSubmit, slash };
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
  const runBlock = (b: BlockCommand) => {
    const ed = editorRef.current;
    const cur = live.current.menu;
    if (!ed || !cur) return;
    b.run(ed, { from: cur.from, to: cur.to });
    setMenu(null);
  };
  const runBlockRef = useRef(runBlock);
  runBlockRef.current = runBlock;

  const refresh = (ed: Editor) => {
    const next = ed.isFocused ? findMention(ed) : null;
    setMention((prev) => {
      if (!next) return null;
      if (!prev || prev.query !== next.query) setActive(0);
      return next;
    });
    const nextMenu = live.current.slash && ed.isFocused && !next ? findSlash(ed) : null;
    setMenu((prev) => {
      if (!nextMenu || !rankBlocks(nextMenu.query).length) return null;
      if (!prev || prev.query !== nextMenu.query) setActive(0);
      return nextMenu;
    });
  };

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        link: { openOnClick: false, autolink: true, HTMLAttributes: { target: "_blank", rel: "noopener noreferrer nofollow" } },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder: placeholder ?? (slash ? "Write something, or type “/” for headings, lists and more…" : "Write something… (Markdown shortcuts work)") }),
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
    onBlur: () => setTimeout(() => (setMention(null), setMenu(null)), 120),
    editorProps: {
      // Links open in a new tab on click (the text stays editable by selecting it or with the keyboard).
      handleClick: (view, _pos, event) => {
        const a = (event.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
        if (!a || !view.dom.contains(a) || event.button !== 0 || !view.state.selection.empty) return false;
        const href = a.getAttribute("href") ?? "";
        if (!/^(https?:|mailto:)/i.test(href)) return false;
        event.preventDefault();
        window.open(href, "_blank", "noopener,noreferrer");
        return true;
      },
      handleKeyDown: (_view, event) => {
        const { mention, options, menu, blocks, count, active, onSubmit } = live.current;
        if ((mention || menu) && count) {
          if (event.key === "ArrowDown") {
            setActive((i) => (i + 1) % count);
            return true;
          }
          if (event.key === "ArrowUp") {
            setActive((i) => (i - 1 + count) % count);
            return true;
          }
          if ((event.key === "Enter" && !event.metaKey && !event.ctrlKey) || event.key === "Tab") {
            if (mention) pickRef.current(options[Math.min(active, options.length - 1)]);
            else runBlockRef.current(blocks[Math.min(active, blocks.length - 1)]);
            return true;
          }
        }
        if ((mention || menu) && event.key === "Escape") {
          setMention(null);
          setMenu(null);
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

  // Place the list under the "@" or "/", or above it when there's no room below.
  const listHeight = mention ? Math.min(options.length, 8) * 40 + 8 : Math.min(blocks.length, 8) * 44 + 36;
  const anchor = mention ?? menu;
  const below = anchor ? window.innerHeight - anchor.bottom > listHeight + 12 : true;

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
      {menu &&
        blocks.length > 0 &&
        createPortal(
          <div
            role="listbox"
            aria-label="Turn into"
            className="fixed z-[110] max-h-[360px] w-64 overflow-y-auto rounded-[10px] bg-canvas p-1 text-ink shadow-pop"
            style={{
              left: Math.max(8, Math.min(menu.left, window.innerWidth - 272)),
              ...(below ? { top: menu.bottom + 6 } : { bottom: window.innerHeight - menu.top + 6 }),
            }}
            onMouseDown={(e) => e.preventDefault() /* keep focus in the editor */}
          >
            <div className="px-2 pt-1 pb-1.5 text-[11px] font-medium text-ink-3">Blocks</div>
            {blocks.map((b, i) => (
              <button
                key={b.id}
                type="button"
                role="option"
                aria-selected={i === active}
                ref={(el) => void (i === active && el?.scrollIntoView({ block: "nearest" }))}
                onMouseEnter={() => setActive(i)}
                onClick={() => runBlock(b)}
                className={cx("flex h-11 w-full items-center gap-2.5 rounded-md px-2 text-left", i === active && "bg-hover")}
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-line bg-canvas text-ink-2">{b.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{b.label}</span>
                  <span className="block truncate text-[12px] text-ink-3">{b.hint}</span>
                </span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
});
