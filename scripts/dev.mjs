import { spawn } from "node:child_process";

const commands = [
  [process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/server/index.ts"]],
  [process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1"]],
];

const children = commands.map(([command, args]) => spawn(command, args, { stdio: "inherit" }));
const stop = () => children.forEach((child) => child.kill());

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
children.forEach((child) => child.on("exit", (code) => {
  stop();
  process.exitCode = code ?? 1;
}));
