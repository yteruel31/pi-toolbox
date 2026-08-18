# Clean-room record

`@yteruel31/pi-subagents` was rewritten from a behavior-only specification in an isolated workspace.

## Prohibited sources

The rewrite did not inspect or reuse:

- the previous `pi-toolbox/packages/subagents/src/**` implementation;
- its previous tests or Git history;
- the unlicensed upstream repository from which that previous implementation had been adapted.

No previous implementation or test file was copied into this package.

## Authorized inputs

Implementation decisions were derived from:

1. `SPEC.md`, a behavior-only specification written before implementation;
2. official Pi 0.84.1 documentation and MIT-licensed bundled examples;
3. public declarations/documentation shipped with `@anthropic-ai/claude-agent-sdk` 0.3.234;
4. public TypeBox, Pi AI, and Pi TUI APIs needed to implement those documented contracts.

The isolated research notes are retained in the development workspace under `reference/` but excluded from the npm tarball.

## Independent source inventory

All files under `src/**` and `test/**`, plus `README.md`, `ARCHITECTURE.md`, and this record, were independently authored under the clean-room source restrictions. Initial implementation happened in the isolated workspace; post-import fixes continued under the same prohibition and authorized references. The package uses a new MIT license owned by Yoann TERUEL.

## Audit gates

Before import into `pi-toolbox`:

- search source/tests for names, paths, or attribution unique to the prohibited implementation;
- verify no prohibited source or test path exists in the package tree;
- run typecheck and all offline tests;
- build from source;
- inspect `npm pack --dry-run` output;
- install the packed artifact into a fresh temporary npm project and import its public entry point;
- compare the imported file list against this clean-room workspace, not against the previous implementation.

Repository history before the clean-room replacement still contains the former package. Rewriting that repository history is a separate disruptive operation and is not claimed here. This record establishes the provenance of the replacement files and publishable tarball.
