# @yteruel31/pi-context

A local-first Pi extension for four related capabilities: observational context capture, durable explicit memories, session search, and knowledge search.

The package will keep all new state under `~/.pi/context/`. Retrieval is deliberately limited to SQLite FTS5 with BM25 ranking. Memory workers will use Pi's existing model infrastructure rather than introducing a separate model provider.

There is no embeddings, provider, or vector-storage layer. The package does not read or migrate legacy data, configuration, custom entries, or storage paths.

This initial release is only the independently buildable package scaffold; public context tools and commands will follow.
