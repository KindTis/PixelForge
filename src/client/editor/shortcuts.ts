import type { EditorTool } from "./ToolController.ts";

export type ShortcutAction = `tool:${EditorTool}` | "undo" | "redo" | "copy" | "cut" | "paste" | "delete" | "move:left" | "move:right" | "move:up" | "move:down" | "play" | "brush:smaller" | "brush:larger" | "save";

export const SHORTCUTS: Readonly<Record<string, ShortcutAction>> = {
  b: "tool:pencil",
  e: "tool:eraser",
  l: "tool:line",
  c: "tool:curve",
  r: "tool:rectangle",
  o: "tool:ellipse",
  p: "tool:polygon",
  g: "tool:fill",
  d: "tool:gradient",
  a: "tool:spray",
  i: "tool:eyedropper",
  m: "tool:select",
  q: "tool:lasso",
  w: "tool:wand",
  "ctrl+z": "undo",
  "ctrl+shift+z": "redo",
  "ctrl+y": "redo",
  "ctrl+c": "copy",
  "ctrl+x": "cut",
  "ctrl+v": "paste",
  "ctrl+s": "save",
  delete: "delete",
  arrowleft: "move:left",
  arrowright: "move:right",
  arrowup: "move:up",
  arrowdown: "move:down",
  " ": "play",
  "[": "brush:smaller",
  "]": "brush:larger",
};

type KeyboardLike = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  target?: EventTarget | { tagName?: string; isContentEditable?: boolean } | null;
};

export function shortcutAction(event: KeyboardLike): ShortcutAction | null {
  const target = event.target as { tagName?: string; isContentEditable?: boolean } | null | undefined;
  const tag = target?.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable) return null;
  const control = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  const combination = `${control ? "ctrl+" : ""}${control && event.shiftKey ? "shift+" : ""}${key}`;
  return SHORTCUTS[combination] ?? null;
}
