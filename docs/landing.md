# Landing page (`/ui/`)

The landing page is the first surface an operator sees when they open their
agent's URL. It has five sections:

1. **Hero** - 120x120 avatar next to display title and two CTAs: "Talk to
   `<name>`" (`/chat`) and "Open dashboard" (`/ui/dashboard/`). The avatar
   falls back to an Instrument Serif letter if no avatar has been uploaded.
2. **Agent status card** - live badge and stats (agent, version, uptime,
   evolution generation) fed by `/health`. A small "Details" link opens the
   HTML health page.
3. **What can `<name>` do?** - 4 to 6 starter-prompt tiles. Each tile has
   an icon, title, one-line description, and an "Ask now" button that
   deep-links to `/chat?prefill=<urlencoded prompt>`.
4. **Pages `<name>` has created for you** - live list of agent-published
   HTML files in `public/`, sorted by mtime descending, top 10. Boilerplate
   (`index.html`, `dashboard/*`, `_examples/*`, `chat/*`, internal files) is
   filtered out. Empty state deep-links to `/chat` with a prefilled
   "build me a dashboard" prompt.
5. **Quick links** - two tiles: Dashboard and MCP endpoint.

## Customizing the starter prompts

Starter-prompt tiles are editable by the operator (or by the agent itself, which
has Write access to `phantom-config/`).

Create `phantom-config/starter-prompts.yaml`:

```yaml
tiles:
  - icon: chart
    title: Summarize Hacker News
    description: Pull today's top stories and group them by theme.
    prompt: Summarize the top Hacker News stories from the last 24 hours, grouped by theme.
  - icon: git
    title: Monitor my GitHub repos
    description: Check for new issues, PRs, and commits across my starred repos.
    prompt: Check for new issues and PRs on my GitHub repos since yesterday.
```

Rules:

- Up to 6 tiles. More than 6 -> falls back to defaults.
- Each tile requires `icon`, `title`, `description`, `prompt`. Missing any
  field -> falls back to defaults.
- Field caps: `title` 80 chars, `description` 200 chars, `prompt` 2000 chars.
- Unknown top-level keys or unknown tile fields reject the whole file
  (strict schema). Falls back to defaults.
- If the YAML is malformed or the schema rejects, the server logs a warning
  and serves defaults so the landing page never renders blank.

### Icon keys

The frontend maps `icon` to an inline SVG. Supported keys:

- `chart`
- `git`
- `inbox`
- `metrics`
- `alert`
- `calendar`
- `search`
- `globe`

Any other value renders a generic circle.

### Cardinal Rule

Tile titles, descriptions, and prompts are static strings. The "Ask now"
button opens `/chat?prefill=<urlencoded prompt>` and the agent decides what
to do once the user hits Send. There is no server-side classification, no
client-side intent branching. Tiles are invitations; the agent does the
thinking.

## Endpoints

| Endpoint | Method | Auth | Shape |
|----------|--------|------|-------|
| `/ui/api/starter-prompts` | GET | public | `{ tiles: StarterTile[] }` |
| `/ui/api/pages` | GET | public | `{ pages: PageEntry[] }` |

Both endpoints are public because the landing page renders before the operator
authenticates. The content is operator-public copy (starter prompts) or
filenames the agent chose to publish (pages list). No sensitive state flows
through either endpoint.

Response caching:

- Starter prompts: `Cache-Control: private, max-age=60`
- Pages list: `Cache-Control: private, max-age=30`
