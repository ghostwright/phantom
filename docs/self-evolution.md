# Self-Evolution

The self-evolution engine is what makes Phantom different from every other AI agent. After every session, Phantom reflects on what happened and rewrites its own configuration to do better next time.

## How It Works

After each session completes, the evolution engine runs a 6-step pipeline:

### Step 1: Observation Extraction

The engine analyzes the session transcript for:
- **Corrections** - user said "no, do it this way instead"
- **Preferences** - user expressed a preference ("I prefer small PRs")
- **Domain facts** - new knowledge about the codebase, team, or tools
- **Errors** - things that went wrong

With LLM judges enabled, Claude Sonnet extracts observations with high accuracy. Without judges, heuristic pattern matching provides a fallback.

### Step 2: Self-Critique

Observations are compared against the current evolved config. The engine asks: "Given what just happened, what should change in my configuration?"

### Step 3: Config Delta Generation

Concrete, minimal changes are generated. Each delta targets a specific config file and section:

```
File: domain-knowledge.md
Section: Repository patterns
Change: Add "repo-a uses RSpec with FactoryBot for tests"
Rationale: User corrected me when I tried to use Minitest
```

### Step 4: 5-Gate Validation

Every proposed change must pass all 5 gates:

| Gate | Checks | Failure Mode |
|------|--------|-------------|
| Constitution | Violates immutable principles? | Rejected |
| Regression | Breaks golden test cases? | Rejected |
| Size | Config file over 200 lines? | Rejected |
| Drift | Too far from original? | Rejected |
| Safety | Touches protected patterns? | Rejected |

With LLM judges, the safety and constitution gates use triple-judge voting with minority veto. One dissenting judge blocks the change.

### Step 5: Application

Approved changes are written to the config files in `phantom-config/`. A new version is created with a metrics snapshot.

### Step 6: Periodic Consolidation

Every N sessions (configurable), the engine:
- Compresses old observations into principles
- Prunes redundant entries
- Extracts patterns from accumulated observations
- Keeps config files lean and focused

## Config Files

The evolved config lives in `phantom-config/`:

```
phantom-config/
  constitution.md           - Immutable principles (Tier 1, never modified by evolution)
  persona.md                - Communication style and personality
  user-profile.md           - User preferences and corrections
  domain-knowledge.md       - Accumulated expertise
  strategies/
    task-patterns.md        - Learned approaches to common tasks
    tool-preferences.md     - Preferred tools and workflows
    error-recovery.md       - Learned error handling
```

These files are injected into the system prompt. Day 1, they are nearly empty. Day 30, they are dense with specific knowledge.

## Versioning

Every change creates a new version in `phantom-config/version.json`:

```json
{
  "version": 42,
  "parent": 41,
  "timestamp": "2026-03-25T14:30:00Z",
  "session_id": "abc123",
  "changes": ["domain-knowledge.md"],
  "metrics_snapshot": {
    "total_sessions": 150,
    "success_rate": 0.94,
    "correction_rate": 0.05
  }
}
```

## Rollback

If metrics degrade after an evolution (success rate drops, correction rate increases), the engine automatically rolls back to the previous version. Manual rollback is also available.

## LLM Judges

The Agent SDK powers 6 LLM judges that provide higher-quality evolution:

| Judge | Model | Strategy | Purpose |
|-------|-------|----------|---------|
| Observation | Sonnet | Single | Extract observations from sessions |
| Safety | Sonnet | Triple, minority veto | Block unsafe config changes |
| Constitution | Sonnet | Triple, minority veto | Enforce immutable principles |
| Regression | Haiku -> Sonnet -> Opus | Cascaded | Check against golden suite |
| Consolidation | Sonnet | Single | Compress observations into principles |
| Quality | Sonnet | Single | Assess overall session quality |

Judge costs are tracked in `phantom-config/metrics.json`.

## Adaptive Cadence

Early in the agent's life (first 10 sessions), evolution is aggressive: every session triggers the pipeline. As the agent stabilizes, the cadence adapts. Config changes become less frequent as the agent converges on good patterns.
