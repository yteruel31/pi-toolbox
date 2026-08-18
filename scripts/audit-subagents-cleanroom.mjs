import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "packages", "subagents");
const legacyPaths = [
  "NOTICE",
  "manager.test.ts",
  "result-delivery.test.ts",
  "context-usage.test.ts",
  "takeover.test.ts",
  "by-the-way.test.ts",
  "tool-call-timeout.test.ts",
  "agents.test.ts",
  "claude.test.ts",
  "src/agents.ts",
  "src/backend.ts",
  "src/by-the-way.ts",
  "src/domain.ts",
  "src/format.ts",
  "src/manager.ts",
  "src/prompt.ts",
  "src/result-delivery.ts",
  "src/runtime.ts",
  "src/tool-call-timeout.ts",
  "src/backends/claude.ts",
  "src/backends/pi.ts",
  "src/backends/stub.ts",
  "src/ui/agent-routing.ts",
  "src/ui/takeover.ts",
  "src/ui/transcript.ts",
];
for (const relative of legacyPaths) {
  try {
    await fs.access(path.join(root, relative));
    throw new Error(`Legacy derived file survived clean-room replacement: ${relative}`);
  } catch (error) {
    if ((error)?.code !== "ENOENT") throw error;
  }
}

const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
if (manifest.name !== "@yteruel31/pi-subagents") throw new Error("Unexpected package name");
if (manifest.private === true) throw new Error("Clean-room package must be publishable");
if (manifest.license !== "MIT") throw new Error("Clean-room package must use MIT");
if (manifest.pi?.extensions?.[0] !== "./src/extension.ts") throw new Error("Unexpected extension entry");

const forbidden = ["davis7dotsh", "my-pi-setup"];
for (const directory of ["src", "test"]) {
  for (const file of await walk(path.join(root, directory))) {
    const text = await fs.readFile(file, "utf8");
    for (const marker of forbidden) {
      if (text.toLowerCase().includes(marker)) {
        throw new Error(`Forbidden provenance marker in ${path.relative(root, file)}`);
      }
    }
  }
}
console.log("clean-room source audit passed");

async function walk(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(candidate));
    else if (entry.isFile()) files.push(candidate);
  }
  return files;
}
