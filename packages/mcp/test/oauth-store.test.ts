import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { StoredOAuthProvider } from "../src/auth/provider.js";
import { OAuthStore } from "../src/auth/store.js";

const temporaryDirectories: string[] = [];
async function temporaryDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}
afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("OAuth store hashes identities, serializes atomic updates, and applies private permissions", async () => {
	const store = new OAuthStore(await temporaryDirectory("pi-oauth-"));
	await Promise.all(Array.from({ length: 20 }, (_, index) => store.update("https://server.invalid/mcp", (record) => {
		(record as unknown as Record<string, unknown>)[`value${index}`] = index;
	})));
	const names = await readdir(store.dir);
	assert.equal(names.length, 1);
	assert.doesNotMatch(names[0]!, /server/);
	assert.equal((await lstat(store.dir)).mode & 0o777, 0o700);
	assert.equal((await lstat(join(store.dir, names[0]!))).mode & 0o777, 0o600);
	const stored = JSON.parse(await readFile(join(store.dir, names[0]!), "utf8"));
	for (let index = 0; index < 20; index++) assert.equal(stored[`value${index}`], index);
	assert.equal((await readdir(store.dir)).some((name) => name.endsWith(".tmp")), false);
});

test("OAuth store serializes updates across separate processes", async () => {
	const home = await temporaryDirectory("pi-oauth-processes-");
	const storeUrl = new URL("../src/auth/store.ts", import.meta.url).href;
	const script = `
		import { OAuthStore } from ${JSON.stringify(storeUrl)};
		const [home, prefix] = process.argv.slice(1);
		const store = new OAuthStore(home);
		for (let index = 0; index < 10; index++) {
			await store.update("shared-identity", (record) => { record[prefix + index] = index; });
		}
	`;
	const run = (prefix: string) => new Promise<void>((resolve, reject) => {
		const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script, home, prefix], { stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr?.on("data", (chunk) => stderr += chunk);
		child.once("error", reject);
		child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`OAuth store child failed: ${stderr}`)));
	});
	await Promise.all([run("a"), run("b"), run("c")]);
	const record = await new OAuthStore(home).read("shared-identity") as unknown as Record<string, unknown>;
	for (const prefix of ["a", "b", "c"]) {
		for (let index = 0; index < 10; index++) assert.equal(record[`${prefix}${index}`], index);
	}
	assert.equal((await readdir(new OAuthStore(home).dir)).some((name) => name.endsWith(".lock")), false);
});

test("OAuth provider binds tokens to the registered client and redirect", async () => {
	const store = new OAuthStore(await temporaryDirectory("pi-oauth-"));
	const identity = "https://one.invalid/mcp";
	const first = new StoredOAuthProvider(identity, store, "https://tail.invalid/callback", "fixed-state");
	assert.equal(await first.state(), "fixed-state");
	await first.saveCodeVerifier("verifier");
	await first.saveDiscoveryState({ authorizationServerUrl: "https://auth.invalid" });
	await first.saveClientInformation({ client_id: "client", redirect_uris: ["https://tail.invalid/callback"] });
	await first.saveTokens({ access_token: "token", token_type: "Bearer", refresh_token: "refresh" });
	assert.equal(await first.codeVerifier(), "verifier");
	assert.equal((await first.tokens())?.access_token, "token");
	assert.equal((await first.clientInformation())?.client_id, "client");
	assert.equal((await StoredOAuthProvider.passive(identity, store))?.redirectUrl, "https://tail.invalid/callback");

	const mismatched = new StoredOAuthProvider(identity, store, "https://other.invalid/callback", "new-state");
	assert.equal(await mismatched.state(), "new-state");
	assert.equal(await mismatched.clientInformation(), undefined);
	assert.equal(await mismatched.tokens(), undefined);
	assert.equal((await StoredOAuthProvider.passive(identity, store))?.redirectUrl, "https://tail.invalid/callback");
	await mismatched.saveClientInformation({ client_id: "client", redirect_uris: ["https://other.invalid/callback"] });
	assert.equal(await StoredOAuthProvider.passive(identity, store), undefined);

	await mismatched.invalidateCredentials("all");
	const cleared = await store.read(identity);
	assert.equal(cleared?.client, undefined);
	assert.equal(cleared?.tokens, undefined);
	assert.equal(cleared?.verifier, undefined);
	assert.equal(cleared?.discovery, undefined);
	assert.equal(cleared?.state, undefined);
});

test("OAuth store fails safely for corrupted records and refuses symlink files", async () => {
	const home = await temporaryDirectory("pi-oauth-");
	const store = new OAuthStore(home);
	const identity = "identity";
	await store.update(identity, (record) => { record.state = "initial"; });
	const [name] = await readdir(store.dir);
	const path = join(store.dir, name!);
	await writeFile(path, "{broken", { mode: 0o600 });
	assert.equal(await store.read(identity), undefined);
	await store.update(identity, (record) => { record.state = "recovered"; });
	assert.equal((await store.read(identity))?.state, "recovered");

	const target = join(await temporaryDirectory("pi-target-"), "target.json");
	await writeFile(target, "{}", { mode: 0o600 });
	await unlink(path);
	await symlink(target, path);
	await assert.rejects(store.read(identity), /Unsafe OAuth storage file/);
	await assert.rejects(store.update(identity, (record) => { record.state = "must-not-write"; }), /Unsafe OAuth storage file/);
	assert.equal((await readdir(store.dir)).some((entry) => entry.endsWith(".tmp")), false);
});

test("OAuth store refuses a symlink storage directory", async () => {
	const home = await temporaryDirectory("pi-oauth-");
	const target = await temporaryDirectory("pi-target-");
	await mkdir(join(home, ".pi", "agent", "pi-mcp"), { recursive: true });
	await symlink(target, join(home, ".pi", "agent", "pi-mcp", "oauth"));
	await assert.rejects(new OAuthStore(home).read("identity"), /Unsafe OAuth storage directory/);
});
