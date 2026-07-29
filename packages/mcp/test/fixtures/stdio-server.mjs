import { writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
const [, , pidFile, exitFile] = process.argv;
if (pidFile) writeFileSync(pidFile, String(process.pid));
if (exitFile) process.on("SIGTERM", () => { writeFileSync(exitFile, "closed"); process.exit(0); });
const server = new McpServer({ name: "stdio-fixture", version: "1.0.0" });
server.registerTool("echo", {}, async () => ({
	content: [{ type: "text", text: `stdio-ok:${process.env.PI_MCP_TEST ?? "missing"}:${process.env.PATH ? "has-path" : "no-path"}` }],
}));
await server.connect(new StdioServerTransport());
