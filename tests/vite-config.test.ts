import assert from "node:assert/strict";
import test from "node:test";
import config from "../vite.config.ts";

test("Vite는 런타임 프로젝트 폴더를 감시하지 않는다", () => {
  const ignored = (config as { server?: { watch?: { ignored?: string[] } } }).server?.watch?.ignored;
  assert.deepEqual(ignored, ["**/projects/**"]);
});
