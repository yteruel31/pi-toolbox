import assert from "node:assert/strict";
import test from "node:test";

import { browserCommand } from "../src/browser.js";

const url = "https://review.example.test/open/github/org/repo/pull/1";

test("opens browsers with argument arrays on supported platforms", () => {
	assert.deepEqual(browserCommand(url, "darwin"), { command: "open", args: [url] });
	assert.deepEqual(browserCommand(url, "linux"), { command: "xdg-open", args: [url] });
	assert.deepEqual(browserCommand(url, "win32"), { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] });
});
