---
name: list-plugins
x-phantom-source: built-in
description: List the Claude Code plugins currently enabled for the agent, read straight from settings.json.
when_to_use: Use when the operator asks "what plugins are installed", "which plugins are active", "show plugins", "list plugins", "show me the marketplace state", or any narrow question specifically about the current plugin set.
allowed-tools:
  - Read
context: inline
---

# List plugins

## Goal

Tell the operator which plugins are currently active for this agent, with their marketplace ids and a short description, in under 100 words.

## Steps

### 1. Read settings.json

Use Read on `/home/phantom/.claude/settings.json`. Parse it as JSON.

If the file does not exist, return: "No settings.json yet. The dashboard plugins tab is at /ui/dashboard/#/plugins."

If the file exists but has no `enabledPlugins` field, return: "No plugins enabled yet. Browse the marketplace at /ui/dashboard/#/plugins."

**Success criteria**: you have either a parsed `enabledPlugins` map or a clear empty-state message ready.

### 2. Filter active entries

For each `key: value` in `enabledPlugins`, treat the entry as active when value is `true`, a non-empty array, or a non-empty object. Treat `false` and missing entries as inactive.

**Success criteria**: you have a list of `plugin@marketplace` keys for active plugins only.

### 3. Render the list

Format the response like this:

> You have N plugins enabled:
>
> - **linear** at claude-plugins-official - Linear issue tracking
> - **notion** at claude-plugins-official - Notion workspace
> - **slack** at claude-plugins-official - Slack workspace messages
> - **claude-md-management** at claude-plugins-official - CLAUDE.md maintenance
>
> Manage plugins at /ui/dashboard/#/plugins.

For each row, the descriptor after the dash is a short fallback string based on the plugin name. If you do not recognize a plugin id, use just the marketplace id as the descriptor.

**Success criteria**: the response shows the real current keys, the descriptors are honest (no fabricated descriptions for unknown plugins), and the dashboard URL is included.

## Rules

- Never fabricate a plugin that is not in settings.json.
- Never use em dashes in the response. Regular hyphens are fine.
- Always include the dashboard URL.
- Keep the response under 100 words.
