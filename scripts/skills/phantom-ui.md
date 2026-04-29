---
name: phantom-ui
description: Phantom visual design system and component vocabulary
when_to_use: Use when creating or updating a page served at /ui/<path>. Examples. "make a dashboard", "create a report page", "design a landing", "show me a cost chart".
allowed-tools: Read, Glob
---

# Phantom UI skill

You are authoring a page in Phantom's operator dashboard surface. The pages you create are served at `/ui/<path>` behind magic-link cookie auth. This skill is your reference material for the design system. It is not rails. You are free to write any HTML you want. This skill tells you what the house style looks like when you feel like reaching for it.

## Direction in one sentence

Warm cream light theme paired with a warm deep dark theme, Instrument Serif display face over Inter Variable UI text, indigo accent at `#4850c4` light and `#7078e0` dark, 1px borders everywhere, zero default shadow chrome, tabular numerics on every number, pill-shaped primary buttons, 100 to 150 millisecond transitions, `color-mix(in oklab)` for every tint.

The aesthetic is informed by the Anthropic console and API docs. Warm cream background, serif headings, restraint in chrome. Linear and Raycast for the dark theme near-black proportions. Stripe for tabular numerics discipline. Not a copy of any of them; a distinctive Phantom synthesis.

## Use the base template

`public/_base.html` declares all the tokens and all the vocabulary classes. When you call `phantom_create_page` with `title` and `content`, the content is wrapped in the base template and inherits everything for free. You do not need to redeclare any CSS in the content. Just use the class names.

When you need a full custom `<head>` (for page-specific CDN scripts like ECharts or Mermaid), use `phantom_create_page` with the `html` parameter and copy the structure from `_base.html` so you inherit the tokens and the vocabulary.

## The reference style guide

`/ui/_components.html` is the living style guide. Every vocabulary pattern renders there in both themes with a label. When you want to remember what a pattern looks like, open that file with Read. It is the closest thing to a Figma library file you have.

## Vocabulary, grouped by category

### Layout primitives

- `phantom-page` - max-width 1240px container with 24px vertical padding, 32px horizontal padding
- `phantom-page-narrow` - max-width 760px variant for editorial and single-column pages
- `phantom-section` - adds 40px margin-bottom for vertical rhythm
- `phantom-row` - horizontal flex with 16px gap, centered items
- `phantom-col` - vertical flex with 16px gap
- `phantom-grid-stats` - 4-column responsive grid that collapses to 2 on mobile
- `phantom-grid-main-side` - 2/3 + 1/3 grid that collapses to 1 column on mobile
- `phantom-grid-cards` - auto-fill grid with 280px minimum card width
- `phantom-divider` - 1px horizontal rule in the base-300 color

### Typography

- `phantom-display` - serif hero heading, 44-60px clamp, weight 400, use `<em>` for italic
- `phantom-h1` - serif 32px weight 500 for page titles
- `phantom-h2` - serif 22px weight 500 for section titles
- `phantom-h3` - sans 14px weight 600 for card labels
- `phantom-eyebrow` - uppercase tracked 11px label above titles
- `phantom-lead` - 16-17px body for opening paragraphs
- `phantom-body` - standard 14px body text
- `phantom-muted` - color modifier for secondary text
- `phantom-mono` - JetBrains Mono 12px with tabular numerics
- `phantom-meta` - 12px metadata like timestamps

### Cards

- `phantom-card` - 1px border, 14px radius, 20px padding, no default shadow
- `phantom-card-compact` - 10px radius, 12px padding for denser contexts
- `phantom-card-hover` - adds subtle hover shadow and cursor pointer

### Stats

- `phantom-stat` - vertical flex container
- `phantom-stat-label` - uppercase tracked 11px label
- `phantom-stat-value` - 28px weight 500 tabular-nums number
- `phantom-stat-value-serif` - optional serif variant for editorial stats
- `phantom-stat-trend-up` / `-down` / `-flat` - colored trend indicator below the value

### Tables

- `phantom-table` - uppercase header cells, tabular numerics in every body cell, row hover with indigo tint
- `phantom-table-compact` - denser variant with smaller padding and 12px body

### Badges and chips

- `phantom-badge` - pill chip, default neutral
- `phantom-badge-primary` / `-success` / `-warning` / `-error` / `-info` / `-neutral` - color variants
- `phantom-chip` - togglable filter chip with `aria-pressed` support

### Status indicators

- `phantom-dot` - 6px status dot
- `phantom-dot-success` / `-warning` / `-error` / `-info` - color variants
- `phantom-dot-live` - pulsing green dot for live indicators

### Timeline

- `phantom-timeline` - vertical timeline with left rule and ring markers
- `phantom-timeline-item` - single entry, includes time/title/body subelements

### Empty states

- `phantom-empty` - centered empty state with dashed border
- `phantom-empty-icon` / `-title` / `-body` - structured subelements

### Forms

- `phantom-form-row` - label + input pair with consistent spacing
- `phantom-label` - 12px weight 500 label text
- `phantom-input` / `phantom-textarea` / `phantom-select` - 10px radius fields with 3px focus ring
- `phantom-button` - pill primary button, dark on cream light, indigo dark
- `phantom-button-primary` - indigo accent variant
- `phantom-button-ghost` - outlined secondary variant
- `phantom-button-danger` - red destructive variant
- `phantom-button-sm` - compact variant

### Alerts and toasts

- `phantom-alert` - inline banner with 1px border and subtle tinted background
- `phantom-alert-success` / `-error` / `-warning` / `-info` - color variants
- `phantom-toast` - floating notification with shadow

### Modals and sheets

- `phantom-modal-backdrop` - fixed backdrop with blur
- `phantom-modal` - centered modal with 20px radius
- `phantom-sheet` - side-slide panel

### Navigation

- `phantom-nav` - top navigation bar with sticky and blur
- `phantom-nav-brand` - serif wordmark with logo
- `phantom-nav-item` - nav link with active state via `aria-current`
- `phantom-breadcrumb` - breadcrumb row with separator
- `phantom-tabs` / `phantom-tab` - segmented control tabs

### Chat (Project 4 seeds)

- `phantom-chat-bubble-user` - right-aligned user message in primary color
- `phantom-chat-bubble-assistant` - left-aligned assistant message
- `phantom-chat-tool-card` - monospace inline tool call indicator
- `phantom-chat-thinking` - animated typing indicator

### Charts

- `phantom-chart` - ECharts container, 320px default height
- `phantom-chart-sm` - 160px height variant
- `phantom-chart-lg` - 480px height variant
- Always use `window.phantomChart(el, option)` to init ECharts. The helper reads the current theme, registers the chart, adds a resize handler, and watches the theme attribute so the chart redraws on toggle. Reduces chart boilerplate from ~20 lines to 3.

## Token reference

Every semantic token is declared in `_base.html`. You reference by name.

Colors (both themes):
- `--color-base-100` - page background (cream in light, warm near-black in dark)
- `--color-base-200` - card surface
- `--color-base-300` - border
- `--color-base-content` - primary text
- `--color-primary` - indigo accent
- `--color-success` / `--color-warning` / `--color-error` / `--color-info` - status accents

Spacing:
- `--space-1` = 4px, `--space-2` = 8px, `--space-3` = 12px, `--space-4` = 16px, `--space-5` = 20px, `--space-6` = 24px, `--space-8` = 32px, `--space-10` = 40px, `--space-12` = 48px, `--space-16` = 64px

Radii:
- `--radius-sm` = 8px (chips)
- `--radius-md` = 10px (inputs, buttons in rectangular mode)
- `--radius-lg` = 14px (cards)
- `--radius-xl` = 20px (modals)
- `--radius-pill` = 9999px (primary buttons, badges, chips)

Motion:
- `--motion-fast` = 100ms (buttons, nav, hover)
- `--motion-base` = 150ms (card borders, inputs)
- `--motion-slow` = 300ms (layout transitions, modal reveal)
- `--ease-out` = `cubic-bezier(0.25, 0.46, 0.45, 0.94)`

## Taste calibration

Five things to hold in mind when you author a page:

**One.** Make every dashboard as dense and crisp as Linear, as restrained as Anthropic console, as typographically clean as Notion, and as numerically tabular as Stripe. Never as cluttered as Jira, never as loud as Vercel marketing, never as branded as anyone trying to sell a product. You are building an operator tool for the person who owns the agent. The aesthetic is serious and quiet.

**Two.** When you use a stat card, pair it with a trend indicator underneath. Bare numbers are prototype energy. `phantom-stat-value` plus `phantom-stat-trend-up` with "+22% 7d" is professional.

**Three.** When you write a number anywhere, tabular numerics unless prose context demands otherwise. A table column of costs where `$2.34` and `$19.02` do not vertically align is immediately noticeable and immediately cheap-looking. `font-variant-numeric: tabular-nums` is already on the body default; keep it there.

**Four.** When you use a chart, use the helper `window.phantomChart(el, option)` instead of raw `echarts.init` plus manual theme wiring. The helper gives you theme-aware redraw for free. Also, keep charts below 1-2 per page. Three charts on one page is a dashboard generator, not a considered surface.

**Five.** When in doubt, open `/ui/_components.html` with Read and look at how the pattern you need is already rendered. The style guide is your memory. Do not freehand a chip when `phantom-chip` exists. Do not freehand a table when `phantom-table` exists. Do freehand a unique layout when the page calls for one; raise the floor, touch the ceiling.

## Always validate

After `phantom_create_page` returns, always call `phantom_preview_page` with the same path. Review the screenshot. Read the JSON metadata block. If `console.errors > 0` or `network.failedRequests.length > 0`, fix the HTML and re-preview until both are zero. Only then report the page to the user.

The acceptance bar for any page you ship is: zero console errors, zero failed network requests, the theme toggle works in both directions, the layout does not collapse at 900px, and the surface reads at the quality of the reference examples in `/ui/_examples/` (once the builder publishes those).

## Non-negotiables

- No em dashes in body text. Use commas, periods, or regular hyphens.
- No emojis in body text.
- No hardcoded hex colors. Always `var(--color-*)`.
- No `bg-primary/10` slash opacity in `text/tailwindcss` blocks (Tailwind v4 Browser CDN parser bug). Use `color-mix(in oklab, var(--color-primary) 10%, transparent)` instead.
- No inline styles except for one-off micro-adjustments that would not make a good vocabulary class.
- No `<script>` tags inside `<main>`. CDN scripts in `<head>`, app scripts at the bottom of `<body>`.
- No `transition: all`. Always name the properties.
- No shadow on default cards. Only `phantom-card-hover` gets a hover shadow.
