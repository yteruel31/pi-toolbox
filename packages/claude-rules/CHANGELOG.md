# Changelog

## [Unreleased]

### Fixed
- Skip inaccessible directories while discovering Claude rule files, including Windows paths that return `EPERM`.

### Added
- Initial `pi-claude-rules` package.
- Claude rule discovery from `.claude/rules/`, descendant `*/.claude/rules/`, and `~/.claude/rules/`.
- System prompt injection that tells agents to read relevant Claude rules before changing code.
- Path and prompt relevance matching for rule highlights.
- Temporary status and widget feedback showing loaded and matched rules.
