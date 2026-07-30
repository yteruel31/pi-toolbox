import { build } from "esbuild";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const target = fileURLToPath(new URL("../src/apps/generated/app-bridge.js", import.meta.url));
const entry = fileURLToPath(import.meta.resolve("@modelcontextprotocol/ext-apps/app-bridge"));
const options = { entryPoints: [entry], bundle: true, format: "esm", platform: "browser", minify: true, legalComments: "inline" };
if (!process.argv.includes("--check")) {
	await build({ ...options, outfile: target });
} else {
	const directory = await mkdtemp(join(tmpdir(), "pi-app-bridge-"));
	try {
		const candidate = join(directory, "app-bridge.js");
		await build({ ...options, outfile: candidate });
		if (!(await readFile(target)).equals(await readFile(candidate))) throw new Error("committed App bridge bundle is stale");
	} finally { await rm(directory, { recursive: true, force: true }); }
}
