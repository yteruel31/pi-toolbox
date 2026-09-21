import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ConfigStore, configSchema, conditionSchema, defaultConfig, operationPresets, policySchema, presets } from "../src/config.js";
import { GuardrailsEngine } from "../src/engine.js";
import { HistoryStore, filterHistory, relevantHistory } from "../src/history.js";
import { judge } from "../src/judge.js";
import { argumentAt, boundedJson, operationRiskDecision, parseDryRunInput, validOperationArgs } from "../src/operations.js";
import { describeCandidate, evaluatePolicies } from "../src/policies.js";
import { candidateView, operationView } from "../src/sanitize.js";
import { isSupportedTool, isTool, type Candidate } from "../src/types.js";
import { bridge, candidate, config, entry, policy } from "./helpers.js";

const operation = (args: Record<string, unknown> = {}, tool: Candidate["tool"] = "web-access") => candidate({ tool, args: { operation: "custom-operation", arguments: {}, ...args } });
const rule = (conditions: ReturnType<typeof conditionSchema.parse>, action: "Allow" | "Ask" | "Deny" = "Allow") => policy({ tools: ["mcp", "web-access"], conditions, action });
const evaluate = (c: Candidate, rules = [rule({})], protectedPaths: string[] = []) => evaluatePolicies(c, rules, protectedPaths);

test("only concrete local discovery and public non-sensitive outbound reads auto-allow", () => {
  for (const c of [operation({ operation: "status" }, "mcp"), operation({ operation: "tools-list" }, "mcp"), operation({ operation: "web_search", urls: ["https://api.search.brave.com/"], arguments: { query: "TypeScript releases" } })]) {
    assert.equal(evaluate(c, []).decision?.action, "Allow");
    assert.equal(evaluate(c, [rule({}, "Ask")]).decision?.action, "Ask");
  }
  for (const c of [
    operation({ operation: "resources-read", server: "files", arguments: { uri: "file:///private" } }, "mcp"),
    operation({ operation: "tools-call", toolName: "list_items" }, "mcp"),
    operation({ operation: "deep_research.result" }),
    operation({ operation: "web_search", urls: ["http://127.0.0.1/search"], arguments: { query: "public" } }),
  ]) assert.equal(evaluate(c, []).decision, undefined, JSON.stringify(c.args));
});

test("stored content retrieval accepts opaque local cache IDs without weakening remote reads", () => {
  for (const responseId of ["a".repeat(32), "b".repeat(64)]) {
    assert.equal(evaluate(operation({ operation: "get_search_content", arguments: { responseId, offset: 10, limit: 200, query: "docs" } }), []).decision?.action, "Allow");
  }
  assert.equal(evaluate(operation({ operation: "web_search", urls: ["https://api.search.brave.com/"], arguments: { query: "a".repeat(32) } }), []).decision?.action, "Ask");
});

test("known outbound secrets impose an Ask floor before explicit Allows", () => {
  const risky = [
    operation({ operation: "web_search", urls: ["https://api.search.brave.com/"], arguments: { query: "password=hunter2" } }),
    operation({ operation: "fetch_content", urls: ["https://example.org/?token=abcdef"] }),
    operation({ operation: "fetch_content", urls: ["https://example.org/path/ghp_FAKEEXAMPLE123456789"] }),
  ];
  for (const c of risky) {
    assert.equal(operationRiskDecision(c), "Ask");
    assert.equal(evaluate(c, [rule({}, "Allow")]).decision?.action, "Ask");
    assert.equal(evaluatePolicies(c, [rule({}, "Allow")], [], false).decision?.action, "Ask");
  }
  assert.equal(evaluate(operation({ operation: "web_search", urls: ["https://api.search.brave.com/"], arguments: { query: "TypeScript async iterator tutorial" } }), []).decision?.action, "Allow");
  assert.equal(evaluate(operation({ operation: "fetch_content", urls: ["https://example.org/docs"] }), []).decision?.action, "Allow");
});

test("actual MCP discovery metadata is narrow and outbound credentials impose an Ask floor", () => {
  for (const operationName of ["status", "tools-search", "tools-list", "tools-discover"]) {
    assert.equal(evaluate(operation({ operation: operationName, arguments: operationName === "tools-search" ? { search: "TypeScript docs" } : {} }, "mcp"), []).decision?.action, "Allow");
  }
  assert.equal(evaluate(operation({ operation: "tools-call", toolName: "list_items" }, "mcp"), []).decision, undefined);
  const risky = [
    operation({ operation: "tools-call", toolName: "publish", arguments: { password: "hunter2" } }, "mcp"),
    operation({ operation: "tools-call", toolName: "publish", urls: ["https://example.org/?token=abcdef"] }, "mcp"),
    operation({ operation: "resources-read", server: "remote", arguments: { uri: "https://example.org/ghp_FAKEEXAMPLE123456789" } }, "mcp"),
  ];
  for (const c of risky) {
    assert.equal(operationRiskDecision(c), "Ask");
    assert.equal(evaluate(c, [rule({}, "Allow")]).decision?.action, "Ask");
    assert.equal(evaluatePolicies(c, [rule({}, "Allow")], [], false).decision?.action, "Ask");
    assert.equal(evaluatePolicies(c, [rule({}, "Allow")], [], true).decision?.action, "Ask");
  }
});

test("operation tool families do not expand native interception", () => {
  for (const tool of ["mcp", "web-access"]) { assert.equal(isTool(tool), false); assert.equal(isSupportedTool(tool), true); }
  for (const tool of ["bash", "read", "write", "edit"]) assert.equal(isTool(tool), true);
  assert.equal(isSupportedTool("mcp_anything"), false);
});

test("new defaults omit the broad destructive-files prompt while saved policies remain unchanged", () => {
  const fresh = defaultConfig();
  assert.deepEqual(configSchema.parse(fresh), fresh);
  assert.equal(fresh.enabled, false);
  assert.equal(fresh.policies.some((p) => p.id === "destructive-files"), false);
  assert.ok(fresh.policies.every((p) => !p.tools.includes("mcp") && !p.tools.includes("web-access")));
  const saved = { ...fresh, policies: [{ ...presets.find((p) => p.id === "destructive-files")!, action: "Ask" as const }] };
  assert.equal(configSchema.parse(saved).policies[0]?.action, "Ask");
  assert.equal(configSchema.parse({ ...saved, policies: [{ ...saved.policies[0]!, action: "Deny" }] }).policies[0]?.action, "Deny");
  for (const preset of operationPresets) {
    assert.ok(policySchema.safeParse(preset).success);
    assert.equal(preset.action, "Ask");
    assert.equal(fresh.policies.some((p) => p.id === preset.id), false);
    assert.equal(evaluate(operation({}, preset.tools[0]), [preset]).decision?.action, "Ask");
  }
  assert.ok(policySchema.safeParse(policy({ tools: ["bash", "read", "write", "edit", "mcp", "web-access"] })).success);
});

test("operation/server/toolName and argumentMatches compare exact original scalars and AND together", () => {
  const c = operation({ operation: "call", server: "inventory", toolName: "lookup", arguments: { options: { dryRun: true }, ids: [42], empty: null, password: "local-secret" } }, "mcp");
  const conditions = { operation: "call", server: "inventory", toolName: "lookup", argumentMatches: { "options.dryRun": true, "ids.0": 42, empty: null, password: "local-secret" } };
  assert.equal(evaluate(c, [rule(conditions)]).decision?.action, "Allow");
  for (const mismatch of [{ operation: "Call" }, { server: "inventory-other" }, { toolName: "look" }, { argumentMatches: { "ids.0": "42" } }, { argumentMatches: { missing: null } }] as ReturnType<typeof conditionSchema.parse>[]) {
    assert.equal(evaluate(c, [rule({ ...conditions, ...mismatch })]).decision, undefined);
  }
  assert.equal(evaluate(candidate(), [policy({ conditions: { operation: "call" }, action: "Deny" })]).decision?.policyIds[0], "builtin.safe-read");
  assert.equal(evaluate(c, [rule({ pathPrefix: "/project" })]).decision, undefined);
  const denied = evaluate(c, [rule(conditions, "Deny")]).decision!;
  assert.equal(denied.action, "Deny");
  assert.ok(!denied.reason.includes("local-secret"));
});

test("domain is exact by default; explicit subdomains use component boundaries", () => {
  for (const host of ["example.com", "EXAMPLE.COM", "example.com."]) assert.equal(evaluate(operation({ urls: [`https://${host}/`] }), [rule({ domain: "example.com" })]).decision?.action, "Allow");
  for (const host of ["sub.example.com", "notexample.com", "example.com.evil.test"]) assert.equal(evaluate(operation({ urls: [`https://${host}/`] }), [rule({ domain: "example.com" })]).decision, undefined);
  assert.equal(evaluate(operation({ urls: ["https://a.b.example.com/"] }), [rule({ domain: "example.com", includeSubdomains: true })]).decision?.action, "Allow");
  for (const host of ["badexample.com", "example.com.evil.test"]) assert.equal(evaluate(operation({ urls: [`https://${host}/`] }), [rule({ domain: "example.com", includeSubdomains: true })]).decision, undefined);
  for (const domain of ["*.example.com", "https://example.com", "example.com:443", "user@example.com", "example.com/x", "example.com?x"]) assert.equal(conditionSchema.safeParse({ domain }).success, false);
  assert.equal(conditionSchema.safeParse({ includeSubdomains: true }).success, false);
});

test("URL prefix uses parsed scheme, host, port and path boundaries", () => {
  const r = rule({ urlPrefix: "https://example.com/docs" });
  for (const url of ["https://example.com/docs", "https://example.com:443/docs/guide", "https://example.com/docs/?q=x"]) assert.equal(evaluate(operation({ urls: [url] }), [r]).decision?.action, "Allow");
  for (const url of ["https://example.com/docs-evil", "https://example.com.evil/docs", "https://example.com:444/docs", "http://example.com/docs", "https://example.com/docs/../private", "https://example.com/docs%2fprivate", "https://example.com/docs/%252e%252e/private"]) assert.equal(evaluate(operation({ urls: [url] }), [r]).decision, undefined, url);
  // Ambiguous encoded paths cannot escape a same-host restrictive prefix rule.
  assert.equal(evaluate(operation({ urls: ["https://example.com/docs%2fprivate"] }), [rule(r.conditions, "Deny")]).decision?.action, "Deny");
  for (const urlPrefix of ["https://u:p@example.com/docs", "https://example.com/docs?x=y", "https://example.com/docs#x", "https://example.com/docs%2fprivate", "file:///tmp/docs"]) assert.equal(conditionSchema.safeParse({ urlPrefix }).success, false);
});

test("Deny/Ask match any batch URL; Allow requires every URL and same-URL conditions", () => {
  const c = operation({ urls: ["https://good.test/docs", "https://evil.test/private"] });
  assert.equal(evaluate(c, [rule({ domain: "good.test" })]).decision, undefined);
  assert.equal(evaluate(c, [rule({ domain: "good.test" }), { ...rule({ domain: "evil.test" }), id: "other-allow" }]).decision, undefined);
  for (const action of ["Ask", "Deny"] as const) {
    assert.equal(evaluate(c, [rule({ domain: "evil.test" }, action)]).decision?.action, action);
    assert.equal(evaluate(c, [rule({ domain: "good.test", urlPrefix: "https://evil.test/private" }, action)]).decision, undefined);
  }
  const onlyGood = operation({ urls: ["https://good.test/docs", "https://good.test/docs/other"] });
  assert.equal(evaluate(onlyGood, [rule({ domain: "good.test", urlPrefix: "https://good.test/docs" })]).decision?.action, "Allow");
  for (const urls of [undefined, []]) assert.equal(evaluate(operation(urls ? { urls } : {}), [rule({ domain: "good.test" })]).decision, undefined);
  assert.equal(evaluate(c, [rule({}), rule({ domain: "evil.test" }, "Ask"), { ...rule({ domain: "good.test" }, "Deny"), id: "deny" }]).decision?.action, "Deny");
});

test("safe argument paths never traverse prototypes, accessors or executable expressions", () => {
  let invoked = false;
  const getter = Object.defineProperty({}, "hidden", { enumerable: true, get: () => { invoked = true; return "secret"; } });
  for (const args of [Object.create({ safe: true }), { nested: Object.create({ safe: true }) }, getter, JSON.parse('{"__proto__":{"safe":true}}')]) {
    assert.equal(boundedJson(args), false);
    assert.equal(evaluate(operation({ arguments: args })).decision?.action, "Deny");
  }
  assert.equal(argumentAt({ nested: getter }, "nested.hidden"), undefined);
  assert.equal(argumentAt(Object.create({ safe: true }), "safe"), undefined);
  assert.equal(invoked, false);
  for (const path of ["__proto__.safe", "constructor.name", "x.prototype.y", "x..y", "x[0]", "x()", "$x", "a.".repeat(13) + "b"]) {
    assert.equal(argumentAt({}, path), undefined);
    assert.equal(conditionSchema.safeParse({ argumentMatches: { [path]: true } }).success, false, path);
  }
  for (const argumentMatches of [{}, { a: [] }, { a: {} }, Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`a${i}`, i]))]) assert.equal(conditionSchema.safeParse({ argumentMatches }).success, false);
  assert.equal(conditionSchema.safeParse({ argumentMatches: JSON.parse('{"__proto__":true}') }).success, false);
});

test("operation validation rejects malformed, exotic, cyclic, sparse and over-budget arguments", () => {
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  for (const args of [{ arguments: cycle }, { arguments: { data: "x".repeat(64001) } }, { arguments: { data: new Date() } }, { arguments: { sparse: new Array(1000) } }, { urls: Array(33).fill("https://example.com") }, { operation: "" }, { operation: "bad\nlabel" }, { urls: ["javascript:alert(1)"] }, { arguments: [] }, { extra: true }]) {
    const c = operation(args);
    assert.equal(validOperationArgs(c.args), false);
    assert.equal(evaluate(c).decision?.action, "Deny");
    assert.equal(operationView(c).incomplete, true);
  }
});

test("deep masking hides credentials, queries and body/content before model assessment", async () => {
  const c = operation({ operation: "fetch_content", urls: ["https://username:password@example.com/docs?private-query=yes#fragment"], arguments: {
    nested: { apiKey: "sensitive-key", auth: { cookie: "session-secret" }, body: { arbitrary: "body-secret" }, content: "content-secret", query: "query-secret", prompt: "prompt-secret" },
    links: ["https://username-only@example.com/a?query-secret", { authorization: "Bearer bearer-secret" }],
    limit: 3,
  } });
  const described = describeCandidate(c);
  assert.equal(described.target, "example.com");
  assert.equal(described.operation, "fetch_content");
  const view = candidateView(c, described.target, described.operation);
  assert.equal(view.assessmentIncomplete, true);
  const json = JSON.stringify(view);
  for (const secret of ["username", "password", "private-query", "fragment", "sensitive-key", "session-secret", "body-secret", "content-secret", "prompt-secret", "bearer-secret"]) assert.ok(!json.includes(secret), secret);
  assert.ok(json.includes("query-secret"), "ordinary query text remains assessable");
  const fake = bridge(); let prompt = "";
  const complete = fake.complete;
  fake.complete = async (m, context, opts) => { prompt = JSON.stringify(context); assert.equal(context.tools, undefined); return complete(m, context, opts); };
  const verdict = await judge(fake, config(), c, [], [], described.target, described.operation);
  assert.equal(verdict.action, "Ask");
  assert.ok(!prompt.includes("sensitive-key"));
  assert.equal(evaluate(c, [rule({ domain: "example.com" })]).decision?.action, "Ask", "known outbound risk overrides explicit Allow");
});

test("truncated, sanitized and omitted operation values cannot be model-autoallowed", async () => {
  for (const args of [{ note: "x".repeat(1001) }, { items: Array.from({ length: 40 }, (_, i) => i) }, { note: "hello\u001b[31mred" }, { note: "a".repeat(45) }, { nested: { text: "hidden" } }]) {
    const c = operation({ arguments: args });
    const described = describeCandidate(c);
    assert.equal(operationView(c).incomplete, true);
    assert.equal((await judge(bridge(), config(), c, [], [], described.target, described.operation)).action, "Ask");
  }
  const clean = operation({ arguments: { limit: 3 }, urls: ["https://example.com/docs"] });
  assert.equal(operationView(clean).incomplete, false);
  assert.equal((await judge(bridge(), config(), clean, [], [], "example.com", "fetch_content")).action, "Allow");
});

test("operation target descriptions are non-file and identifiable local destinations are protected", async () => {
  const root = await mkdtemp(join(tmpdir(), "guardrails-operation-"));
  try {
    const protectedDir = join(root, "protected"); await mkdir(protectedDir);
    const alias = join(root, "alias"); await symlink(protectedDir, alias);
    assert.equal(describeCandidate(operation({ server: "catalog", toolName: "lookup" }, "mcp")).target, "server:catalog · tool:lookup");
    for (const args of [{ outputPath: join(protectedDir, "report.md") }, { nested: { outputPath: join(alias, "report.md") } }, { destination: { path: join(protectedDir, "report.md") } }]) {
      assert.equal(evaluate(operation({ operation: "deep_research", arguments: args }), [rule({})], [protectedDir]).decision?.policyIds[0], "builtin.self-protection");
    }
    const local = operation({ urls: [pathToFileURL(join(protectedDir, "guardrails.json")).href] });
    assert.equal(describeCandidate(local).target, "file:[local target]");
    assert.equal(evaluate(local, [rule({})], [protectedDir]).decision?.action, "Deny");
    assert.equal(evaluate(operation({ arguments: { outputPath: join(root, "protected-other", "report.md") } }), [rule({})], [protectedDir]).decision?.action, "Allow");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("operation project restrictions stay additive and cannot introduce Allow", async () => {
  const root = await mkdtemp(join(tmpdir(), "guardrails-op-config-"));
  try {
    const project = join(root, "project"); const store = new ConfigStore(join(root, "agent"), project);
    await mkdir(join(root, "agent")); await mkdir(join(project, ".pi"), { recursive: true });
    await writeFile(store.globalPath, JSON.stringify(config({ policies: [rule({})] })));
    await writeFile(store.projectPath, JSON.stringify({ version: 1, policies: [rule({ domain: "evil.test" }, "Deny")] }));
    const snapshot = await store.load(true);
    assert.equal(snapshot.error, undefined);
    assert.equal(evaluate(operation({ urls: ["https://evil.test/"] }), snapshot.policies).decision?.action, "Deny");
    assert.equal(evaluate(operation({ urls: ["https://evil.test/"] }), (await store.load(false)).policies).decision?.action, "Allow");
    await writeFile(store.projectPath, JSON.stringify({ version: 1, policies: [rule({})] }));
    assert.ok((await store.load(true)).error);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("operation history supports lifecycle, privacy, filtering, and same-project precedents", async () => {
  const history = new HistoryStore(":memory:");
  try {
    const cfg = config({ policies: [rule({ domain: "example.com" })] });
    const engine = new GuardrailsEngine({ load: async () => ({ config: cfg, policies: cfg.policies, revision: "", projectStatus: "" }), bridge: bridge(), history, protectedPaths: [], signal: new AbortController().signal });
    const c = operation({ urls: ["https://example.com/docs"], arguments: { note: "public" } });
    assert.equal(await engine.assess(c), undefined);
    engine.result(c, false);
    const rows = history.list();
    assert.equal(rows.length, 1); assert.equal(rows[0].tool, "web-access"); assert.equal(rows[0].execution, "reported-success");
    assert.ok(!JSON.stringify(rows).includes("public"));
    history.put(entry({ tool: "mcp", summary: "mcp catalog", target: "server:catalog", operation: "lookup" }));
    assert.equal(filterHistory(history.list(), { search: "lookup" }).length, 1);
    assert.equal(filterHistory(history.list(), { search: "example.com" }).length, 1);
    assert.equal(relevantHistory(history.list(), candidate({ project: "/other" }), "example.com", "fetch_content", []).length, 0);
  } finally { history.close(); }
});

test("dry-run helper preserves bash and accepts validated operation JSON without side effects", async () => {
  assert.deepEqual(parseDryRunInput("git status"), { tool: "bash", args: { command: "git status" } });
  assert.deepEqual(parseDryRunInput("{ echo hello; }", "bash"), { tool: "bash", args: { command: "{ echo hello; }" } });
  const input = { tool: "mcp", args: { operation: "call", server: "catalog", toolName: "lookup", arguments: { id: 42 } } };
  assert.deepEqual(parseDryRunInput(JSON.stringify(input)), input);
  for (const invalid of ["{", "{}", '{"tool":"bash","args":{}}', '{"tool":"mcp","args":{"operation":"call","arguments":{"__proto__":{}}}}', JSON.stringify({ ...input, actor: "main" })]) assert.throws(() => parseDryRunInput(invalid));
  const history = new HistoryStore(":memory:");
  try {
    const cfg = config({ policies: [rule({})] });
    const engine = new GuardrailsEngine({ load: async () => ({ config: cfg, policies: cfg.policies, revision: "", projectStatus: "" }), bridge: bridge(), history, protectedPaths: [], signal: new AbortController().signal });
    assert.equal((await engine.evaluate(candidate(parseDryRunInput(JSON.stringify(input))))).decision.action, "Allow");
    assert.equal(history.list().length, 0);
    cfg.policies = [rule({}, "Ask")];
    let prompted = false;
    const worker = candidate({ ...parseDryRunInput(JSON.stringify(input)), actor: { kind: "subagent", runId: "test-worker" } });
    assert.ok(await engine.assess(worker, async () => { prompted = true; return "allow-once"; }));
    assert.equal(prompted, false);
    assert.equal(history.list()[0].state, "denied");
  } finally { history.close(); }
});
