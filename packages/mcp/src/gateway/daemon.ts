import { readFile, rm } from "node:fs/promises";
import { startGatewayServer } from "./server.js";

const configPath = process.argv[2];
if (!configPath) throw new Error("Missing daemon configuration");

const config = JSON.parse(await readFile(configPath, "utf8"));
await rm(configPath, { force: true });
const gateway = await startGatewayServer(config);
const shutdown = (): void => {
	void gateway.close().catch(() => undefined);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
try {
	await gateway.closed;
} finally {
	process.off("SIGINT", shutdown);
	process.off("SIGTERM", shutdown);
}
