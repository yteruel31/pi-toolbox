# Changelog

## [Unreleased]

### Added
- Current session name display in Pi's interactive status bar.
- Initial `pi-session-title` package.
- Automatic short session titles generated in the background from the first user prompt.
- Non-blocking synchronization with Pi session names, Herdr tabs, tmux windows, and interactive terminal titles.
- `/rename` command for manual or AI-generated titles.
- Deterministic keyword fallback when model-based title generation is unavailable.
- Session restore and new-session Herdr tab reset behavior.
