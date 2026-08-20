# Configuration

## Location and loading

The current schema is version 5. The primary user configuration is:

`<Pi agent directory>/extensions/yteruel31-pi-ask.json`

Pi's official `getAgentDir()` resolves the agent directory (normally `~/.pi/agent`, including Pi's supported agent-directory override). For compatibility, when the primary file is absent the package reads the first existing legacy file below, without moving, rewriting, deleting, or backing it up:

1. `<agent-dir>/yteruel31-pi-ask.json`
2. `<agent-dir>/extensions/eko24ive-pi-ask.json`
3. `<agent-dir>/eko24ive-pi-ask.json`

A missing configuration is created at the primary path on first ask use. If creation fails, the flow continues with in-memory defaults and immediately reports the exact path. Invalid JSON, unreadable files, invalid v5 fields, and unsupported future versions leave disk untouched and use defaults for that session. Versions 1-4 are migrated in memory only.

## Complete v5 defaults

```json
{
  "schemaVersion": 5,
  "answer": {
    "extractionModels": [
      { "provider": "openai-codex", "id": "gpt-5.4-mini" },
      { "provider": "github-copilot", "id": "gpt-5.4-mini" },
      { "provider": "anthropic", "id": "claude-haiku-4-5" }
    ],
    "extractionTimeoutMs": 30000,
    "extractionRetries": 1
  },
  "behaviour": {
    "autoSubmitWhenAnsweredWithoutNotes": false,
    "confirmDismissWhenDirty": true,
    "doublePressReviewShortcuts": true,
    "presentSingleAsMulti": false,
    "showFooterHints": true
  },
  "keymaps": {
    "global": {
      "dismiss": ["ctrl+c"],
      "settings": ["?"]
    },
    "main": {
      "confirm": ["enter"],
      "cancel": ["esc"],
      "toggle": ["space"],
      "changeQuestionType": ["t"],
      "nextTab": ["tab", "right"],
      "previousTab": ["shift+tab", "left"],
      "nextOption": ["down"],
      "previousOption": ["up"],
      "optionNote": ["n"],
      "questionNote": ["shift+n"]
    },
    "editor": {
      "submit": ["enter"],
      "close": ["esc"],
      "nextTabWhenEmpty": ["tab", "right"],
      "previousTabWhenEmpty": ["shift+tab", "left"],
      "nextOptionWhenEmpty": ["down"],
      "previousOptionWhenEmpty": ["up"]
    },
    "noteEditor": {
      "save": ["enter"],
      "close": ["esc"],
      "nextTabWhenEmpty": ["tab", "right"],
      "previousTabWhenEmpty": ["shift+tab", "left"],
      "nextOptionWhenEmpty": ["down"],
      "previousOptionWhenEmpty": ["up"]
    },
    "settingsModal": {
      "close": ["esc", "ctrl+c", "?"],
      "nextOption": ["down"],
      "previousOption": ["up"],
      "toggle": ["enter", "space"]
    }
  },
  "notifications": {
    "enabled": true,
    "channels": ["bell"]
  }
}
```

`extractionModels` is tried in order, restricted to the current model scope and authenticated models; the current model is a final candidate. `extractionTimeoutMs` must be positive. `extractionRetries` is 0-3 and counts retries after the first attempt.

## Key behavior

Every action above accepts one key string or a non-empty array of aliases. Identifiers use Pi TUI spelling. Accepted aliases are normalized: `control+` → `ctrl+`, `escape` → `esc`, `return` → `enter`, `pageup` → `pageUp`, and `pagedown` → `pageDown`. Modifiers are `ctrl`, `shift`, `alt`, and `super`; letters, digits, punctuation, arrows, navigation keys, and F1-F12 are supported.

Bindings must be unique within a context. Global bindings cannot collide with `main`, `editor`, or `noteEditor`. Invalid keymaps fall back as a whole to default keymaps while valid non-keymap settings remain active.

Fixed, non-configurable behavior:

- `1`-`9` select option rows, or review actions 1-3.
- Numeric review shortcuts require a second press when `doublePressReviewShortcuts` is enabled. Cursor movement does not disarm the pending shortcut; another numeric review shortcut replaces it, and leaving Review clears it.
- `@` file completion remains available in inline editors.
- While autocomplete is visible, Enter accepts the completion and Esc closes autocomplete. They do not submit or close the editor.
- Outside autocomplete, only the configured `editor.submit` or `noteEditor.save` saves text. The configured `close` abandons the current editor draft. Rebinding submit/save away from Enter makes plain Enter inactive as submit/save.
- Empty-editor navigation actions leave the editor and navigate without saving a new draft.

Footer and inline-editor hints are generated from the live bindings, including changes saved while a flow is open.

## Behavior and notifications

- `autoSubmitWhenAnsweredWithoutNotes`: submit on reaching Review when every question has a selected answer and there are no notes.
- `confirmDismissWhenDirty`: require a repeated dismiss/cancel action when answers, notes, custom text, or editor text would be lost.
- `doublePressReviewShortcuts`: arm numeric Review actions before executing them.
- `presentSingleAsMulti`: present future single-select questions as multi-select while retaining requested `type` metadata.
- `showFooterHints`: show concise context-sensitive key hints.

Notification channels run in order and are best effort: `bell`, `osc9`, `osc777`, or `{ "type": "command", "command": "..." }`. Commands receive `ASK_NOTIFY_EVENT`, `ASK_NOTIFY_TITLE`, and `ASK_NOTIFY_MESSAGE`, time out after five seconds, and are terminated on timeout.

## Save, reset, and live semantics

`/ask-settings` opens the settings overlay; `?` opens it from a flow. Toggle saves are atomic and become live immediately in every open component through the config store subscription. A failed save leaves the previous live value in place and reports an error. Reset requires the reset action twice within two seconds, writes the complete defaults to the primary path, and publishes them live.

The settings UI changes behavior and notification toggles. Edit extraction models, channels, or keymaps directly in JSON while preserving unrelated fields. Manual edits are loaded on Pi restart or `/reload`; loading never rewrites the file.
