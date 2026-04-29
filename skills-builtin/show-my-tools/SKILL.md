---
name: show-my-tools
x-phantom-source: built-in
description: List the agent's current skills, memory files, plugins, subagents, hooks, and a settings summary plus dashboard URLs. The user-facing discovery path for everything the operator can edit.
when_to_use: Use when the user says "what can you do", "what skills do you have", "show me your skills", "what can I edit", "how do I customize you", "what memory files do you have", "what plugins do you have", "what subagents do you have", "what hooks do I have", "show my settings", "what is in your .claude", "where is the dashboard", or any similar discovery question.
allowed-tools:
  - Read
  - Glob
  - Bash
context: inline
---

# Show my tools

## Goal

Give the user a clear, accurate view of what is currently loaded: skills, memory files, and dashboard URLs. Honest about what is on disk, not a marketing list.

## Steps

### 1. List skills

Use Glob to find every `SKILL.md` file under `/home/phantom/.claude/skills/`. For each hit, Read the file and extract the YAML frontmatter's `name` and `description`.

**Success criteria**: you have a list of `(name, description)` pairs for every SKILL.md on disk.

### 2. List memory files

Use Glob to find every `.md` file directly under `/home/phantom/.claude/` (depth up to 3), excluding the `skills/` subtree and the `plugins/` and `agents/` subtrees. Do not read their content; just list the paths and sizes.

**Success criteria**: you have a list of memory file paths with sizes.

### 2.5 List plugins

Use Read to open `/home/phantom/.claude/settings.json`. Parse it as JSON. If there is no `enabledPlugins` field, skip this section. Otherwise, for each `key: value` in `enabledPlugins` where the value is truthy (true, an object, or a non-empty array), record the `plugin-id@marketplace-id` and a short fallback description.

**Success criteria**: you have a list of currently active plugin keys, or you know the list is empty.

### 2.6 List hooks

Use Read to open `/home/phantom/.claude/settings.json`. Parse it as JSON. If there is no `hooks` field, record the count as 0. Otherwise, for each event name in `hooks`, count the total number of hook definitions across all matcher groups for that event. Report the per-event counts and the grand total.

**Success criteria**: you have a number like "4 hooks across PreToolUse (2), PostToolUse (1), UserPromptSubmit (1)", or you know the list is empty.

### 2.7 List subagents

Use Glob to find every `*.md` file directly under `/home/phantom/.claude/agents/`. For each, Read the file and extract the YAML frontmatter's `name` and `description`.

**Success criteria**: you have a list of `(name, description)` pairs, or you know the list is empty.

### 2.8 Read a settings summary

Use Read to open `/home/phantom/.claude/settings.json`. Parse it as JSON. Produce a single-line summary covering: permissions.defaultMode (if set), model (if set), count of `enabledMcpjsonServers`, count of `allowedHttpHookUrls`, whether `autoMemoryEnabled` is true. Skip any field that is not present.

**Success criteria**: one sentence covering the live settings. Do not dump the full JSON.

### 3. Render as seven sections

Format the response like this:

> **Skills.** I have N skills loaded from /home/phantom/.claude/skills/:
>
> - **mirror** - weekly self-audit playback
> - **thread** - the evolution of thinking on a topic
> - **echo** - prior-answer surfacer before I answer substantive questions
> - **overheard** - promises audit from the last 14 days
> - **ritual** - turn latent patterns into scheduled jobs
> - **show-my-tools** - this one
>
> **Memory files.** I have M markdown files under /home/phantom/.claude/:
>
> - **CLAUDE.md** - top-level memory (N bytes)
> - **rules/...** - any rule files you have written
> - **memory/...** - any free-form notes you have written
>
> **Plugins.** I have K plugins enabled from claude-plugins-official:
>
> - **linear** - Linear issue tracking
> - **notion** - Notion workspace knowledge
> - **slack** - Slack workspace messages
> - **claude-md-management** - CLAUDE.md maintenance
>
> **Hooks.** I have H hooks loaded:
>
> - PreToolUse (2): bash precheck, write formatter
> - UserPromptSubmit (1): prompt audit
>
> **Subagents.** I have S subagents defined under /home/phantom/.claude/agents/:
>
> - **research-intern** - fetch a paper and summarize into five bullets
> - **qa-checker** - verify that unit tests ran and passed
>
> **Settings summary.** Permission mode: default. Model: claude-opus-4-7. 3 MCP servers enabled. Auto-memory: on. 2 allowed HTTP hook URLs.
>
> **Dashboard.** You can see and edit all of the above at `<public_url>/ui/dashboard/`. Six tabs are live: skills, memory files, plugins, subagents, hooks, settings. The other tabs (sessions, cost, scheduler, evolution, memory explorer) are coming in later releases.

If `public_url` is not available, use `http://localhost:<port>/ui/dashboard/` or whatever matches the operator's known URL.

**Success criteria**: the response shows the real current counts and names, the dashboard URL is accurate, and the user can act on it immediately.

## Rules

- Never fabricate a skill or memory file that is not actually on disk.
- Never use em dashes in the response. Regular hyphens are fine.
- Always list the dashboard URL.
- If a skill has invalid YAML frontmatter, show it in the list with a note "(parse error)" so the user can fix it.
- Keep the response under 500 words.
