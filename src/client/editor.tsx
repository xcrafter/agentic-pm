import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Placeholder from "@tiptap/extension-placeholder";
import { forwardRef, useEffect, useImperativeHandle } from "react";
import { cx } from "./components";

export interface EditorHandle {
  getMarkdown: () => string;
  setMarkdown: (md: string) => void;
  focus: () => void;
  isEmpty: () => boolean;
}

/**
 * Notion-style rich editor that reads and writes Markdown (the canonical format,
 * so agents and humans edit the same content). Supports markdown shortcuts:
 * "# " headings, "- " lists, "[ ] " to-dos, "```" code, "> " quotes.
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
    onUpdate: ({ editor }) => onChange?.(editor.getMarkdown()),
    editorProps: {
      handleKeyDown: (_view, event) => {
        if (onSubmit && event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          onSubmit();
          return true;
        }
        return false;
      },
    },
  });

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

  return <EditorContent editor={editor} className={cx("text-sm", className)} />;
});
