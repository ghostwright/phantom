ultrathink. ultrathink. ultrathink.

You are a principal engineer, principal architect, and principal product
manager at Anthropic, all three at once. You are researching how Phantom should
render agent thinking, tool progress, and long-running activity now that
Phantom runs on Murph, which runs on pi-mono.

Mission:

Find what Pi and Pi-adjacent code already provide for thinking display,
progress display, activity rows, run timelines, and CLI or web rendering. Do
not let Phantom reinvent primitives Pi already gives us. If Pi does not provide
the UI primitive, identify the cleanest Phantom-owned layer.

Required reading, in order:

1. `/Users/truffle/.claude/AGENTS.md`
2. `/Users/truffle/work/murph/QUALITY-BAR.md`
3. `/Users/truffle/work/murph/PROGRESS.md`
4. `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10g-pi-continuity.md`
5. Local pi-mono sources under `/Users/truffle/work/pi-mono`, especially:
   - `packages/agent/src/`
   - `packages/ai/src/types.ts`
   - `packages/ai/src/providers/`
   - `packages/web-ui/README.md`
   - `packages/web-ui/src/`
   - `packages/mom/src/`

External source rules:

- Use primary sources only. GitHub repositories, official docs, package
  READMEs, and source code are acceptable.
- If you need to clone another Pi/Pi Code related repository from pi.dev or
  GitHub, clone it under `/Users/truffle/work/research-clones/`.
- Do not use SEO blogs, scraped docs, or tutorials as evidence.
- Do not copy implementation from any repo into Phantom. This is research and
  architecture guidance only.

Deliverable:

Write `/Users/truffle/work/phantom-murph-hardening/research/chat-experience/phase-10h-pi-thinking-research.md`.

The report must include:

1. Source inventory: exact repos/files read and why they matter.
2. How Pi represents thinking, streaming text, tool calls, tool progress,
   usage, and completion.
3. Whether Pi has a CLI or web rendering pattern we should reuse directly,
   adapt conceptually, or ignore.
4. What Phantom should own versus what Murph/Pi should own.
5. Specific recommendations for Phantom's chat UI, ordered by impact.
6. Risks and anti-patterns, especially places where a custom UI could break
   provider protocol or leak unsafe content.
7. Concrete acceptance criteria for the next builder slice.

Non-goals:

- Do not edit Phantom application code.
- Do not change Murph code.
- Do not commit, push, or open a PR.
- Do not create a broad open-source polish plan. Stay focused on chat
  experience and thinking/progress rendering.

Self-review:

Before finishing, re-read your report and verify every factual claim has a
local file path or primary-source URL. If a claim is an inference, label it as
an inference.
