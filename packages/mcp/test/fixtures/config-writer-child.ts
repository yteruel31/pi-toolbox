import { writeMcpServerControls } from "../../src/config-writer.js";

const [path, name] = process.argv.slice(2);
if (!path || !name) throw new Error("path and name are required");
await writeMcpServerControls({ [name]: { disabled: true } }, { path });
