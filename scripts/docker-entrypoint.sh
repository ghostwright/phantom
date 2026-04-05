#!/bin/bash
set -euo pipefail

echo "[phantom] Starting bootstrap..."

# Restore default phantom-config if volume is empty (first run)
if [ ! -f /app/phantom-config/constitution.md ]; then
  echo "[phantom] First run - copying default phantom-config..."
  cp -r /app/phantom-config-defaults/* /app/phantom-config/ 2>/dev/null || true
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

# 6. Claude Max OAuth credentials (optional)
#
# Preferred path: set CLAUDE_CODE_OAUTH_TOKEN in .env (generated once via
# `claude setup-token` inside the container). It is a long-lived token with
# its own session, does not rotate, and will not conflict with any other
# Claude Code sessions on the host or elsewhere.
#
# Fallback path: docker-compose.override.yml can bind-mount the host's
# ~/.claude/.credentials.json read-only to /tmp/.credentials-mount.json, and
# we copy it into place + keep it in sync via a background loop. WARNING:
# this shares a rotating OAuth session between the host and the container,
# which Anthropic's auth backend will reject as concurrent use. Only use the
# mount fallback on machines where nothing else is running Claude Code.
CLAUDE_CRED_SRC="/tmp/.credentials-mount.json"
CLAUDE_CRED_DST="/home/phantom/.claude/.credentials.json"
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  echo "[phantom] Using CLAUDE_CODE_OAUTH_TOKEN from environment (skipping credentials mount)"
elif [ -f "$CLAUDE_CRED_SRC" ]; then
  echo "[phantom] Installing Claude Max credentials from mount..."
  mkdir -p "$(dirname "$CLAUDE_CRED_DST")"
  cp "$CLAUDE_CRED_SRC" "$CLAUDE_CRED_DST"
  chmod 600 "$CLAUDE_CRED_DST"

  (
    while sleep 60; do
      if [ -f "$CLAUDE_CRED_SRC" ] && ! cmp -s "$CLAUDE_CRED_SRC" "$CLAUDE_CRED_DST" 2>/dev/null; then
        if cp "$CLAUDE_CRED_SRC" "$CLAUDE_CRED_DST" 2>/dev/null; then
          chmod 600 "$CLAUDE_CRED_DST" 2>/dev/null || true
          echo "[phantom] Claude credentials refreshed from mount"
        fi
      fi
    done
  ) &
else
  echo "[phantom] No Claude Max credentials mount found at $CLAUDE_CRED_SRC (relying on ANTHROPIC_API_KEY)"
fi

# 7. Start Phantom (exec replaces shell so signals reach Bun directly)
echo "[phantom] Starting Phantom..."
exec bun run src/index.ts
