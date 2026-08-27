import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  JGIT_SHA256,
  JGIT_VERSION,
  SONAR_RELEASE,
  safeDestination,
  sonarJgitPath,
  sonarRuntimeDirectory,
} from "../src/sonar-install.mjs";

test("uses pinned Sonar and JGit runtime locations", () => {
  const environment = { XDG_DATA_HOME: "/data" };
  assert.equal(SONAR_RELEASE, "5.8.1+80613");
  assert.equal(JGIT_VERSION, "7.0.0.202409031743-r");
  assert.equal(JGIT_SHA256, "cc9f5f5772fa6b952a907d76531eb08f1fd8a8830cf1a3573261d7dd955c014a");
  assert.equal(sonarRuntimeDirectory("linux", "x64", environment, "/home/test"), "/data/pi-lsp/sonarqube/5.8.1/linux-x64/extension");
  assert.equal(sonarJgitPath(environment, "/home/test"), `/data/pi-lsp/sonarqube/jgit/${JGIT_VERSION}/org.eclipse.jgit-${JGIT_VERSION}.jar`);
});

test("rejects VSIX entries that escape the extraction directory", () => {
  const root = path.resolve("/tmp/runtime");
  assert.equal(safeDestination(root, "extension/server/sonarlint-ls.jar"), path.join(root, "extension/server/sonarlint-ls.jar"));
  assert.throws(() => safeDestination(root, "../outside"), /Unsafe VSIX entry/);
  assert.throws(() => safeDestination(root, "/absolute"), /Unsafe VSIX entry/);
  assert.throws(() => safeDestination(root, "extension\\..\\outside"), /Unsafe VSIX entry/);
});
