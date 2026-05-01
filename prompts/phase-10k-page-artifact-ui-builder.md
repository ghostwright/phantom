ultrathink. ultrathink. ultrathink.

You are acting as principal engineer, principal architect, and principal product manager for Phantom's chat experience on Murph.

Context:
- Branch: codex/chat-experience-polish-10j in /Users/truffle/work/phantom-murph-hardening.
- The open upstream PR #113 has been updated to current origin/main and is review-blocked only.
- Phase 10J has already implemented default-collapsed successful tool cards.
- The operator's current priority is best-in-class chat: durable run timeline, richer progress, file/artifact preview, markdown polish, and reliable long-running Murph conversations.
- We must not fake private chain-of-thought. We show only safe progress and existing runtime facts.
- We must not reinvent where Phantom already has primitives.

Relevant current code:
- chat-ui/src/components/assistant-message.tsx renders thinking blocks, tool cards, markdown, and cost metadata.
- chat-ui/src/components/tool-call-card.tsx renders tool inputs and outputs.
- chat-ui/src/lib/chat-types.ts defines ToolCallState.
- src/chat/continuity-context.ts already extracts page artifacts from phantom_create_page and phantom_preview_page tool calls for post-compaction continuity.

Task:
Implement the smallest production-grade artifact UI slice:
1. Add a client-side artifact extractor that derives safe, user-visible created page artifacts from existing ToolCallState data.
2. Reuse the same semantics as src/chat/continuity-context.ts where practical:
   - Recognize phantom_create_page and phantom_preview_page.
   - Prefer output url/publicUrl/pageUrl, then safe URL from text.
   - Use input path/title when available.
   - Include size when available.
   - Exclude /ui/login and magic-login links.
   - Deduplicate by URL or path.
3. Add a compact artifact card/tray in chat-ui that renders under the assistant answer when artifacts exist.
4. Keep this as a UI affordance. Do not add a new MCP tool or Phantom built-in for this slice.
5. Add focused tests for extraction policy.
6. Maintain strict TypeScript. No explicit any, no @ts-ignore, no em dashes, no emojis.
7. Keep files small and components focused.

Acceptance criteria:
- Successful phantom_create_page results produce a visible artifact card with title, path/URL, size when known, Open, and Copy URL actions.
- phantom_generate_login output never becomes a created artifact.
- Relative and absolute /ui/<path> page URLs work; /ui/login does not.
- Duplicate tool frames do not duplicate artifact cards.
- Existing tool card tests and chat store tests remain green.
- Full local gates pass before commit.
- Live verification with Phantom on Murph/OpenAI creates a page and shows the artifact card.

Anti-patterns:
- Do not parse arbitrary secrets into visible cards.
- Do not surface magic links as artifacts.
- Do not create a new server schema before proving the UI affordance.
- Do not bury the final answer under oversized artifact chrome.
- Do not make the card depend on hover-only controls.

Self-review:
After implementation, review the diff for overreach, accessibility, long URLs, mobile fit, and whether this should have reused an existing helper.
