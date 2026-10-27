# Changelog

## v0.1.2 — 2026-10-27

- Correct the upgrade guide: JSON export is available for reference, but JSON restore/import is not implemented. Retain a stopped-backend SQLite backup or a stable BRANCH_CANVAS_DB path.
- Supersedes the brief v0.1.1 release without changing its published files or checksums. Rights, features and database format are unchanged.


## v0.1.1 — 2026-10-27

- New downloadable package includes the personal-study/noncommercial license, commercial inquiry terms, contribution agreement and preserved historical notices.
- Free personal study, noncommercial experiments and collaborative improvements; commercial use needs separate written authorization.
- Runtime, plugin metadata and launcher versions are aligned. Existing tree behavior and data format are unchanged.
- Older release downloads are withdrawn from the public release list without rewriting their files, Git tags or earlier permissions. Back up exported trees before upgrading.

## v0.1.0 — 2026-10-27

- First downloadable Windows plugin package, with bundled UI/backend and license notices.
- Automatically reads completed turns from the current local Codex chat and adds new turns without duplicating trees.
- Continuous follow-ups reuse the current native thread; historical alternatives create a fork.
- Parent/child collapse, search, zoom, wheel pan, return to root and fit-to-tree controls.
- Native chat navigation, optional Markdown preview, persistent drafts and JSON export.
- Forty automated checks pass. Original-desktop checks confirm current-chat synchronization, root navigation and physical wheel panning with unchanged zoom/selection; physical wheel input was supplied by the user.

The package requires Node.js 24+, an authenticated compatible Codex CLI, and a desktop client supporting local plugins and the right-side panel. It does not include Node.js or Codex, and it does not patch the desktop client.
