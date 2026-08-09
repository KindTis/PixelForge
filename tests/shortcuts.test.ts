import assert from "node:assert/strict";
import test from "node:test";
import { SHORTCUTS, shortcutAction } from "../src/client/editor/shortcuts.ts";

test("편집기 단축키 조합은 중복되지 않는다", () => {
  const keys = Object.keys(SHORTCUTS);
  assert.equal(new Set(keys).size, keys.length);
});

test("도구와 편집 명령 단축키를 구분한다", () => {
  assert.equal(shortcutAction({ key: "b", ctrlKey: false, metaKey: false, shiftKey: false }), "tool:pencil");
  assert.equal(shortcutAction({ key: "z", ctrlKey: true, metaKey: false, shiftKey: false }), "undo");
  assert.equal(shortcutAction({ key: "Z", ctrlKey: true, metaKey: false, shiftKey: true }), "redo");
  assert.equal(shortcutAction({ key: " ", ctrlKey: false, metaKey: false, shiftKey: false }), "play");
});

test("입력 필드와 편집 가능한 요소에서는 단축키를 실행하지 않는다", () => {
  assert.equal(shortcutAction({ key: "b", ctrlKey: false, metaKey: false, shiftKey: false, target: { tagName: "INPUT" } }), null);
  assert.equal(shortcutAction({ key: "z", ctrlKey: true, metaKey: false, shiftKey: false, target: { tagName: "DIV", isContentEditable: true } }), null);
});
