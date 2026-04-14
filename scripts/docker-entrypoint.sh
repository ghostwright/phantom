#!/bin/bash
set -euo pipefail

echo "[phantom] Starting bootstrap..."

# Restore default phantom-config if volume is empty (first run)
if [ ! -f /app/phantom-config/constitution.md ]; then
  echo "[phantom] First run - copying default phantom-config..."
  cp -r /app/phantom-config-defaults/* /app/phantom-config/ 2>/dev/null || true
fi

# Seed built-in skills into the user-scope .claude/skills volume on first run.
# Existing skills (user edits) are preserved: we only copy directories that are
# missing. The source lives at /app/skills-builtin/ and is a pristine copy from
# the repo; the target is on the phantom_claude Docker volume.
if [ -d /app/skills-builtin ]; then
  mkdir -p /home/phantom/.claude/skills
  for skill_dir in /app/skills-builtin/*/; do
    name=$(basename "$skill_dir")
    target="/home/phantom/.claude/skills/$name"
    if [ ! -d "$target" ]; then
      echo "[phantom] Seeding built-in skill: $name"
      cp -r "$skill_dir" "$target"
    fi
  done
fi

# Seed Phantom's four default plugins into the user-scope settings.json on
# first run. The seeder preserves operator choices: any plugin key that is
# already mentioned (true or false) is left alone. Only missing keys are
# added with value true. Other settings.json fields are preserved untouched.
if [ -f /app/src/plugins/seed.ts ]; then
  mkdir -p /home/phantom/.claude
  echo "[phantom] Seeding default plugins..."
  bun run /app/src/plugins/seed.ts --apply || echo "[phantom] WARNING: plugin seeding failed (continuing)"
fi

# Determine service URLs from environment (with Docker Compose defaults)
QDRANT_URL="${QDRANT_URL:-http://qdrant:6333}"
OLLAMA_URL="${OLLAMA_URL:-http://ollama:11434}"
EMBEDDING_MODEL="${EMBEDDING_MODEL:-nomic-embed-text}"

# 1. Wait for Qdrant to be healthy (up to 60 seconds)
echo "[phantom] Waiting for Qdrant at ${QDRANT_URL}..."
QDRANT_READY=false
for i in $(seq 1 60); do
  if curl -sf "${QDRANT_URL}/healthz" > /dev/null 2>&1; then
    QDRANT_READY=true
    echo "[phantom] Qdrant is ready"
    break
  fi
  sleep 1
done
if [ "$QDRANT_READY" = false ]; then
  echo "[phantom] WARNING: Qdrant not available after 60s. Starting in degraded mode."
fi

# 2. Wait for Ollama to be ready (up to 60 seconds)
echo "[phantom] Waiting for Ollama at ${OLLAMA_URL}..."
OLLAMA_READY=false
for i in $(seq 1 60); do
  if curl -sf "${OLLAMA_URL}/api/tags" > /dev/null 2>&1; then
    OLLAMA_READY=true
    echo "[phantom] Ollama is ready"
    break
  fi
  sleep 1
done
if [ "$OLLAMA_READY" = false ]; then
  echo "[phantom] WARNING: Ollama not available after 60s. Starting without embeddings."
fi

# 3. Pull embedding model if Ollama is ready and model is missing
if [ "$OLLAMA_READY" = true ]; then
  MODEL_EXISTS=$(curl -sf "${OLLAMA_URL}/api/tags" | jq -r ".models[]?.name // empty" | grep -c "^${EMBEDDING_MODEL}" || true)
  if [ "$MODEL_EXISTS" = "0" ]; then
    echo "[phantom] Pulling ${EMBEDDING_MODEL} model (first run, ~270MB)..."
    curl -sf "${OLLAMA_URL}/api/pull" -d "{\"name\":\"${EMBEDDING_MODEL}\"}" | while IFS= read -r line; do
      status=$(echo "$line" | jq -r '.status // empty' 2>/dev/null)
      if [ -n "$status" ] && [ "$status" != "null" ]; then
        echo "[phantom] Model pull: $status"
      fi
    done
    echo "[phantom] Model pull complete"
  else
    echo "[phantom] Embedding model ${EMBEDDING_MODEL} already available"
  fi
fi

# 4. Run phantom init if config does not exist (first run)
if [ ! -f /app/config/phantom.yaml ]; then
  echo "[phantom] First run detected. Initializing configuration..."

  # Export memory URLs for the init command
  export QDRANT_URL
  export OLLAMA_URL

  bun run src/cli/main.ts init --yes
  echo "[phantom] Configuration initialized"
else
  echo "[phantom] Configuration exists, skipping init"
fi

# 5. Set Docker awareness flag
export PHANTOM_DOCKER=true

# 6. Start Phantom (exec replaces shell so signals reach Bun directly)
echo "[phantom] Starting Phantom..."
exec bun run src/index.ts
