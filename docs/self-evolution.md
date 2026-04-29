# Self-Evolution

The self-evolution engine is what makes Phantom different from every other AI agent. After every session, Phantom reflects on what happened and rewrites its own configuration to do better next time.

## The Pipeline

Phantom's learning loop has three serialized layers. Every session flows through gate, queue, and reflection.

```
session ends
  -> gate (Haiku) decides fire or skip
  -> if fire: row lands in evolution_queue (SQLite)
  -> cadence drains the queue every 180 minutes, or immediately when depth >= 5
  -> reflection subprocess (Agent SDK) reads the batch, writes or skips or escalates
  -> invariant check validates the outcome byte-by-byte
  -> commit version on success, or restore snapshot on hard fail
```

### Step 1: Conditional Firing Gate

A single Haiku call per session decides whether the session shows durable learning signal. The gate is a pure pass or skip with no tool access and no preset envelope. Failsafes default to fire so transient Haiku failures never drop real signal.

### Step 2: Persistent Queue

Sessions that cross the gate land in `evolution_queue` in SQLite. The queue survives restarts, dedups by `session_key` (so a busy multi-turn conversation enqueues at most one row), and carries a `retry_count` column for bounded retries on invariant failures.

### Step 3: Cadence Drain

The cadence drains the queue on a 180-minute cron plus an immediate demand trigger when depth crosses the configured threshold. A single `inFlight` guard serializes drains so the reflection subprocess runs one at a time.

### Step 4: Reflection Subprocess

The reflection subprocess is the learning loop itself. It spawns the Claude Agent SDK as a sandboxed memory manager with Read, Write, Edit, Glob, and Grep tools against the `phantom-config/` root. The agent reads the batch, reads the current memory files, and decides what to learn, what to compact, when to skip, and which file each bullet belongs in.

The subprocess is Cardinal Rule compliant. TypeScript is plumbing: snapshot, spawn, parse sentinel, byte-compare, commit or rollback. The agent owns every judgment call about content, file targets, model tier, and whether to write at all.

### Step 5: Post-Write Invariant Check

After the subprocess exits, a deterministic sweep validates the outcome. Nine invariants, all pure functions:

| Code | Rule | Severity |
|------|------|----------|
| I1 | Only writeable files changed (no meta/, no agent-notes, no session-log) | Hard fail |
| I2 | `constitution.md` is byte-identical to the pre snapshot | Hard fail |
| I3 | Canonical files still exist (constitution, persona, user-profile, domain-knowledge, corrections) | Hard fail |
| I4 | No file grew by more than 80 lines, total run growth under 100 lines, no file shrank by more than 70% without a compact annotation, no file went to zero bytes | Hard fail on bounds, soft warn otherwise |
| I5 | Markdown files have balanced code fences, JSONL files parse line by line | Hard fail |
| I6 | Credential patterns (`sk-ant-`, `ANTHROPIC_API_KEY`, `api_key =`, bearer tokens) | Hard fail |
| I6 soft | External URLs outside the allowlist | Soft warn |
| I7 | Near-duplicate bullets | Soft warn |
| I8 | Sentinel files match the actual diff | Soft warn |
| I9 | `.staging/` directory is cleaned up | Soft cleanup |

Hard fails trigger a `restoreSnapshot` from `versioning.ts` and mark the queue rows failed. After three invariant failures in a row, a row graduates to `evolution_queue_poison` for operator review.

### Step 6: Commit or Rollback

On pass, the invariant check builds a `VersionChange[]` from the diff, writes the next version to `meta/version.json`, and appends one line per drain to `meta/evolution-log.jsonl`. The version history is append-only.

## Tiered Model Selection

The reflection subprocess can run at Haiku, Sonnet, or Opus. The agent decides: every stage emits a sentinel, and when the work exceeds the current tier's reasoning budget the sentinel carries `"status":"escalate","target":"sonnet"` (or `"opus"`). TypeScript kills the stream, restores the snapshot, and respawns at the target tier. One escalation per drain, capped at Opus.

Cost model, per drain:

- Haiku stage: ~$0.10 to $0.30
- Sonnet escalation: ~$0.30 to $1.50
- Opus escalation: ~$1.00 to $5.00

Typical mix: 70 to 80% Haiku, 15 to 25% Sonnet, 1 to 5% Opus.

## Constitution Immutability

`phantom-config/constitution.md` is immutable at three layers:

1. **Sandbox deny list**: the SDK permission rules reject `Write(constitution.md)` and `Edit(constitution.md)` at tool-call time.
2. **Teaching prompt**: the subprocess prompt explicitly tells the agent the constitution is immutable and never to propose a write.
3. **Post-write invariant I2**: a byte-for-byte hash comparison of the pre snapshot against the post state catches any write that slipped past the other two layers.

Residual risk: subtle value-misalignment that slips past all three layers is an accepted residual. We chose this in exchange for deleting the old 6-judge LLM content review, which added cost and no signal.

## Memory Files

The evolved config lives in `phantom-config/`:

```
phantom-config/
  constitution.md           IMMUTABLE. Eight principles the subprocess cannot modify.
  persona.md                Communication style. Slow to evolve.
  user-profile.md           User preferences and corrections. Primary learning target.
  domain-knowledge.md       Facts about the stack, tools, projects, infrastructure.
  strategies/
    task-patterns.md        How to run recurring tasks.
    tool-preferences.md     Which tools to use, which to avoid.
    error-recovery.md       How to recover from common failures.
  memory/
    corrections.md          Explicit operator corrections.
    principles.md           Distilled strategic principles.
    agent-notes.md          Main agent journal (read-only to the subprocess).
    session-log.jsonl       Longer baseline context (read-only to the subprocess).
  meta/
    version.json            Current version number.
    metrics.json            Gate stats, queue stats, reflection_stats.
    evolution-log.jsonl     Append-only drain history.
```

## Observability

`metrics.json` carries three blocks:

- `gate_stats`: fire/skip counters and per-call cost.
- `queue_stats`: cron and demand trigger counts, mutex skips, drain duration percentiles.
- `reflection_stats`: tier distribution, escalation counts, status counts (ok/skip/escalate), sigkill and timeout counters, invariant fail counts, total cost, and per-file touch counts.

Operators read these blocks to see the shape of the pipeline at a glance.
