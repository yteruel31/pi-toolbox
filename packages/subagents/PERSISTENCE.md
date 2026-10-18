# Subagent session persistence

## Format and storage

New entries use `customType: pi-subagents-state-v2`. Only the latest state entry
on the active Pi branch is authoritative (v1 and v2 are both recognized).
The data is a compact checkpoint, not a transcript:

```json
{
  "version": 2,
  "namespace": "<sha256 of the source session id>",
  "nextSerial": 2,
  "nextSettlementSeq": 2,
  "runs": [
    { "id": "run-1", "artifact": "<sha256 of run descriptor>", "consumption": "waited" }
  ]
}
```

Artifacts live at
`<getAgentDir()>/subagents/artifacts/<namespace>/<sha256>.json`, normally below
`~/.pi/agent`. `PI_CODING_AGENT_DIR` follows Pi's usual agent-directory behavior.
`ExtensionDependencies.stateDirectory` provides a trusted local root for tests
and embedders; session data cannot supply a filesystem root or filename.

Each immutable run descriptor contains run metadata and content hashes for:

- each retained activity entry;
- each retained structured transcript entry;
- final text and error text, separately when present.

Chunks are JSON values addressed by SHA-256 of their exact UTF-8 bytes.
Consumption is deliberately **not** in the descriptor: waiting, collecting, or
delivering a result changes the checkpoint, not its payload artifacts. Active
transcript revisions share existing entry chunks; they don't write a copy of
the growing transcript. New descriptor revisions repeat only metadata and
hashes. Settled descriptors are cached for the current manager lifetime.
Unchanged chunks are not rewritten, including after reload.

Writes use exclusive temporary files, mode `0600`, file sync, atomic rename,
and directory sync before appending the session checkpoint. New directories
use `0700`. Directory sync and Unix mode/owner enforcement apply on POSIX;
Node on Windows cannot sync directories, so only file sync and atomic rename
apply there. Linux is the locally tested platform. The storage root and namespace must be current-user-owned and
private. Symlinked ancestors/files, non-regular files, world-writable ancestors
(other than sticky system directories), and non-hash references are rejected.
Reads verify checksums and schema and are bounded to 16 MiB **per chunk**.
Existing current-user-owned group-writable ancestors are permitted, as in Pi's
common directory layout; other group members could rename ancestors or race
path checks. This is private local storage, not a sandbox against hostile
same-user processes or concurrent ancestor replacement.

Namespaces prevent unrelated sessions with the same `run-1` id from colliding.
A checkpoint copied by a Pi fork explicitly retains its source namespace for
reads; the fork writes its next checkpoint/artifacts in its own namespace.
Immutable references keep earlier branch checkpoints readable. Copying a Pi
session to another machine requires copying its referenced artifact store too.

## Measurable volume guarantee

For N tracked runs (up to 10,000), the writer enforces:

```text
Buffer.byteLength(JSON.stringify(checkpoint), "utf8") <= 256 + 160 * N
```

This bound covers the v2 **data**, excluding Pi's entry envelope, and is
independent of titles, paths, routing metadata, activity, transcripts, and
result lengths. At 175 runs the maximum is 28,256 bytes. Checkpoints still
repeat O(N) small references; total lifecycle metadata is not constant-sized.

The reproducible synthetic test in `test/run-state-store.test.ts` uses 175
runs, each with 20 approximately 4,000-character multibyte transcript entries
and a roughly 45,000-character result. One local measurement:

| Measurement | Bytes |
| --- | ---: |
| Same retained state serialized inline as v1 | 36,102,770 |
| v2 checkpoint | 20,945 |
| All artifact revisions/chunks, logical file bytes | 36,534,569 |
| 20 additional unchanged v1 checkpoints | 722,055,400 |
| 20 additional unchanged v2 checkpoints | 418,900 |
| New or rewritten artifact files for those 20 checkpoints | 0 |

Timestamps may slightly change byte totals. The test checks the byte bound on
every checkpoint, exact artifact names/sizes/mtimes across unchanged writes,
and readable consumed results after reload. It also grows an active transcript
through 24 checkpoints and verifies that only 24 assistant chunks exist,
rather than 24 copies of the accumulated transcript. Figures are synthetic,
not measurements of any existing BB thread. Logical file bytes exclude
filesystem block/inode overhead; many small chunks cost extra inodes.

## Restoration, compatibility, and failures

The core's `PersistedRunState`/`snapshotState()` remains the full, version-1
in-memory interchange contract for existing embedders and lifecycle consumers.
Only the Pi adapter uses the compact external format. Core limits on retained
logs and result text remain unchanged; this is not an archive of output already
evicted by those limits.

A valid latest v1 checkpoint is restored directly, then externalized into a v2
checkpoint **before** exposing results, even when every run was already
consumed. Old entries aren't rewritten, deleted, or recopied into new session
entries. Legacy records without profiles or structured transcripts still work;
activity supplies the older transcript fallback. Malformed legacy records fail
closed rather than resetting ids or resurrecting an older checkpoint.

Settled runs retain consumption and payloads. Previously active runs become
explicit interrupted failures; their child processes aren't resumed. Owed
results can be delivered once after restore without starting a new parent turn.
Repeated explicit reads remain supported, but `newlyConsumedIds` is populated
only by the first successful consumer.

A missing/corrupt/unsafe artifact or malformed latest checkpoint disables the
session's subagent tools with an explicit error. It never falls back to older
state, invents a successful empty result, or overwrites the bad checkpoint.
Repair requires restoring the referenced files from a trusted backup; there is
no automatic destructive reset. Errors/notifications contain no raw payloads
or arbitrary filesystem error messages.

An initial persistence failure prevents child startup. Background write
failures are reported without leaking unhandled harness rejections. A failed
wait/collect/delivery commit rolls back consumption and retains the owed result
for retry; automatic delivery sends no message on failed persistence. Tests
cover artifact write errors and session-entry append errors separately.

There is no transaction spanning Pi's checkpoint append and its later parent
message delivery. The existing persist-before-delivery policy avoids duplicate
automatic delivery after reload, but a process crash after consumption commits
and before the message is sent can omit that automatic message. The retained
result remains explicitly readable. Durability of the session entry itself is
limited to Pi's `appendEntry` contract; this package cannot fsync Pi's journal.

## Retention and scope

No artifact is deleted on consumption or checkpoint replacement. Historical
branches may still reference descriptors and chunks; failed appends can leave
unreferenced files. Garbage collection needs a separate reachability/retention
policy, including forks, and is intentionally not implemented here. Back up
session files and the artifact store together, and protect both as private data.

This change prevents cumulative **payload** copying into session entries. The
manager still retains bounded per-run contents in memory and projects full
in-memory snapshots; startup migration and first writes perform synchronous
filesystem work to preserve the current lifecycle contract. It does not reduce
existing Pi/BB storage, change BB, migrate old sessions in bulk, or modify the
installed extension. Historical cleanup is a separate operation.

## Verification

From the repository root:

```sh
# Some existing Jev tests assume 0755 rather than group-writable mkdir defaults.
umask 0022
npm run check -w packages/subagents -- --maxWorkers=2
npm run test -w packages/subagents -- test/run-state-store.test.ts --reporter=verbose --silent=false
npm run build -w packages/subagents
npm run audit:subagents
```

Two workers avoid the existing packaging test's 5-second timeout under a fully
parallel cold dependency load. Tests use private temporary artifact roots and
fake harnesses, never the installed agent directory or real conversations.
