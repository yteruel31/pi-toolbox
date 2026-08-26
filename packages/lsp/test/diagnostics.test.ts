import assert from "node:assert/strict";
import test from "node:test";

import { DiagnosticLedger, MutationVersions, formatDiagnosticCardForModel } from "../src/diagnostics.js";
import type { Diagnostic } from "../src/types.js";

function diagnostic(line: number, message: string): Diagnostic {
  return {
    range: { start: { line, character: 2 }, end: { line, character: 5 } },
    severity: 1,
    source: "ts",
    code: 2322,
    message,
  };
}

test("reports only new diagnostics and announces a cleared file", () => {
  const ledger = new DiagnosticLedger();
  const first = ledger.update("/repo", "/repo/src/a.ts", "typescript", [diagnostic(2, "bad type")], 50, false);
  assert.ok(first);
  assert.match(formatDiagnosticCardForModel(first), /src\/a.ts:3:3 ts:2322 bad type/);

  assert.equal(ledger.update("/repo", "/repo/src/a.ts", "typescript", [diagnostic(8, "bad type")], 50, false), null);

  const duplicate = ledger.update(
    "/repo",
    "/repo/src/a.ts",
    "typescript",
    [diagnostic(8, "bad type"), diagnostic(9, "bad type")],
    50,
    false,
  );
  assert.equal(duplicate?.diagnostics.length, 1, "a second identical occurrence is still new");

  const second = ledger.update(
    "/repo",
    "/repo/src/a.ts",
    "typescript",
    [diagnostic(8, "bad type"), diagnostic(10, "another type")],
    50,
    true,
  );
  assert.equal(second?.diagnostics.length, 1);
  assert.equal(second?.delayed, true);

  const cleared = ledger.update("/repo", "/repo/src/a.ts", "typescript", [], 50, false);
  assert.equal(cleared?.cleared, true);
  assert.match(formatDiagnosticCardForModel(cleared!), /cleared/);
});

test("invalidates deferred mutation generations", () => {
  const versions = new MutationVersions();
  const first = versions.begin("/repo/a.ts");
  assert.equal(versions.isCurrent("/repo/a.ts", first), true);
  versions.begin("/repo/a.ts");
  assert.equal(versions.isCurrent("/repo/a.ts", first), false);
});
