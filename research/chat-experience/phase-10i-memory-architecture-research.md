# Phase 10I Memory Architecture Research

Date: 2026-05-01

## 1. Executive recommendation

Phantom should treat memory as three product surfaces, not one.

1. User-visible memory: editable or inspectable knowledge the operator can understand and correct. This is already split between `.claude` markdown files in the Memory files dashboard, Qdrant memories in Memory explorer, and read-only `phantom-config/memory/agent-notes.md`.
2. Agent-visible operational memory: compact, safe continuity facts and targeted retrieval tools that help the agent resume work after Murph compaction. This should live in Phantom, not Murph, because it is based on Phantom chat sessions, tool cards, pages, artifacts, and auth semantics.
3. Hidden runtime records: raw chat stream events, tool payloads, attachments, costs, and transcript storage. These should remain durable and searchable by bounded tools, but not rendered as "memory" and not dumped into prompts.

The next builder slice should not create a new database. It should extend the existing Phantom reflective in-process MCP server with a chat-history retrieval tool backed by existing SQLite tables, then inject the current chat session id into the existing Murph `transformContext` continuity block. The agent gets a small prompt hint plus a tool it can call only when it needs older compacted details. The user gets no new confusing memory object yet.

## 2. Current state inventory

### Prompt assembly and prompt memory

- `/Users/truffle/work/phantom-murph-hardening/src/agent/prompt-assembler.ts`, `assemblePrompt(...)`
  builds the system prompt in this order: identity, environment, security, role prompt, onboarding, evolved config, agent memory instructions, general instructions, working memory, Qdrant memory context, and optional chat runtime context.

- `/Users/truffle/work/phantom-murph-hardening/src/agent/prompt-blocks/agent-memory-instructions.ts`, `buildAgentMemoryInstructions()`
  teaches the main agent to append durable learnings to `phantom-config/memory/agent-notes.md` with Write or Edit. The file contents are deliberately not injected into the prompt. Tests in `/Users/truffle/work/phantom-murph-hardening/src/agent/__tests__/prompt-assembler.test.ts` assert the path is present, append-only rules are present, and file contents are not injected.

- `/Users/truffle/work/phantom-murph-hardening/src/agent/prompt-blocks/working-memory.ts`, `buildWorkingMemory(dataDir)`
  reads `data/working-memory.md` and injects it under `# Working Memory`. It truncates after 75 lines and asks the agent to compact the file. `/Users/truffle/work/phantom-murph-hardening/src/index.ts` seeds this file on startup if it is missing.

- `/Users/truffle/work/phantom-murph-hardening/src/agent/prompt-blocks/instructions.ts`, `buildInstructions()`
  also tells the agent to read and update `data/working-memory.md` at the start of every new conversation. In practice, the prompt assembler already injects the file contents, so this is both an instruction and a loaded prompt surface.

- `/Users/truffle/work/phantom-murph-hardening/src/memory/context-builder.ts`, `MemoryContextBuilder.build(query)`
  queries Qdrant-backed episodes, facts, and procedures and formats the results under `# Your Memory`. Facts get first priority, episodes are filtered through `shouldIncludeEpisodeInContext(...)`, and procedures are included if budget allows. Tests in `/Users/truffle/work/phantom-murph-hardening/src/memory/__tests__/context-builder.test.ts` assert readiness checks, formatting, stale episode filtering, budget behavior, and error tolerance.

### Murph chat continuity

- `/Users/truffle/work/phantom-murph-hardening/src/chat/continuity-context.ts`, `buildChatContinuityContext(...)`
  scans the durable chat stream log, currently up to 5000 recent events, and extracts page artifacts from `phantom_create_page` and `phantom_preview_page`, plus recent `session.compact_boundary` checkpoints. It excludes `/ui/login` auth links and limits output to 8 artifacts and 3 compaction checkpoints. Tests in `/Users/truffle/work/phantom-murph-hardening/src/chat/__tests__/continuity-context.test.ts` assert page extraction, login exclusion, compaction reporting, and tail-limited scan behavior.

- `/Users/truffle/work/phantom-murph-hardening/src/chat/writer.ts`, `ChatSessionWriter.run(...)`
  persists the user message, appends live stream events to `ChatEventLog`, builds `sessionContext` through `buildChatContinuityContext(...)`, and passes it into `AgentRuntime.runForChat(...)`. Tests in `/Users/truffle/work/phantom-murph-hardening/src/chat/__tests__/writer.test.ts` assert page continuity reaches the runtime.

- `/Users/truffle/work/phantom-murph-hardening/src/agent/chat-query.ts`, `executeChatQuery(...)`
  sends `sessionContext` differently by runtime. Anthropic fallback appends it inside the system prompt as `# Current Chat Context`. Murph uses `createMurphContextTransform(...)` so the context becomes a Pi-compatible user message outside the system prompt.

- `/Users/truffle/work/phantom-murph-hardening/src/agent/murph-context.ts`, `createMurphContextTransform(...)`
  injects a single `<phantom_chat_context>` message before the latest user message and removes stale Phantom context messages so they do not accumulate. Tests in `/Users/truffle/work/phantom-murph-hardening/src/agent/__tests__/murph-context.test.ts` and `/Users/truffle/work/phantom-murph-hardening/src/agent/__tests__/agent-sdk-boundary-callers.test.ts` assert placement, replacement, and absence from the system prompt on Murph.

### Agent tools for memory and history

- `/Users/truffle/work/phantom-murph-hardening/src/agent/in-process-reflective-tools.ts`, `createReflectiveToolServer(memory, db)`
  exposes in-process MCP tools to the agent: `phantom_memory_search` and `phantom_list_sessions`. These are available inside Agent SDK queries through `/Users/truffle/work/phantom-murph-hardening/src/index.ts`, where `runtime.setMcpServerFactories(...)` registers `"phantom-reflective"` per query. `phantom_memory_search` returns Qdrant episodes and facts, optionally time-bounded. `phantom_list_sessions` returns rows from the runtime `sessions` table.

- `/Users/truffle/work/phantom-murph-hardening/src/mcp/tools-universal.ts`, `registerUniversalTools(...)`
  exposes external MCP equivalents: `phantom_history`, `phantom_list_sessions`, `phantom_memory_query`, and `phantom_memory_search`. Tests in `/Users/truffle/work/phantom-murph-hardening/src/mcp/__tests__/tools-universal.test.ts` assert alias registration, session filtering by channel and days, memory search recency filtering, and clean unavailable-memory errors.

Important gap: neither the in-process reflective tools nor the external MCP tools expose the current web chat transcript by `chat_sessions.id`. They list runtime `sessions` rows and search Qdrant memories, but they do not let the agent retrieve earlier chat messages or safe tool timeline details after compaction.

### User-visible memory UI and APIs

- `/Users/truffle/work/phantom-murph-hardening/src/ui/api/memory-files.ts`, `handleMemoryFilesApi(...)`
  provides cookie-gated CRUD for markdown files under the user-scope `.claude` root and read-only access to allow-listed `phantom-config/memory` files. Writes are audited through `recordMemoryFileEdit(...)`.

- `/Users/truffle/work/phantom-murph-hardening/src/memory-files/paths.ts`
  validates memory file paths. It allows markdown only, blocks hidden files, traversal, `skills/`, `plugins/`, `agents/`, `settings.json`, and `settings.local.json`. It explicitly allow-lists `phantom-config/memory/agent-notes.md` as a read-only virtual path.

- `/Users/truffle/work/phantom-murph-hardening/src/memory-files/storage.ts`
  implements list, read, atomic write, and delete. It limits file content to 256 KB and surfaces `phantom-config/memory/agent-notes.md` as read-only with description "Agent notes (the agent's own learnings, append-only)".

- `/Users/truffle/work/phantom-murph-hardening/public/dashboard/memory-files.js`
  renders the Memory files tab. It describes `.claude` markdown as persistent memory, lets the operator create, edit, save, and delete normal memory files, and renders read-only files as agent-maintained memory.

- `/Users/truffle/work/phantom-murph-hardening/src/ui/api/memory.ts`, `handleMemoryApi(...)`
  provides cookie-gated Memory explorer APIs over Qdrant episodes, facts, and procedures. It supports health, list, search, detail, and delete. `/Users/truffle/work/phantom-murph-hardening/public/dashboard/memory.js` renders this as "Memory explorer" with copy-as-JSON and delete controls.

Tests in `/Users/truffle/work/phantom-murph-hardening/src/ui/api/__tests__/memory-files.test.ts`, `/Users/truffle/work/phantom-murph-hardening/src/memory-files/__tests__/storage.test.ts`, and `/Users/truffle/work/phantom-murph-hardening/src/ui/api/__tests__/memory.test.ts` define the intended user-visible behavior.

### Hidden durable transcript and event storage

- `/Users/truffle/work/phantom-murph-hardening/src/db/schema.ts`
  defines `chat_sessions`, `chat_messages`, `chat_stream_events`, and `chat_run_timelines`. These are durable across process restarts and are the right storage base for operational continuity.

- `/Users/truffle/work/phantom-murph-hardening/src/chat/message-store.ts`, `ChatMessageStore`
  stores committed user and assistant transcript rows. User messages store prompt text and attachment metadata, not raw attachment bytes.

- `/Users/truffle/work/phantom-murph-hardening/src/chat/event-log.ts`, `ChatEventLog`
  stores the event stream, including tool calls, tool inputs, outputs, compaction status, errors, and terminal events. This is operational evidence, not user memory.

- `/Users/truffle/work/phantom-murph-hardening/src/chat/run-timeline.ts`
  stores durable run summaries for UI replay. This is a UI timeline surface, not a long-term memory surface.

## 3. Proposed memory taxonomy

### For-user memory

For-user memory means editable, inspectable, human-trustable knowledge. It should render in the dashboard and be safe for the operator to correct.

Primary user memory surfaces:

- Memory files: `.claude/**/*.md` through `/ui/api/memory-files` and `public/dashboard/memory-files.js`.
- Agent notes: `phantom-config/memory/agent-notes.md`, read-only in the dashboard because the agent appends to it directly.
- Memory explorer: Qdrant episodes, facts, and procedures through `/ui/api/memory` and `public/dashboard/memory.js`, with delete as the correction mechanism.
- Evolved config files such as `user-profile.md`, `domain-knowledge.md`, and strategy files, managed by the reflection subprocess and visible elsewhere in the dashboard.

Product rule: if a user can reasonably ask "why did Phantom remember this about me?", it belongs in a user-visible memory surface or should be traceable to one.

### For-agent memory

For-agent memory means operational continuity that helps Phantom do the next step without asking the user to repeat context. It is not necessarily a user-facing belief. It should be compact, retrievable, scoped, and auditable.

It should include:

- Current chat session id.
- Recent committed user and assistant messages.
- Safe run timeline summaries.
- Page and artifact references.
- Compaction checkpoints.
- Tool call names, statuses, paths, URLs, sizes, and short previews.
- Retrieval handles for older transcript slices.

It should not include:

- Raw tool full outputs by default.
- Raw screenshots, base64, binary blobs, or full HTML dumps.
- Credential values, auth tokens, magic-link secrets, or `.env` contents.
- Provider private thinking or chain-of-thought.
- Hidden internal tool protocol details unless explicitly needed for recovery.

Where it should live: in Phantom's SQLite chat tables and in Phantom-owned in-process MCP tools. Murph should remain generic and only supply the transform and compaction seam.

### Hidden runtime records

Hidden runtime records are durable evidence and replay data. They can feed tools and summaries, but they should not be labeled as memory in the UI.

Examples:

- `chat_stream_events.payload_json`
- full tool inputs and outputs
- attachment storage paths and hashes
- `chat_run_timelines.summary_json`
- SDK session ids
- token counts and cost rows

Product rule: hidden runtime records can be used by the agent for continuity through safe extractors, but users should see curated views, not raw internal logs.

## 4. Proposed agent prompt and tool contract

The prompt should stay small. The agent should receive:

1. Normal system prompt memory from `assemblePrompt(...)`.
2. Qdrant recall from `MemoryContextBuilder.build(...)`, bounded by memory config.
3. Current chat continuity from `buildChatContinuityContext(...)`, injected by `createMurphContextTransform(...)` on Murph.
4. A new line in the chat continuity block containing the current `chat_sessions.id`.
5. A new in-process MCP tool for bounded transcript recovery.

Recommended new tool:

`phantom_chat_history`

Input:

- `session_id`: current chat session id, required.
- `query`: optional search text.
- `limit`: default 10, max 50.
- `before_seq`: optional transcript cursor.
- `include_tool_events`: optional, default false.

Default output:

- session metadata from `chat_sessions`
- committed `chat_messages` rows as role, seq, created_at, text excerpt, attachment metadata summary, token and cost metadata
- page artifacts and compaction checkpoints from `buildChatContinuityContext(...)` or a shared parser extracted from it

When `include_tool_events` is true:

- tool call id, tool name, status, stream seq, short input summary, short output preview
- never full output by default
- never raw base64
- never login magic links

Prompt language should say: "If a needed detail is missing after compaction, call `phantom_chat_history` with the current chat session id. Do not ask the user to repeat context until that lookup fails."

This is better than injecting more transcript into every prompt. It preserves post-compaction continuity while keeping prompt size bounded and putting sensitive records behind explicit retrieval.

## 5. Proposed user-visible UI and API contract

No new user-visible "for-agent memory" UI should ship in the smallest slice. The existing user-facing contract should stay:

- Memory files are editable user-authored markdown, except read-only surfaced agent notes.
- Memory explorer shows Qdrant memories and lets users inspect, copy, search, and delete them.
- Chat timeline shows work done in a session, including tool cards and artifacts.

Later, the right user-visible addition is not a new memory tab. It is a session-level "Context used" or "Recovered context" affordance in chat that shows when Phantom used compacted context or `phantom_chat_history`, with safe high-level rows such as:

- "Recovered earlier page artifact: /ui/profile.html"
- "Looked up 6 earlier messages in this chat"
- "Used Qdrant fact: user prefers PRs over direct pushes"

The UI should not show raw hidden tool output or provider private reasoning. If a user wants to inspect raw transcript, that should be an advanced export or admin-debug surface with redaction, not the default memory UI.

## 6. Risks and privacy boundaries

Key risks:

- Prompt bloat: adding full transcript snippets to `buildChatContinuityContext(...)` would grow every turn. Prefer a retrieval tool.
- Sensitive leakage: `chat_stream_events` can contain tool input/output, page HTML, screenshots, file paths, auth links, and error details. Tool output must redact or omit unsafe fields.
- User confusion: calling operational transcript recovery "memory" will make users think Phantom believes those details forever. Keep operational continuity separate from user memory.
- Self-reinforcement: injecting `agent-notes.md` on every run would make the agent treat its own append log as canonical. Existing tests correctly prevent this.
- Cloud durability: SQLite chat tables are durable across process restarts on the VM today. Future cloud must preserve the same database or migrate these records to managed durable storage before relying on the tool.
- Access control: in-process tools are agent-visible. External MCP tools need existing bearer scopes and should not gain raw chat-history access by default.

Hard boundaries:

- Do not expose raw chain-of-thought or provider private thinking.
- Do not store raw base64, credentials, or unredacted full tool outputs in user memory.
- Do not show `phantom_generate_login` magic links as artifacts.
- Do not let the user-editable memory file API write into `phantom-config/memory/agent-notes.md`.
- Do not move Phantom chat history retrieval into Murph. Murph should stay a generic runtime.

## 7. Smallest next builder slice

Build a Phantom-only "bounded current chat history retrieval" slice.

Likely files touched:

- `/Users/truffle/work/phantom-murph-hardening/src/chat/continuity-context.ts`
  include the current chat session id in the rendered continuity context and extract shared safe artifact parsing helpers if useful.

- `/Users/truffle/work/phantom-murph-hardening/src/agent/in-process-reflective-tools.ts`
  add `phantom_chat_history` backed by `chat_sessions`, `chat_messages`, and optionally `chat_stream_events`. Return bounded excerpts and safe tool summaries. Redact `/ui/login` URLs, token-like values, and base64-looking blocks.

- `/Users/truffle/work/phantom-murph-hardening/src/agent/prompt-assembler.ts` or `/Users/truffle/work/phantom-murph-hardening/src/agent/prompt-blocks/instructions.ts`
  add one short instruction telling the agent to use `phantom_chat_history` before asking the user to repeat compacted details. Keep it under about 80 words.

- `/Users/truffle/work/phantom-murph-hardening/src/chat/writer.ts`
  likely no behavior change beyond receiving the updated continuity context. Touch only if the tool needs additional session metadata.

Tests required:

- Add tests in `/Users/truffle/work/phantom-murph-hardening/src/chat/__tests__/continuity-context.test.ts` proving the context includes the current chat session id and still excludes auth links.
- Add tests in `/Users/truffle/work/phantom-murph-hardening/src/agent/__tests__/murph-context.test.ts` or `/Users/truffle/work/phantom-murph-hardening/src/agent/__tests__/agent-sdk-boundary-callers.test.ts` proving the session id reaches Murph through `transformContext`, not the system prompt.
- Add tests for `phantom_chat_history` in a new or existing in-process reflective tools test, with cases for message retrieval, query filtering, limit enforcement, safe tool summaries, base64 elision, and magic-link redaction.
- Keep existing memory-files tests unchanged, especially read-only `agent-notes.md`.
- Run focused tests for chat continuity, Murph context, agent SDK boundary callers, in-process reflective tools, memory-files, and MCP universal tools, then the normal `bun test`, `bun run typecheck`, and `bun run lint` gate.

Acceptance criteria:

- After Murph compaction, the prompt contains only compact Phantom context plus a current chat session id.
- The agent can call `phantom_chat_history` to recover bounded prior details from the same chat.
- The tool never returns raw base64, credentials, login magic links, or full unbounded tool outputs.
- No user-visible memory UI changes are required for this slice.
- Murph remains generic. All Phantom chat-history semantics stay in Phantom.
