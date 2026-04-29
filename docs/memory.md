# Memory System

Phantom has a three-tier vector memory backed by Qdrant and Ollama. Memory persists across sessions, giving the agent context about past conversations, accumulated knowledge, and learned workflows.

## Architecture

```
Query -> Embedding (Ollama) -> Hybrid Search (Qdrant) -> Ranked Results -> Context Builder -> Prompt
```

All channels share the same memory system. A conversation in the web chat at `/chat` produces the same episodic, semantic, and procedural memories as a Slack conversation. Switching channels does not lose context.

### Tier 1: Episodic Memory

Session transcripts stored as embeddings. Each episode contains:
- Session summary, user messages, assistant messages
- Outcome (success/failure), cost, duration
- Entities mentioned, tools used, files touched

Search: "What happened last time I worked on the auth service?"

Episode ranking is not raw vector score alone. Retrieval blends semantic match with importance, reinforcement from repeated access, and decay over time so durable memories stay available while stale one-off memories fade.

### Tier 2: Semantic Memory

Accumulated facts with contradiction detection and temporal validity:
- Domain knowledge ("repo-a uses Rails 8 with PostgreSQL")
- User preferences ("prefers small PRs, conventional commits")
- Team context ("@sarah is the main reviewer, she cares about test coverage")

When a new fact contradicts an existing one, the old fact is marked superseded.

### Tier 3: Procedural Memory

Learned workflows and step-by-step procedures:
- "When CI fails on repo-a, check migrations first"
- "Deploy sequence: branch, PR, review, merge, wait for CI, verify staging"

## Search

Hybrid search combines two strategies:

- **Dense vectors** (768d, nomic-embed-text via Ollama) for semantic similarity
- **BM25 sparse vectors** (FNV-1a hash) for exact keyword matching

Results are fused using Reciprocal Rank Fusion (RRF). This means searching for "authentication bug" matches both semantically similar episodes and episodes that literally mention "authentication".

## Context Builder

Before each agent invocation, the context builder:

1. Embeds the user's message
2. Searches episodic memory (top 10 episodes)
3. Searches semantic memory (top 20 facts)
4. Searches procedural memory (top 5 procedures)
5. Budgets results to fit within the token limit (default: 50,000 tokens)
6. Filters out stale, low-signal episodic memories before prompt injection
7. Formats results into the memory section of the system prompt

## Consolidation

After each session, memory consolidation:

1. Extracts episodes from the session transcript
2. Extracts semantic facts (with heuristic or LLM extraction)
3. Stores embeddings in Qdrant

Nightly consolidation (configurable):
- Compresses old episodes into summaries
- Promotes repeated patterns from episodic to procedural
- Prunes contradicted facts
- Keeps storage bounded

## Configuration

Memory is configured in `config/memory.yaml` (auto-generated with defaults if not present):

```yaml
qdrant:
  url: http://localhost:6333
ollama:
  url: http://localhost:11434
  model: nomic-embed-text
embedding:
  dimensions: 768
  batch_size: 32
context:
  max_tokens: 50000
  episode_limit: 10
  fact_limit: 20
  procedure_limit: 5
```

## Docker Services

Qdrant and Ollama run as Docker containers:

```bash
docker compose up -d
docker exec phantom-ollama ollama pull nomic-embed-text
```

If Docker services are unavailable, Phantom degrades gracefully. Memory is unavailable but the agent still works.
