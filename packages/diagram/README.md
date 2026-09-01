# `@yteruel31/pi-diagram`

Create, edit, render, review, and host structured diagrams directly from Pi. The package returns a PNG preview and deterministic readability summary after each mutation, plus a capability-scoped viewer URL for human inspection and export.

This is a native Pi package. It does not start an MCP server or provide adapters for other agent harnesses.

## Install

```bash
pi install npm:@yteruel31/pi-diagram
```

Node.js 22.19 or newer is required. Restart Pi after installation.

## What it creates

The V1 document model is deliberately focused on box-and-arrow diagrams:

- automatic top-to-bottom, left-to-right, bottom-to-top, or right-to-left layout;
- boxes, rounded boxes, ellipses, diamonds, and cylinders;
- labelled solid, dashed, or dotted edges;
- optional groups and light, dark, or neutral themes;
- persistent documents with stable node, edge, and capability ids.

Free-form SVG primitives, arbitrary SVG imports, Mermaid input, charts, and browser-side editing are not supported.

## Pi tool

The extension registers one `diagram` tool with these actions:

- `create` — create a document from a complete `spec`;
- `update` — replace the spec or apply a focused patch;
- `render` — return the current PNG and viewer URL again;
- `review` — lint readability and return an annotated PNG without exposing the capability URL;
- `inspect` — read the normalized spec and metadata;
- `list` — list persisted documents and their viewer URLs;
- `delete` — delete a document and immediately invalidate its capability URL.

A create call looks like this:

```json
{
  "action": "create",
  "title": "Request lifecycle",
  "spec": {
    "direction": "LR",
    "theme": "light",
    "nodes": [
      { "id": "browser", "label": "Browser" },
      { "id": "api", "label": "API", "shape": "rounded" },
      { "id": "database", "label": "PostgreSQL", "shape": "cylinder" }
    ],
    "edges": [
      { "id": "request", "from": "browser", "to": "api", "label": "HTTPS" },
      { "id": "query", "from": "api", "to": "database", "style": "dashed" }
    ]
  }
}
```

Keep ids stable and use `update.patch` for small changes:

```json
{
  "action": "update",
  "id": "diag_0123456789ab",
  "patch": {
    "set_nodes": [{ "id": "api", "label": "Public API", "shape": "rounded" }],
    "set_theme": "dark"
  }
}
```

The model sees a PNG generated from the exact SVG served by the viewer. Inline previews are bounded to 2048 px per dimension; viewer downloads are bounded to 4096 px.

After `create` and `update`, the result includes a bounded review summary. Call `review` with the diagram id to receive numbered annotations for text overflow, WCAG contrast, edge crossings, edge/node or edge/text collisions, label collisions, group collisions, and detached empty groups. Review findings are deterministic checks against the renderer's shared model-space scene; they complement rather than replace visual inspection. The reviewer never edits a diagram automatically.

## Viewer

The viewer updates over server-sent events and provides:

- wheel/pinch zoom, drag pan, fit, and 100% controls;
- light, dark, and drafting-grid backdrops;
- PNG and SVG downloads;
- **Copy image** using `ClipboardItem` when the browser supports image clipboard writes;
- **Copy SVG** using the text clipboard API, with a legacy copy fallback.

Clipboard writes require a user gesture and a secure browser context. `localhost` and `127.0.0.1` qualify. External hosting must use HTTPS. When a browser does not expose the required clipboard API, downloads remain available.

The viewer never receives arbitrary HTML or imported SVG. Generated SVG is loaded through `<img>`, not injected with `innerHTML`.

## Hosting

Without configuration, the host binds to `127.0.0.1:19878` at `/diagram`:

```text
http://127.0.0.1:19878/diagram/d/<capability>/
```

Configure hosting with `/diagram`:

```text
/diagram status
/diagram list
/diagram setup local [port]
/diagram setup tailscale [https-port] [backend-port]
/diagram setup custom <https-url> [listen-address] [backend-port]
/diagram diagnose
/diagram remove-tailscale
```

The generated configuration lives at `~/.pi/agent/diagram.json` with mode `local`, `tailscale`, or `custom`.

### Local

```json
{
  "hosting": {
    "mode": "local",
    "basePath": "/diagram",
    "port": 19878
  }
}
```

Local mode always binds to loopback. Set `port` to `0` manually if a stable URL is not required and an ephemeral port is preferable.

### Managed Tailscale Serve

```json
{
  "hosting": {
    "mode": "tailscale",
    "basePath": "/diagram",
    "port": 19878,
    "httpsPort": 8443,
    "hostname": "auto",
    "requireTailscaleIdentity": true
  }
}
```

`/diagram setup tailscale` creates only the selected Tailscale Serve path and refuses to overwrite a conflicting route. It then verifies the complete external path with a one-time challenge. Requests without the Tailscale identity header return 404 by default.

### Custom HTTPS reverse proxy

```json
{
  "hosting": {
    "mode": "custom",
    "basePath": "/diagram",
    "port": 19878,
    "listenAddress": "127.0.0.1",
    "externalUrl": "https://diagrams.example.com/diagram"
  }
}
```

The reverse proxy must route the exact external base path to the configured backend. `/diagram setup custom ...` starts a candidate host, verifies that the external URL reaches it, and only then saves the configuration. URLs with credentials, query strings, fragments, non-HTTPS schemes, or a mismatched path are rejected.

Keep `listenAddress` on loopback when the reverse proxy runs on the same machine. A non-loopback custom listener exposes the capability endpoints directly over HTTP as well as through the HTTPS proxy.

## Link lifetime and persistence

Documents and capability tokens persist under `~/.pi/agent/diagram/documents`. The server itself is session-bound: it starts lazily on the first tool or command that needs it and stops during Pi shutdown.

Consequences:

- a fixed port or external base URL keeps document URLs stable between sessions;
- links are unavailable while Pi is not running;
- listing or rendering a document in a later Pi session makes its existing URL available again;
- deleting a document invalidates its token permanently.

The package does not install a detached daemon. On operating systems with fixed-port socket reuse support (including Linux), multiple concurrent Pi sessions can share the configured port. They synchronize mutations through the persisted store and propagate external-session revisions to connected viewers. Other platforms retain normal single-session hosting and report `EADDRINUSE` if a second session tries to own the same fixed port.

## Security model

Viewer URLs contain a random 256-bit capability. Anyone who obtains a custom-hosted capability URL can view and download that diagram. Do not publish sensitive diagrams through an untrusted reverse proxy or paste capability URLs into public channels.

The security boundary is the operating-system user: another process running as the same user can read stored capabilities and, on reuse-port platforms, join the configured listener. Tailscale's injected identity header is defense in depth for proxied requests, not an authentication boundary against local same-user processes; the capability remains the authorization secret.

The host additionally uses strict CSP, `nosniff`, same-origin resource policy, no-referrer, and no-store headers. Labels are XML-escaped, custom colors accept only six-digit hex values, unsupported spec keys are rejected, and arbitrary SVG imports are not accepted.

## Storage limits

- 100 documents;
- 300 nodes and 600 edges per document;
- 50 groups;
- 200 characters per label;
- 4096 px maximum PNG dimension.

## Development

```bash
npm run check -w @yteruel31/pi-diagram
npm run pack:dry -w @yteruel31/pi-diagram
```

The implementation is clean-room and shares no code with `svg-mcp`. See [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) for Dagre and resvg license notices.

<!-- AI generated -->
