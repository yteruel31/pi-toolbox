# Pi Web Access

Five Pi tools for web research with bounded context output. This package is independent of `pi-web-access`; it isn't a full clone and doesn't change an existing installation or import its credentials.

## Tools

| Tool | Behavior |
| --- | --- |
| `web_search` | Gemini Google Search, Brave Search or OpenAI Responses web search; up to four queries, three concurrent requests, citations and optional fetched content/synthesis |
| `fetch_content` | HTML to Markdown, text/JSON/Markdown, images, PDF text, public GitHub repository clones, isolated JavaScript rendering and video frames; optional page-grounded `answer` mode |
| `get_search_content` | Bounded retrieval by response ID, document selection, character pagination and exact/case-insensitive passage finding |
| `source_check` | Search, fetch up to five sources, assess a claim with a Pi model, and validate quoted evidence against the retrieved text |
| `deep_research` | Start, inspect, retrieve or cancel native Gemini/OpenAI background research; save the complete report locally as Markdown |

No curator browser UI, authenticated browser sessions, OCR, audio transcription, video model calls, hosted extraction services, PR/issue specialization, Perplexity research, or repeated-search research simulation is included.

## Installation and collisions

The package is not yet published to npm. It can be loaded from this checkout or through the toolbox's Git package. Runtime TypeScript is the published entrypoint; `npm run build` provides a compile/bundle verification artifact, not a replacement installation directory.

Don't load this extension alongside another extension registering any of its five tool names. Registration happens at `session_start`, after existing tools are visible. If any name is already present, this package registers **none** of its tools and reports an actionable error. It never renames, disables or silently replaces another extension. Extensions that dynamically register conflicting names later must also be disabled by the user.

For migration, use `pi config` to disable the old extension before enabling this one, then `/reload`. Review the configuration below and explicitly recreate the settings you want. Old `~/.pi/web-search.json`, credentials, browser profiles and installed packages are untouched. To leave this package inactive within the toolbox, set `enabled` to `false` in its configuration.

To test a development worktree when the toolbox Git package is already installed, disable only its `packages/web-access/src/index.ts` resource with `pi config`, then launch `pi -e /absolute/path/to/worktree/packages/web-access/src/index.ts`. Keep the other installed toolbox resources enabled. Don't replace the whole toolbox package or modify the installed clone. Restore the installed web-access resource when you're done testing the worktree.

## Prerequisites

Install the system dependencies on the machine running Pi, not just on the laptop connected to it over SSH. The extension doesn't install OS packages, download browsers, or change security policies. A complete setup needs Linux: isolated JavaScript rendering and YouTube extraction aren't supported on macOS or Windows. Missing optional dependencies affect the corresponding feature, not registration of the five tools.

| Capability | Required software or setup |
| --- | --- |
| All tools | Node.js **22.19.0 or newer**, Pi, and the package's npm dependencies. Pi supplies its runtime peers. |
| `web_search`, `deep_research` | Your own API credentials for the selected provider. No extra OS package beyond the base setup. Consumer subscriptions aren't API keys. |
| `source_check`, search synthesis, `fetch_content` answer mode | A model authenticated in Pi, in addition to any search provider credentials. |
| HTML, text, images and PDF text | npm dependencies installed with this package. PDF extraction uses `unpdf`; no Poppler, OCR, Python, or Gemini PDF service is required. |
| Public GitHub repository cloning | `git` and system CA certificates. |
| Local video frames | `ffmpeg` and `ffprobe`, normally both provided by the `ffmpeg` OS package. |
| JavaScript-rendered pages | Linux, `bubblewrap` (`bwrap`), a native system Chromium/Chrome, and permitted unprivileged/nested user namespaces. |
| YouTube frames | The video dependencies, Linux, `bubblewrap`, system `python3`, CA certificates, and a recent system `yt-dlp`. Signature solving also needs a system Node and yt-dlp's locally installed EJS component. |
| Optional keyring credentials | `libsecret-tools` (`secret-tool`), a user session D-Bus, and a running Secret Service backend with an unlocked collection, for example GNOME Keyring. |

### Debian / Ubuntu system packages

These commands are examples for an administrator to review and run manually. They don't install Pi or guarantee that your distribution provides a recent enough Node or yt-dlp.

```bash
sudo apt-get update
sudo apt-get install git ca-certificates ffmpeg bubblewrap python3

# Optional: store provider credentials in Linux Secret Service.
sudo apt-get install libsecret-tools dbus-user-session gnome-keyring
```

On Debian, native Chromium is normally available as:

```bash
sudo apt-get install chromium
```

On Ubuntu, `chromium-browser` can be a Snap launcher rather than a native browser binary. A Snap/Flatpak launcher or a Playwright-downloaded browser isn't a supported substitute inside this sandbox. Install a native system Chromium/Chrome suitable for your distribution. Set `WEB_ACCESS_CHROMIUM_PATH` to its actual executable under `/usr` or `/opt` if it isn't detected automatically. The extension never falls back to `--no-sandbox`; an administrator must check namespace/AppArmor/container restrictions if isolation fails.

Install a current `yt-dlp` from a trusted distribution package or its [official installation instructions](https://github.com/yt-dlp/yt-dlp#installation). Distribution versions can be too old for the flags used here. Follow its [EJS setup instructions](https://github.com/yt-dlp/yt-dlp/wiki/EJS) for signature solving: remote component downloads are disabled by this extension, so the component must already be installed locally.

YouTube's sandbox only discovers `yt-dlp` at `/usr/bin/yt-dlp` or `/usr/local/bin/yt-dlp`, Python at `/usr/bin/python3`, and Node at `/usr/bin/node` or `/usr/local/bin/node`. Installations under a user's home directory, including typical pipx/nvm layouts, aren't visible inside it. Use a system installation with its supporting files under the mounted system directories, not a symlink into your home directory. Node installed elsewhere can still run Pi, but won't provide YouTube signature solving inside the sandbox.

### Diagnostic tab (recommended)

Open `/web-access` and use **Ctrl+Right / Ctrl+Left** to switch between **Setup** and **Diagnostic**. Opening the wizard reads only bounded local metadata: Linux support, executable bwrap, native ELF browser under `/usr` or `/opt`, namespace sysctls and AppArmor profile hints. It makes **no network request**, launches **no browser or subprocess**, reads no credential values and writes no settings. Executable detection is not version/library/runtime validation. HTTP connectivity is explicitly **untested**, not reported as working just because Node is installed.

- **Refresh checks [r]** reruns those inexpensive checks and clears the previous test result.
- **Test isolated render [t]** is an explicit action, also selectable with Left/Right then Enter. It runs the production `renderPage` launch plan, Chromium sandbox and parent route handler. A synthetic `.invalid` page is supplied by the parent without DNS/HTTP; success requires a JavaScript-created DOM mutation, not just launching Chrome or reading static HTML.
- The render test has a **10-second operation budget**, followed by cleanup. **c** cancels and waits for cleanup; Esc closes the wizard and requests cancellation. An in-flight Playwright launch may take the rest of its bounded launch timeout to terminate. Late launch results are joined and closed before removing the temporary wrapper. Results are not persisted; closed panels ignore late completions.
- Up/Down or PgUp/PgDn scroll the findings and full manual commands. No displayed installation or repair command is executed by Pi.

A successful synthetic test confirms the isolated browser, parent routing and JS execution on this host, **not** live DNS/TLS/HTTP, external site compatibility, provider API credentials or YouTube support. Test a real URL separately only when desired. `fetch_content({ url: "https://example.com", render: "never" })` exercises actual classic HTTP; `render: "always"` exercises actual rendering for HTML. `raw` mode never renders, and PDF/images/plain text use their own extractors.

Classic HTTP remains available without Linux/browser/bwrap dependencies. With `auto`, nearly empty HTML can trigger the optional renderer; failures stay errors, never a silent success pretending JS was rendered. Choose `render: "never"` (or `fetch.javascript: "never"`) deliberately for HTTP-only extraction.

Browser errors distinguish missing bwrap, missing or incompatible browser, unsupported OS, observed launch namespace/AppArmor denials, parent-request failure, timeout/cancellation and unknown launch/render causes. Only **launch** output is classified as sandbox evidence; page-controlled errors cannot establish an AppArmor denial. Raw browser logs, environment values, configured browser paths and nested error causes are not returned. A generic permission error or `No usable sandbox` is not enough to blame AppArmor.

### Ubuntu 26.04 targeted AppArmor repair

This is a **conditional administrator procedure**, not a general Ubuntu/Linux fix. The observed configuration was Ubuntu 26.04 with Google's native `google-chrome-stable` at `/opt/google/chrome/chrome`, bubblewrap, `unprivileged_userns_clone=1`, `max_user_namespaces=56952`, and `apparmor_restrict_unprivileged_userns=1`. The actual launch was denied `capability sys_admin` by `unpriv_bwrap`. These nonzero sysctls do not rule out a nested namespace denial. Conversely, a generic `unshare` command failing does not prove this specific bwrap/Chrome launch fails.

First run the explicit render test. On failure, inspect **matching** local kernel audit events (access may require an administrator):

```bash
journalctl -k --since '-5 minutes' --grep='apparmor="DENIED"|unpriv_bwrap|chrome'
/usr/sbin/sysctl kernel.unprivileged_userns_clone user.max_user_namespaces kernel.apparmor_restrict_unprivileged_userns
```

Do not paste unredacted system logs into chat. Match timestamps, executable and profiles to the failed test. An administrator must distinguish missing binaries/libraries, AppArmor, kernel policy and container restrictions.

The Diagnostic tab only offers the following candidate recipe when Ubuntu **26.04**, the exact Chrome executable, ABI **5.0** bwrap profile layout with `&bwrap//&unpriv_bwrap`, the local include, a matching `chrome` profile, kernel stacking and `/usr/sbin/apparmor_parser` are detected. Missing/unreadable metadata means compatibility is **not established**. Files do not prove the policy is loaded, and layout detection does not prove parser priority support. Verify the parser offline, **without loading a policy**:

```bash
printf '%s\n' 'abi <abi/5.0>,' \
  'profile web_access_priority_check { priority=100 allow px /opt/google/chrome/chrome -> &bwrap//&chrome, }' \
  | /usr/sbin/apparmor_parser -Q -T
```

Only after this succeeds and matching audit evidence confirms the `unpriv_bwrap` capability denial, review the packaged profiles `/etc/apparmor.d/bwrap-userns-restrict` and `/etc/apparmor.d/chrome`. Back up the existing local override. Use an administrator editor:

```bash
sudoedit /etc/apparmor.d/local/bwrap-userns-restrict
```

Add this exact **narrow executable transition**, only if not already present:

```text
priority=100 allow px /opt/google/chrome/chrome -> &bwrap//&chrome,
```

This selects the stacked `bwrap`/`chrome` profiles instead of the capability-stripping `unpriv_bwrap` child profile for this executable. It permits Chrome's nested sandbox while keeping global user namespace restrictions and the production filesystem/network isolation. It changes the AppArmor transition for this system Chrome executable, not just this one Pi process: administrator review is required. Do not extend it to arbitrary executables or another distribution/version.

Compile the complete changed profile offline first; then, only on success, reload it manually and retest:

```bash
/usr/sbin/apparmor_parser -Q -T /etc/apparmor.d/bwrap-userns-restrict
sudo /usr/sbin/apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict
```

If compilation fails, restore the prior local file and do not reload. To undo an applied change, restore that backup, compile it offline and reload the same profile. Never disable AppArmor globally, switch profiles to complain mode as a workaround, set global restrictions to zero, or use `--no-sandbox`. No system postinstall or automatic browser installation is included. If the targeted rule is already present (as on the validated development host), **do not modify/reload it again merely to run diagnostics**.

On other distributions/versions the wizard provides only applicable package commands (Debian/Ubuntu bubblewrap, Debian native Chromium, Ubuntu amd64 official Chrome `.deb`) and investigation guidance. It does not infer commands from `ID_LIKE` or prescribe the Ubuntu 26.04 exception. Unknown distributions/architectures need their own vendor instructions. Google Chrome amd64 is not a browser-install recipe for Ubuntu arm64.

### Check before use

This only checks executable availability and versions. It doesn't read credentials or make paid API calls:

```bash
node --version
for binary in git ffmpeg ffprobe bwrap python3 yt-dlp secret-tool; do
  command -v "$binary" || printf 'Not found: %s\n' "$binary"
done
# If installed:
yt-dlp --version
```

Check the browser executable separately. A binary on `PATH` doesn't prove it's visible in the sandbox, that a Secret Service collection is unlocked, or that user namespaces are permitted. After reboot, a headless/SSH keyring may need to be unlocked again. See [Linux Secret Service](#linux-secret-service) for credential setup. API authentication and live Chromium/YouTube behavior still need testing on the target machine; this isn't a verified clean-machine installation recipe.

## Setup wizard

Run `/web-access` (or `/web-access setup` / `/web-access config`) in Pi's interactive terminal. The compact centered overlay follows `/mcp`, not a fullscreen screen. Use Ctrl+Right / Ctrl+Left to switch Setup/Diagnostic tabs. In Setup, use Up/Down to choose, Enter to continue, Shift+Tab to go back, PgUp/PgDn to scroll, and Esc to cancel. Switching tabs preserves staged settings and masked input. On a terminal too small to show a usable form, resize or cancel.

Choose a default search provider, enable or disable the tools, and review the model settings. Gemini and OpenAI have separate native search and deep-research model IDs. Brave has no native model settings. Pi synthesis is separate: leave it blank for the current Pi model, or enter `provider/model-id` using Pi's existing authentication and session model allowlist. The wizard doesn't fetch model catalogs or validate provider availability.

Choose **Keep current source**, **Private file (0600)**, or **Linux Secret Service keyring** explicitly. Keeping the source leaves existing environment, literal, file or keyring settings untouched and doesn't read or test the key. For new credentials, enter the key only in the masked field, never in chat, slash-command arguments, tool inputs or shell history. Secret input has no undo stack or kill ring; Ctrl+u clears it. The final review only says whether a key was entered, never its value.

Nothing is written before **Save changes**. Save preserves unrelated settings and other providers' credentials. Settings changes require `/reload`; saving doesn't automatically reload or resume research jobs. No API request or paid credential test is performed. The Diagnostic tab's explicit synthetic render test needs no API key or live network. Any later live test needs your explicit approval.

Settings and private credentials are written through exclusive temporary files with mode `0600`, fsynced, then atomically renamed individually. The writer rejects symlinks and files owned by another user. Only the credentials file requires an existing mode of `0600`; existing settings and parent directory modes aren't a setup prerequisite. The wizard never changes directory permissions. Directory access remains your responsibility: users who can write to a parent directory may replace files or path components. It uses Pi's file mutation queues, a package-local `web-access.json.lock`, and revision checks to reject stale wizard saves or detected external edits. The lock is advisory for external editors: don't edit these files while saving. After a crash, remove the lock only after checking that no Pi process is saving. Settings and credential storage aren't a single transaction: if storing the key succeeds but saving settings fails, the key may remain stored, and the wizard reports this rather than claiming a rollback. Interrupted saves may also leave private `.tmp` files; remove them only when no save is running.

If the keyring is unavailable, setup gives the required Linux dependencies and lets you return to storage selection. It never silently falls back to a file. Switching storage doesn't delete keys from the previous source. Run setup again to rotate a key; remove unused old credentials separately once you've verified the new source.

## Configuration

The current toolbox checkout uses package-owned configuration files under Pi's agent directory. This package follows that convention: `getAgentDir()/web-access.json`, normally `~/.pi/agent/web-access.json`, respecting `PI_CODING_AGENT_DIR`. It doesn't create a second settings registry or read project-local credential settings. Settings are read on startup; run `/reload` after editing. Unknown fields and invalid values fail closed.

```json
{
  "enabled": true,
  "search": {
    "provider": "brave",
    "geminiModel": "gemini-3.6-flash",
    "openaiModel": "gpt-5-mini"
  },
  "credentials": {
    "gemini": "$GEMINI_API_KEY",
    "openai": "$OPENAI_API_KEY",
    "brave": "$BRAVE_API_KEY"
  },
  "synthesisModel": "openai/gpt-5-mini",
  "research": {
    "outputDir": "/absolute/path/to/research",
    "geminiModel": "deep-research-preview-04-2026",
    "openaiModel": "o4-mini-deep-research",
    "pollIntervalMs": 10000
  },
  "fetch": {
    "timeoutMs": 30000,
    "maxBytes": 5242880,
    "maxPdfPages": 100,
    "javascript": "auto"
  },
  "cache": {
    "maxEntries": 128,
    "maxBytes": 134217728,
    "ttlMs": 3600000,
    "inlineChars": 12000
  }
}
```

All fields are optional. The example's search provider and dedicated synthesis model are choices, not implicit defaults. Without `search.provider`, each search must name a provider. Without `synthesisModel`, synthesis uses the current Pi model. API calls never fall back to another provider. OpenAI search doesn't support the `recencyFilter` parameter here and rejects it before making a request; Gemini and Brave support it. Domain restrictions are applied to returned sources as well as provider requests where supported. Provider-generated answers aren't proof that every claim satisfies the requested filter.

Credentials accept literals, `$NAME` or `${NAME}` environment references, and the explicit private-file or Linux keyring references below. They never execute user-provided commands or use ChatGPT/Codex/Gemini consumer subscriptions. Environment references are resolved only for the selected request. Keep the configuration private (`0600`). Pi model synthesis is separate: it uses Pi's model registry and existing authentication, respects the session model allowlist, and adds a model call whose usage is returned to Pi. Search/research provider consumption is reported when supplied; the extension doesn't invent dollar costs.

Research output defaults to `getAgentDir()/web-access/reports`. The content cache defaults to `getAgentDir()/web-access/cache`; `cache.directory` can override it with an absolute path. Research tracking remains under `getAgentDir()/web-access/research`, independently of cache eviction.

### Private credentials file (recommended for headless servers)

Store keys in `getAgentDir()/web-access.credentials.json`, normally `~/.pi/agent/web-access.credentials.json`. This is separate from settings and doesn't need D-Bus, a keyring, or extra runtime packages. The JSON object maps provider names (`openai`, `gemini`, `brave`) directly to API key strings. On Unix, the file must belong to the current user and have exactly `0600` permissions. Symlinks and non-regular files are rejected. On Windows, restrict access with your user profile's ACLs; Unix mode checks don't apply.

Use `/web-access setup` and choose **Private file (0600)**. No Python setup script is needed. The wizard writes the matching reference into `web-access.json`, for example:

```json
{
  "credentials": {
    "openai": "file:pi-web-access/openai"
  }
}
```

Use `file:pi-web-access/gemini` or `file:pi-web-access/brave` for the other providers. References must match their provider and can't name arbitrary paths. Existing environment defaults and keyring references stay unchanged. There is no automatic migration or fallback when an explicitly selected source fails.

Keys are read on each operation, so replacing a key in the same source doesn't require a reload. To rotate keys or add a provider, run `/web-access setup` again. For manual edits, use a trusted editor that doesn't upload contents or leave unprotected swap/backup files. Keep it outside Git and protect backups too. This is plaintext protected by filesystem permissions, not encryption: root and processes running as your user can read it. It doesn't change Pi's own model authentication.

### Linux Secret Service

To keep provider keys out of JSON and shell startup files, choose **Linux Secret Service keyring** in `/web-access setup`. The wizard runs `secret-tool` (usually provided by `libsecret-tools`) with the key passed through stdin, not command arguments. This uses the same Secret Service mechanism as the SonarCloud CLI, with separate `application=pi-web-access` and `provider` attributes. It isn't the kernel session keyring.

For manual setup outside Pi, run this interactively in your own terminal and enter the key at the prompt. Don't put the key in command arguments, shell history, or an agent conversation:

```bash
secret-tool store --label='Pi web-access OpenAI API key' application pi-web-access provider openai
```

Repeat with `provider gemini` or `provider brave` and a matching label for other keys. Configure only the providers you want to use:

```json
{
  "credentials": {
    "openai": "keyring:pi-web-access/openai",
    "gemini": "keyring:pi-web-access/gemini",
    "brave": "keyring:pi-web-access/brave"
  }
}
```

Each reference must match its provider. The helper runs directly without a shell, with a 30-second timeout and bounded output. Keys are resolved when needed, aren't cached across operations, and aren't written to research records or forwarded to the synthesis model. Missing entries, a locked collection, an unavailable helper, cancellation, and D-Bus failures produce sanitized errors, never a fallback to environment or literal credentials. Existing environment defaults remain unchanged unless you select a keyring reference.

On an SSH server, Pi must have access to a user session D-Bus and a running Secret Service implementation such as GNOME Keyring. `secret-tool` alone isn't enough. Persistence and encryption depend on the collection/backend; after logout or reboot, the collection may need to be unlocked again before background research can poll. Don't place an unlock password in scripts. This reduces accidental file/env leaks but doesn't isolate secrets from root or other processes allowed to access the same unlocked collection. Keys are stored only after explicit wizard confirmation or a manual `secret-tool store`. No automatic migration or change to Pi's own synthesis authentication is performed.

## Examples

```javascript
web_search({ queries: ["SQLite FTS5 ranking", "SQLite FTS5 tokenizer"], provider: "brave" })
web_search({ query: "TypeScript release notes", provider: "gemini", synthesize: true })
fetch_content({ url: "https://example.com/article" })
fetch_content({ url: "https://example.com/app", render: "always" })
fetch_content({ url: "https://example.com/report.pdf" })
fetch_content({ url: "https://github.com/owner/repository" })
fetch_content({ url: "https://example.com/docs", mode: "answer", prompt: "Which authentication methods are documented?" })
fetch_content({ url: "./recording.mp4", timestamp: "00:01:00-00:02:00", frames: 6 })
fetch_content({ url: "https://www.youtube.com/watch?v=abcdefghijk", timestamp: "30-60", frames: 3 })
get_search_content({ responseId: "returned-id", index: 0, offset: 12000, limit: 12000 })
get_search_content({ responseId: "returned-id", url: "https://example.com/article", findText: "authentication" })
source_check({ claim: "The service supports OAuth PKCE", provider: "brave" })
```

`fetch_content` accepts one `url` or up to five `urls`. `raw` returns exact decoded textual HTTP bodies, including non-2xx status bodies, without extraction or rendering. Binary raw responses are rejected. `answer` requires a `prompt`; it stores the original extracted text, not just the answer. `answerModel: "provider/model-id"` overrides the synthesis model per call. Answers only see bounded excerpts and must state evidence gaps.

`web_search` doesn't make an extra synthesis call unless `synthesize: true`. Its native Gemini/OpenAI answer and sources remain available without synthesis. `includeContent: true` fetches up to five sources before returning; it doesn't silently render pages, clone arbitrary code beyond recognized repo roots, or call an extraction service.

`source_check` returns a model judgment, not an automated proof. Every accepted quotation must be an exact substring of a fetched document. The artifact includes source offsets and SHA-256 hashes. Missing or invented quotations are rejected, and verdicts without matching support/contradiction are downgraded. Fetch failures remain visible. The stored artifact occupies document index 0; its evidence source indices refer to the accompanying `sources` list, whose documents follow the artifact in cache order.

Tool text is capped at 40,000 bytes / 1,500 lines. Fetch previews share `inlineChars` across the batch; full extracted text stays in the local cache. Finder results contain at most 20 passages within the configured character budget. `findText` cannot be combined with `offset` or `limit`. Cache entries expire after one hour by default and oldest entries are evicted at the configured count/byte limits. Files are created with `0600`, directories with `0700`; symlinked state/output directory paths are refused. Cache IDs don't expose arbitrary filesystem reads.

## Native deep research

```javascript
deep_research({ action: "start", provider: "gemini", subject: "Compare the current FTS5 tokenizer options and cite the SQLite documentation" })
deep_research({ action: "status" })
deep_research({ action: "status", researchId: "returned-research-id" })
deep_research({ action: "result", researchId: "returned-research-id" })
deep_research({ action: "cancel", researchId: "returned-research-id" })
```

Start returns a local `researchId` promptly, before the upstream job finishes submitting. Pi remains available. The extension requests native background mode and polls while Pi is running. On completion, the entire text report, citations and metadata are written to a local `.md` file. The tool returns the path and a preview of at most 600 characters, never the full report. Open the file in Zed, use `read`, or page through it with `get_search_content` and `responseId` equal to the research ID. Completion notifications don't trigger another model turn.

Both providers use API-key authentication. Gemini uses the Interactions API and configurable agent IDs; OpenAI uses Responses and configurable deep-research models. Gemini Max can be selected with `model: "deep-research-max-preview-04-2026"`; OpenAI also supports `o3-deep-research`. These are native research agents, not an extension-owned search loop. No files, MCP connectors or private project context are added to the research prompt.

`outputPath` on `start` overrides the directory with an explicit `.md` path, resolved against the current working directory. Existing files and symlink directory paths are refused before submission. Publication uses an exclusive temporary file followed by an atomic, non-overwriting hard link on the same filesystem. The file and publication directory are fsynced before a job can proceed. If another writer claims the destination while research is running, the provider result is retained privately. Use `result` with a different `outputPath` to publish it safely. Frontmatter stores subject/provider/model/date/status/usage and both local and upstream IDs. Partial reports stay marked `incomplete`, rather than being presented as finished research.

The same subject/provider/model/resolved-output/request-key combination reuses the same tracked job. Equivalent relative path spellings deduplicate; destinations in different working directories remain distinct. To intentionally start a new paid run, supply a new `requestKey`. History is capped at 128 jobs with at most four active submissions/runs. Research records and reports aren't deleted automatically; archive them manually when appropriate. Report payloads are capped at 20 MiB locally and provider response transport is bounded. Error bodies and API credentials aren't persisted.

On shutdown, local polling stops; upstream jobs are **not** automatically cancelled. On restart, tracked queued/running jobs resume polling. If submission was interrupted before its provider ID was saved, status becomes `submission_unknown`. The request may have been accepted and billed: it is never resubmitted automatically. Recover the upstream ID from provider-side records, then attach it with `status`, `researchId` and `upstreamId`. An unknown submission cannot truthfully be cancelled without that ID. Both providers' native cancellation endpoints are used; the returned upstream status is authoritative, including a completion/cancellation race.

Transient polling errors retain the upstream ID and can be retried through `status`; they never start a new job. A terminal upstream job whose report wasn't retained locally is retrieved again with GET, including after a local persistence failure or restart. Local `.lock` files prevent concurrent writers. A crash can leave a stale lock; remove only the named lock after confirming no Pi process is using that directory. A full disk or output filesystem lacking hard-link support produces an output error, not an overwrite. Upstream retention is finite: the APIs may no longer serve an old job even when its local record remains. `store: true` is requested explicitly for recovery and has provider-side retention/privacy implications.

## Local extraction and security

Direct fetches accept public HTTP(S) on ports 80/443 only. Every DNS answer must be public, and the checked address is pinned to the connection while retaining TLS hostname verification. Redirects are revalidated; HTTPS downgrades, credential-bearing URLs and API redirects are rejected. Response size checks cover compressed and decompressed bytes. Timeouts cover DNS, connection and body reads. No environment proxy or private-network bypass is implied.

HTML parsing uses Readability and Turndown without executing JavaScript. Embedded Next.js JSON can provide text before a render is attempted; this isn't a full React Flight decoder. `render: "never"` disables browser fallback, `always` requests it explicitly, and `auto` tries it for a nearly empty HTML extraction.

Chromium rendering requires **Linux**, **bubblewrap**, a **system Chromium**, and working unprivileged/nested user namespaces. It fails closed when these aren't available. It never downloads Chromium or falls back to `--no-sandbox`. The browser runs in a fresh filesystem/network namespace without home directories, personal cookies or host sockets. All page HTTP requests are fulfilled by the parent's checked HTTP client. Native networking, WebSockets, service workers, downloads and permissions aren't available; only GET/HEAD requests are allowed. Requests and aggregate bytes are capped. Sites requiring authenticated sessions, POST requests or persistent connections may not render. `WEB_ACCESS_CHROMIUM_PATH` can select a trusted system binary under `/usr` or `/opt`.

PDF parsing uses `unpdf` in a terminated worker thread, with page/text limits and cancellation. It extracts existing text only. Scanned PDFs without text report that OCR isn't supported; tables and multi-column layouts may lose structure. No PDF is uploaded to Gemini or another extraction service.

GitHub root URLs clone **public repositories only**, shallowly, into session-owned temporary directories. Git configuration, credential helpers, hooks, filters and submodules aren't inherited or executed. The GitHub address is checked and pinned using Git's `http.curloptResolve` (Git 2.37+); redirects are disabled. A sampled disk guard bounds clone growth, though transient overshoot between checks is possible. Declared checkout bytes are checked before checkout. There are at most four clones per session; normal shutdown removes them. An abrupt process kill can leave temporary directories under the cache's `repos` subdirectory, which may be removed manually. Repository content is untrusted. PR/issue URLs use normal HTML extraction; use `gh` for specialized metadata or private repositories.

Video frames require `ffmpeg` and `ffprobe`. Local video files are snapshotted without following symlinks, capped at 500 MiB, and decoded with a restricted format/protocol allowlist. Frames are resized to fit 1280×720 and bounded to 12 images / 12 MiB total. Temporary input/frame files are removed after extraction. Video parsing is not an OS-level codec sandbox; keep ffmpeg updated. No audio is extracted. YouTube additionally requires Linux, bubblewrap, system Python3 and a recent system `yt-dlp`. Metadata resolution runs in a network namespace with a loopback-to-Unix-socket bridge to a DNS-pinned, domain-restricted HTTPS CONNECT proxy. Only direct MP4 streams from Googlevideo are downloaded by the checked parent client, capped at 100 MiB; playlists, live streams, manifests and redirects aren't accepted. Signature solving can use a system Node inside the namespace, with yt-dlp's EJS component installed locally; plugin discovery and remote component downloads stay disabled. Some videos require unsupported authentication or stream formats and will fail explicitly. Missing isolation dependencies never enable unrestricted networking.

## Verification

```bash
npm run check --workspace @yteruel31/pi-web-access
npm run build --workspace @yteruel31/pi-web-access
npm run pack:dry --workspace @yteruel31/pi-web-access
npm run smoke:extensions
```

Provider protocol tests are mocked and do not spend API credits. Tests cover absent/incompatible browsers and bwrap, unsupported OS, namespace/AppArmor hints and commented-profile rejection, sanitized errors, synthetic JS verification, cancellation/late-launch cleanup, classic HTTP without a browser, Diagnostic loading/success/failure/refresh states, masked entry, wizard navigation/cancel/confirmation, constrained modal dimensions and scrolling, credential storage selection, permissions/symlinks, concurrent settings preservation, sanitized failures, provider payloads, citations, lifecycle/recovery/cancellation, non-overwriting Markdown output, cache bounds, SSRF, extraction and Pi registration. Real credential smoke tests and live Linux browser/YouTube isolation tests need separate approval and installed dependencies.

Protocol references checked during implementation:

- [Gemini Deep Research](https://ai.google.dev/gemini-api/docs/deep-research)
- [Gemini Interactions OpenAPI](https://ai.google.dev/static/api/interactions.openapi.json)
- [OpenAI Deep Research](https://developers.openai.com/api/docs/guides/deep-research)
- [OpenAI Background mode](https://developers.openai.com/api/docs/guides/background)

<!-- AI generated -->
