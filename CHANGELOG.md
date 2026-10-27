# Changelog

## v0.1.0 — 2026-10-27

- First downloadable Windows plugin package, with bundled UI/backend and license notices.
- Automatically reads completed turns from the current local Codex chat and adds new turns without duplicating trees.
- Continuous follow-ups reuse the current native thread; historical alternatives create a fork.
- Parent/child collapse, search, zoom, wheel pan, return to root and fit-to-tree controls.
- Native chat navigation, optional Markdown preview, persistent drafts and JSON export.
- Forty automated checks pass. Original-desktop checks confirm current-chat synchronization, root navigation and physical wheel panning with unchanged zoom/selection; physical wheel input was supplied by the user.

The package requires Node.js 24+, an authenticated compatible Codex CLI, and a desktop client supporting local plugins and the right-side panel. It does not include Node.js or Codex, and it does not patch the desktop client.
