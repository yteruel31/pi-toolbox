# @yteruel31/pi-context

Local-first context and memory for Pi, using SQLite FTS5/BM25 only. It provides four capabilities:

1. observational capture and reflection for the current session;
2. explicit durable facts and lessons;
3. local session indexing and search;
4. bounded local knowledge-file indexing and search.

There are no embeddings, vectors, separate model providers, API keys, or provider commands.

## Requirements and installation

Requires Node.js 22.19 or newer. The extension probes the running Node.js SQLite build for FTS5 at runtime; see [Degraded operation](#degraded-operation).

Install this package alone:

```bash
pi install npm:@yteruel31/pi-context
```

Or install the complete toolbox:

```bash
pi install git:github.com/yteruel31/pi-toolbox
```

Restart Pi after installation.

## Public surface

The extension registers exactly 11 tools:

- `memory_search` — search durable facts and lessons.
- `memory_remember` — store or update an explicit fact or lesson.
- `memory_forget` — remove an explicit fact or lesson.
- `memory_lessons` — list durable lessons.
- `memory_stats` — inspect memory and consolidation state.
- `session_search` — search indexed sessions.
- `session_list` — list indexed sessions.
- `session_read` — read a bounded session transcript.
- `knowledge_search` — search indexed knowledge chunks.
- `kb_read` — read a known indexed note.
- `recall` — inspect an observational item and its available sources.

It registers exactly eight commands:

- `/memory-consolidate`
- `/session-sync`
- `/session-reindex`
- `/knowledge-search-setup`
- `/knowledge-overview`
- `/knowledge-reindex`
- `/om:status`
- `/om:view`

All search is lexical SQLite FTS5 search ranked with BM25. Semantic similarity and embedding fallback are not provided.

## Storage

All package state is under Pi's agent directory at `~/.pi/agent/context/`:

```text
~/.pi/agent/context/
├── config.json
├── memory.db
├── sessions.db
└── knowledge.db
```

Observational state is recorded in the Pi session ledger rather than another database. New observational session entry types are:

- `context.observations.recorded`
- `context.reflections.recorded`
- `context.observations.dropped`
- `context.folded`

The extension also emits private context entries such as `context.memory`, `context.session-primer`, and `context.knowledge-overview` for bounded prompt context.

## Configuration

`config.json` uses strict schema version 1. A complete clean example is:

```json
{
  "version": 1,
  "models": {
    "observer": { "provider": "anthropic", "model": "claude-sonnet-4-5", "thinkingLevel": "off" },
    "reflector": { "provider": "anthropic", "model": "claude-sonnet-4-5", "thinkingLevel": "low" },
    "dropper": { "provider": "anthropic", "model": "claude-haiku-4-5", "thinkingLevel": "minimal" },
    "consolidation": { "provider": "anthropic", "model": "claude-sonnet-4-5", "thinkingLevel": "medium" }
  },
  "knowledge": {
    "roots": ["/home/me/notes", "/home/me/projects/docs"],
    "extensions": ["md", "mdx", "txt"],
    "excludes": ["node_modules", ".git", "private"],
    "limits": {
      "maxRoots": 16,
      "maxFiles": 10000,
      "maxDepth": 24,
      "maxFileBytes": 2097152,
      "maxTotalBytes": 134217728
    }
  }
}
```

Each model route is optional. If a route is omitted, that worker uses Pi's active model. `thinkingLevel` is optional and accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.

Run `/knowledge-search-setup` to write roots, extensions, and excludes, then reload the context runtime. Use absolute roots and keep them narrowly scoped. Configuration writes are atomic and private. After manual config edits, restart Pi so every feature uses the same configuration generation.

## Privacy boundaries

- Session and knowledge indexes remain local SQLite files.
- Only observation and consolidation work for the current session is sent to the explicitly configured Pi model, or to Pi's active model when that route is omitted.
- Indexed knowledge reaches the parent model only when a knowledge tool is invoked; files are not sent to a separate service.
- The package has no separate provider, key, embedder, or vector store.

Choose knowledge roots as a disclosure boundary: tool results requested by the parent model can contain matching indexed text.

## Lifecycle and indexing

Tool and command registration is side-effect free. Databases and default runtime state are created only when a Pi session starts. Session shutdown closes the runtime and rejects stale operations.

Use `/session-sync` for an incremental session index update and `/session-reindex` for a full session rebuild. Use `/knowledge-reindex` after changing files or configuration to force a safe full knowledge rebuild. `/knowledge-overview` reports the bounded current index.

### Degraded operation

At startup the package probes SQLite FTS5. If FTS5 is unavailable, persistent `memory_search` uses a deterministic LIKE fallback, while session and knowledge FTS searches return explicit unavailable diagnostics. List, read, metadata, and observational functionality remain available. There is no embedding or semantic fallback. Install/run Pi with a Node.js build whose `node:sqlite` includes FTS5, restart Pi, then reindex.

## Troubleshooting and deletion

- **Configuration rejected:** validate JSON and use exactly schema version `1`; remove unknown or legacy fields.
- **FTS5 unavailable:** run the probe below in the same Node runtime as Pi, then replace that runtime if it fails:

  ```bash
  node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(':memory:');d.exec('CREATE VIRTUAL TABLE probe USING fts5(value)');console.log('FTS5 available')"
  ```

- **Results stale or absent:** check configured roots, extensions, excludes, and limits; run the appropriate reindex command.
- **Reset all package data:** stop Pi, then remove `~/.pi/agent/context/`. This permanently deletes configuration and all three indexes. Session-ledger observational entries remain in their Pi session files.

## Rollout and compatibility

This package intentionally provides no compatibility with legacy data, configuration, custom entry formats, or storage paths. Coexistence with old memory, observational-memory, session-search, or knowledge-search packages is unsupported because tools, injected context, and lifecycle work may overlap.

Remove old extensions from Pi settings, install this package, and restart Pi. A one-shot local migration, if desired, is intentionally a separate post-implementation agent task; it is not package code and is not performed automatically.

## License

MIT. See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for retained attribution and architecture provenance.
