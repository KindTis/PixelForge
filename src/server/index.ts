import { resolve } from "node:path";
import { CodexBridge, cellEditAppServerArgs, createCodexProcess } from "./codex-bridge.ts";
import { createPixelForgeServer } from "./app.ts";

const codex = new CodexBridge();
await codex.start().catch((error) => console.error(`Codex 연결 실패: ${error instanceof Error ? error.message : String(error)}`));
const cellEditCodex = await codex.configuredMcpServerNames().then(async (mcpServerNames) => {
  const restrictedCodex = new CodexBridge(() => createCodexProcess(cellEditAppServerArgs(mcpServerNames)));
  return restrictedCodex.start().then(() => restrictedCodex, () => {
    restrictedCodex.close();
    return undefined;
  });
}, () => undefined);

const server = createPixelForgeServer({
  projectsRoot: resolve("projects"),
  staticRoot: resolve("dist"),
  codex,
  cellEditCodex,
});
server.listen(3210, "127.0.0.1", () => console.log("PixelForge: http://127.0.0.1:3210"));

const stop = () => server.close(() => {
  codex.close();
  cellEditCodex?.close();
});
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
