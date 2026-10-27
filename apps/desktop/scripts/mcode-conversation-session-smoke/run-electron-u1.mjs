import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const suite = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(suite, "../..");
const result = spawnSync(process.execPath, [
  join(desktop, "scripts/electron-u1/build.mjs"),
  "--registry=" + join(suite, "electron-registry.ts"),
  "--esbuild=" + join(desktop, "scripts/t8-node-red-u1/main-esbuild.mjs"),
  "--prebuild=" + join(desktop, "scripts/t8-node-red-u1/prebuild.mjs"),
  "--only=mcode-conversation-required-deploy",
], { cwd: desktop, stdio: "inherit" });

if (result.error) {
  console.error("W18 U1 spawn failed:", result.error.message);
  process.exitCode = 6;
} else {
  process.exitCode = result.status ?? 6;
}
