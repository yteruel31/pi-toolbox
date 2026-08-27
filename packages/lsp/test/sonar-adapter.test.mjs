import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createSonarProtocolConfig,
  createSonarRequestHandler,
  loadSonarAdapterConfig,
  parseSonarProperties,
  sanitizedChildEnvironment,
} from "../src/sonar-adapter.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-sonar-adapter-"));
  const configPath = path.join(root, "lsp.json");
  await writeFile(path.join(root, "sonar-project.properties"), "sonar.projectKey=gigapay_app\nsonar.organization=gigapay\n");
  await writeFile(configPath, JSON.stringify({
    sonarqube: {
      enabled: true,
      focusOnNewCode: true,
      connection: {
        provider: "sonarcloud",
        connectionId: "gigapay-cloud",
        organizationKey: "gigapay",
        region: "EU",
        tokenCommand: ["credential-helper", "sonar"],
      },
    },
  }));
  return { root, configPath };
}

test("loads only explicit SonarQube Cloud connection and project binding", async () => {
  const { root, configPath } = await fixture();
  try {
    const config = await loadSonarAdapterConfig(configPath, root);
    assert.equal(config.projectKey, "gigapay_app");
    assert.equal(config.connection.organizationKey, "gigapay");
    assert.equal(config.connection.region, "EU");
    assert.equal(config.focusOnNewCode, true);
    assert.deepEqual(parseSonarProperties("# comment\na = one\\\n two\nb:three\n"), { a: "onetwo", b: "three" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a project whose organization does not match the user connection", async () => {
  const { root, configPath } = await fixture();
  try {
    await writeFile(path.join(root, "sonar-project.properties"), "sonar.projectKey=other_app\nsonar.organization=other\n");
    await assert.rejects(loadSonarAdapterConfig(configPath, root), /organization does not match/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("answers Sonar custom requests and caches a validated credential", async () => {
  const { root, configPath } = await fixture();
  try {
    const config = await loadSonarAdapterConfig(configPath, root);
    const runtime = { eslintBridge: path.join(root, "eslint-bridge") };
    const protocol = createSonarProtocolConfig(config, runtime);
    const uri = "file:///workspace/index.ts";
    let credentialCalls = 0;
    const handler = createSonarRequestHandler({
      config,
      protocol,
      openUris: new Set([uri]),
      runCredentialCommand: async (command, args, options) => {
        credentialCalls += 1;
        assert.equal(command, "credential-helper");
        assert.deepEqual(args, ["sonar"]);
        assert.equal(options.timeout, 10_000);
        return { stdout: "secret-value\nignored-second-line\n" };
      },
    });

    assert.equal(await handler("sonarlint/isOpenInEditor", [uri]), true);
    assert.deepEqual(await handler("sonarlint/shouldAnalyseFile", {}), { shouldBeAnalysed: true });
    assert.equal(await handler("sonarlint/getTokenForServer", ["EU_gigapay"]), "secret-value");
    assert.equal(await handler("sonarlint/getTokenForServer", ["EU_gigapay"]), "secret-value");
    assert.equal(credentialCalls, 1);
    await assert.rejects(handler("sonarlint/getTokenForServer", ["US_other"]), /Unexpected Sonar credential identity/);

    const settings = await handler("workspace/configuration", { items: [{ section: "sonarlint" }, { section: "files.exclude" }] });
    assert.equal(settings[0].connectedMode.project.projectKey, "gigapay_app");
    assert.deepEqual(settings[1], {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scrubs configured and conventionally named Sonar tokens from the Java environment", () => {
  const config = { connection: { tokenEnv: "PRIVATE_CREDENTIAL" } };
  const environment = {
    PATH: "/bin",
    PRIVATE_CREDENTIAL: "secret",
    SONAR_TOKEN: "secret",
    MY_SONAR_ACCESS_TOKEN: "secret",
    SAFE_VALUE: "kept",
  };
  assert.deepEqual(sanitizedChildEnvironment(config, environment), { PATH: "/bin", SAFE_VALUE: "kept" });
});
