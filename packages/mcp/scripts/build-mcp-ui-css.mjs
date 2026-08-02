import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const input = fileURLToPath(new URL("../src/ui/mcp-ui.css", import.meta.url));
const target = fileURLToPath(new URL("../src/ui/generated/mcp-ui.css", import.meta.url));
const cliPackageUrl = import.meta.resolve("@tailwindcss/cli/package.json");
const cliPackage = JSON.parse(await readFile(fileURLToPath(cliPackageUrl), "utf8"));
if (cliPackage.version !== "4.3.3" || typeof cliPackage.bin?.tailwindcss !== "string") {
	throw new Error("expected pinned @tailwindcss/cli 4.3.3");
}
const cli = resolve(dirname(fileURLToPath(cliPackageUrl)), cliPackage.bin.tailwindcss);

async function build(output) {
	await execFileAsync(process.execPath, [cli, "-i", input, "-o", output, "--minify"], {
		cwd: fileURLToPath(new URL("..", import.meta.url)),
	});
}

if (!process.argv.includes("--check")) {
	await build(target);
} else {
	const directory = await mkdtemp(join(tmpdir(), "pi-mcp-ui-css-"));
	try {
		const candidate = join(directory, "mcp-ui.css");
		await build(candidate);
		if (!(await readFile(target)).equals(await readFile(candidate))) throw new Error("committed MCP UI stylesheet is stale");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
