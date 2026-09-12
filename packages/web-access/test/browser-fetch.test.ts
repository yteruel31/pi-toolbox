import assert from "node:assert/strict";
import test from "node:test";
import https from "node:https";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { syncBuiltinESMExports } from "node:module";
import { WebService } from "../src/service.js";
import { parseConfig } from "../src/config.js";
import { BrowserFailure } from "../src/browser-environment.js";

test("classic HTTP stays usable with a missing browser; auto/always propagate failure rather than pretend JS rendered", async () => {
  const originalRequest = https.request, originalBrowser = process.env.WEB_ACCESS_CHROMIUM_PATH;
  let requests = 0;
  https.request = ((_url: unknown, _options: unknown, callback: (stream: unknown) => void) => {
    requests++;
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    req.end = () => {
      const response = Object.assign(new PassThrough(), { statusCode: 200, headers: { "content-type": "text/html" } });
      callback(response); response.end("<html><body><p>HTTP fixture</p></body></html>");
    };
    return req;
  }) as typeof https.request;
  syncBuiltinESMExports();
  process.env.WEB_ACCESS_CHROMIUM_PATH = "/definitely-missing-private-browser";
  const service = new WebService(parseConfig({}, "/unused"));
  try {
    const result = await service.fetch({ url: "https://8.8.8.8/", render: "never" }, "/");
    assert.equal(result.status, 200); assert.match(result.content, /HTTP fixture/); assert.notEqual(result.method, "chromium");
    for (const render of ["auto", "always"] as const) {
      await assert.rejects(service.fetch({ url: "https://8.8.8.8/", render }, "/"), (error: BrowserFailure) =>
        error instanceof BrowserFailure && ["browser-missing", "bwrap-missing", "unsupported-os"].includes(error.code) && !error.message.includes("private-browser"));
    }
    assert.equal(requests, 3); // all HTTP replies really went through the mocked transport
  } finally {
    https.request = originalRequest; syncBuiltinESMExports();
    if (originalBrowser === undefined) delete process.env.WEB_ACCESS_CHROMIUM_PATH; else process.env.WEB_ACCESS_CHROMIUM_PATH = originalBrowser;
    await service.close();
  }
});
