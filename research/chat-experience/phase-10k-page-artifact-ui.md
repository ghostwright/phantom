# Phase 10K Page Artifact UI

Date: 2026-05-01

## Scope

This slice adds a UI affordance for page artifacts that Phantom already creates
through `phantom_create_page` and `phantom_preview_page`. It does not add a new
MCP tool, built-in tool, or server wire format.

## Why This Belongs In The UI First

The durable continuity layer already extracts page artifacts in
`src/chat/continuity-context.ts` so the agent can recover them after compaction.
That means the runtime already has enough evidence to distinguish a created page
from an authentication link. The chat client can use the same facts to make the
created page visible to the user without asking the agent to repeat itself.

## Policy

- Recognize `phantom_create_page` and `phantom_preview_page`.
- Prefer JSON output fields `url`, `publicUrl`, and `pageUrl`.
- Use input `path` and `title` when present.
- Accept absolute or relative `/ui/<path>` page URLs.
- Exclude `/ui/login` and links with magic login tokens.
- Deduplicate by URL, then path, then tool id.
- Keep `phantom_generate_login` out of artifact extraction.

## Product Shape

Render a compact artifact tray under the assistant answer. Each card should show
the artifact type, title, path or URL, optional size, and two direct actions:
Open and Copy URL. The card is a browser affordance for already-known state, so
it must stay small and should not bury the final answer.

## Future Work

General file previews need a richer server contract for safe path metadata,
preview kind, redaction status, and retention. This page-artifact slice is the
smallest useful step because created pages already return structured JSON.
