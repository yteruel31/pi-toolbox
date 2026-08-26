# `@yteruel31/pi-lsp`

Language-server diagnostics and symbol-aware code intelligence for [Pi](https://github.com/earendil-works/pi).

## Install

```bash
pi install npm:@yteruel31/pi-lsp
```

Or install the complete toolbox:

```bash
pi install git:github.com/yteruel31/pi-toolbox
```

Restart Pi after installation.

## What it does

- Synchronizes every successful built-in `write` and `edit` with the matching language server.
- Adds fresh diagnostics to the tool result seen by the model.
- Renders new diagnostics as a compact card in Pi's transcript.
- Exposes an `lsp` tool for diagnostics, definitions, references, hover information, document symbols, and semantic symbol renames.
- Starts language servers lazily and shuts them down after five idle minutes or when the Pi session ends.
- Does nothing when the project is untrusted or no matching server binary is installed.
- Refuses to synchronize individual documents larger than 10MB.

A rename is a preview unless `apply: true` is passed. Applied workspace edits are restricted to at most 500 existing files and 5,000 edits inside Pi's current workspace. They reject overlapping, snippet, resource-operation, and symbolic-link edits; share Pi's file mutation queues; use atomic per-file writes; and attempt rollback if a later write fails.

## Diagnostics UI

A mutation that introduces new diagnostics renders a card after the `write` or `edit` result:

```text
⚠ LSP · src/components/Button.tsx
LSP diagnostics for src/components/Button.tsx (typescript): 1 error, 2 warnings.
  24:12  typescript:2322  Type 'string' is not assignable to type 'number'
```

The compact view shows up to three new diagnostics. Expanding tool output shows the complete bounded result. Repeated diagnostics are suppressed. When the last reported diagnostic is fixed, Pi renders a short `diagnostics cleared` card.

Pi waits up to three seconds for inline diagnostics. A slower result does not block the file mutation: it is delivered later as a custom message, unless the file changed again in the meantime.

## `lsp` tool

| Action | Required arguments | Behavior |
| --- | --- | --- |
| `diagnostics` | `file` | Synchronize the file and list fresh diagnostics. |
| `definition` | `file`, `line`, `symbol` | Resolve definitions for the selected symbol occurrence. |
| `references` | `file`, `line`, `symbol` | Find project-aware references, including the declaration. |
| `hover` | `file`, `line`, `symbol` | Return type and documentation hover content. |
| `symbols` | `file` | List document symbols; optionally filter with `query`. |
| `rename` | `file`, `line`, `symbol`, `new_name` | Preview a semantic rename; set `apply: true` to write it. |
| `status` | none | Show detected, available, and running language servers. |
| `reload` | none | Stop clients and reload configuration. |

`line` is 1-indexed. `symbol` is a literal substring on that line. Append `#N` to select the Nth occurrence, for example `value#2`.

The optional `timeout` is in seconds, between 5 and 300. It defaults to 20.

## Default servers

The package knows how to start these servers when both a project root marker and executable are present:

- `basedpyright-langserver` or `pyright-langserver`
- `typescript-language-server`
- `rust-analyzer`
- `gopls`
- `clangd`
- `lua-language-server`
- `svelteserver`
- `vue-language-server`
- `bash-language-server`

Executables are resolved from project-local `node_modules/.bin`, Python virtual environments, local `bin`, then `$PATH`. When multiple primary servers support a file, the first available server by priority is used.

## Configuration

User configuration lives at `~/.pi/agent/lsp.json`. Trusted projects can override it with `.pi/lsp.json`.

```json
{
  "diagnostics": {
    "enabled": true,
    "inlineTimeoutMs": 3000,
    "deferredTimeoutMs": 25000,
    "maxDiagnostics": 50
  },
  "idleTimeoutMs": 300000,
  "requestTimeoutMs": 20000,
  "servers": {
    "typescript": {
      "args": ["--stdio"],
      "priority": 10
    },
    "pyright": false,
    "my-language": {
      "command": "my-language-server",
      "args": ["--stdio"],
      "fileTypes": [".mine"],
      "rootMarkers": ["mine.json", ".git"],
      "languageId": "mine",
      "initializationOptions": {},
      "settings": {}
    }
  }
}
```

Project configuration wins over user configuration. A server value of `false`, or `{ "disabled": true }`, disables it.

## v1 non-goals

- file rename orchestration through `workspace/willRenameFiles`
- code actions
- format-on-write
- raw LSP request passthrough
- shared language-server processes across Pi sessions
- server-initiated workspace edits
- workspace-wide compiler invocation such as `tsc` or `cargo check`

The design is inspired by [Oh My Pi's LSP integration](https://github.com/can1357/oh-my-pi#02--lsp-wired-into-every-write). This package is a separate Node.js implementation for Pi and does not copy Oh My Pi's Bun-specific source.

<!-- AI generated -->
