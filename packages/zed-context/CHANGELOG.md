# Changelog

## 0.2.0

- Add a Zed language-server bridge that tracks selections automatically without a shortcut.
- Capture unsaved synchronized buffer content with UTF-16-safe LSP range handling.
- Clear pending context when the selection collapses and ignore captures from stopped bridge processes.
- Keep the task helper as an explicit fallback.

## 0.1.0

- Add remote-safe Zed selection capture through a task helper.
- Show the explicit selected-line count in Pi's footer.
- Attach each captured selection to the next Pi prompt once.
