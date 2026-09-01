import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_HOSTING_SETTINGS } from "../src/config.js";
import { DiagramTailscaleAdapter, DiagramTailscaleMutationError, type TailscaleExec } from "../src/publication/tailscale.js";
import { verifyExternalPublication } from "../src/publication/verify.js";

const settings = { ...DEFAULT_HOSTING_SETTINGS, mode: "tailscale" as const };
const statusJson = (proxy?: string) => JSON.stringify(proxy ? {
  Web: { "machine.tailnet.ts.net:8443": { Handlers: { "/diagram": { Proxy: proxy } } } },
} : { Web: {} });

test("sets up only an absent matching Tailscale Serve route and verifies it", async () => {
  const calls: string[][] = [];
  let configured = false;
  const run: TailscaleExec = async (args) => {
    calls.push([...args]);
    if (args[0] === "serve" && args[1] === "status") return { stdout: statusJson(configured ? "http://127.0.0.1:19878" : undefined) };
    if (args[0] === "serve" && args.includes("--bg")) { configured = true; return { stdout: "" }; }
    throw new Error("unexpected command");
  };
  const result = await new DiagramTailscaleAdapter(run).setup(settings);
  assert.equal(result.changed, true);
  assert.ok(calls.some((args) => args.includes("--set-path=/diagram") && args.at(-1) === "http://127.0.0.1:19878"));
});

test("reports ownership when setup mutates but misses its postcondition", async () => {
  const adapter = new DiagramTailscaleAdapter(async (args) => {
    if (args[0] === "serve" && args[1] === "status") return { stdout: statusJson() };
    return { stdout: "" };
  });
  await assert.rejects(() => adapter.setup(settings), (error) => error instanceof DiagramTailscaleMutationError && error.operation === "setup" && error.changed);
});

test("refuses to overwrite a conflicting Tailscale route", async () => {
  const adapter = new DiagramTailscaleAdapter(async () => ({ stdout: statusJson("http://127.0.0.1:9999") }));
  await assert.rejects(() => adapter.setup(settings), /already uses/);
});

test("derives the local machine Tailscale hostname", async () => {
  const adapter = new DiagramTailscaleAdapter(async () => ({ stdout: JSON.stringify({ Self: { DNSName: "machine.tailnet.ts.net." } }) }));
  assert.equal(await adapter.hostname(), "machine.tailnet.ts.net");
});

test("verifies an external URL with a one-time matching challenge", async () => {
  let active = "";
  const host = { async setChallenge(token: string) { active = token; return () => { active = ""; }; } };
  await verifyExternalPublication("https://diagram.example/diagram", host, async (input) => {
    const token = new URL(String(input)).pathname.split("/").at(-1)!;
    assert.equal(token, active);
    return new Response(token, { status: 200 });
  });
  assert.equal(active, "");
});

test("rejects mismatched external challenge responses", async () => {
  const host = { async setChallenge() { return () => undefined; } };
  await assert.rejects(() => verifyExternalPublication("https://diagram.example/diagram", host, async () => new Response("wrong", { status: 200 })), /did not match/);
});
