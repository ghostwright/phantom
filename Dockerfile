# =============================================================================
# Phantom AI Agent - Docker Image
# Multi-stage build: install deps in builder, copy to lean runtime
# =============================================================================

# --- Build Stage ---
FROM oven/bun:1 AS builder
WORKDIR /app

# Install dependencies first (cache layer)
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

# Copy source and config
COPY src/ src/
COPY config/ config/
COPY phantom-config/ phantom-config/
COPY scripts/ scripts/
COPY public/ public/
COPY skills-builtin/ skills-builtin/
COPY tsconfig.json biome.json ./

# --- Runtime Stage ---
FROM oven/bun:1-slim
WORKDIR /app

# Install runtime dependencies:
# - tini: PID 1 init for signal forwarding and zombie reaping
# - curl: health checks and entrypoint API calls
# - git: agent clones repositories
# - jq: entrypoint parses Ollama API responses
# - sqlite3: database inspection and backup
# - ca-certificates: TLS connections
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      tini \
      curl \
      git \
      jq \
      sqlite3 \
      ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# NOTE: The Agent SDK spawns its bundled cli.js via bun, NOT the global `claude`
# binary. No global @anthropic-ai/claude-code install is needed.

# Install Docker CLI (static binary, no daemon needed).
# The agent creates sibling containers via the mounted Docker socket.
# dpkg --print-architecture returns amd64/arm64 but Docker's download
# server uses x86_64/aarch64, so we map the architecture name.
RUN DPKG_ARCH=$(dpkg --print-architecture) && \
    case "$DPKG_ARCH" in \
      amd64) DOCKER_ARCH="x86_64" ;; \
      arm64) DOCKER_ARCH="aarch64" ;; \
      *) DOCKER_ARCH="$DPKG_ARCH" ;; \
    esac && \
    curl -fsSL "https://download.docker.com/linux/static/stable/${DOCKER_ARCH}/docker-27.5.1.tgz" \
    | tar xz --strip-components=1 -C /usr/local/bin docker/docker && \
    chmod +x /usr/local/bin/docker

# Create non-root phantom user with home directory.
# Claude Code CLI refuses --dangerously-skip-permissions when running as root,
# so the container MUST run as a non-root user. Docker socket access is granted
# via group_add in docker-compose.yaml (matching the host's docker GID).
RUN groupadd --system phantom && \
    useradd --system --gid phantom --create-home --home-dir /home/phantom phantom && \
    mkdir -p /home/phantom/.claude && \
    chown -R phantom:phantom /home/phantom

# Copy built artifacts from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/config ./config
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/public ./public
COPY --from=builder /app/skills-builtin ./skills-builtin
COPY --from=builder /app/package.json ./
COPY --from=builder /app/tsconfig.json ./

# Install Chromium headless shell + system deps for Playwright.
# Must run after node_modules is copied so bunx can resolve playwright.
# --only-shell skips the full Chromium binary (saves ~75 MiB off the full
# chrome channel); the custom phantom_preview_page tool uses
# chromium.launch() which picks the headless shell automatically for
# headless=true. The @playwright/mcp embed path uses a contextGetter so it
# never needs the full chrome channel binary.
#
# Image cost breakdown (verified on the built image vs. the pre-Playwright
# baseline, total delta roughly 996 MiB over the non-Playwright baseline):
#   ~327 MB  chromium_headless_shell-* binary at
#            /home/phantom/.cache/ms-playwright/chromium_headless_shell-*
#   ~91 MB   /usr/share/fonts pulled by --with-deps (DejaVu, Liberation,
#            Noto Core)
#   ~500+ MB /usr/lib X11 / GTK / libasound / libnss3 / libcups / libatk
#            and the other shared libraries apt-get pulls for Chromium
#
# --only-shell only affects the Chromium binary. The system deps are the
# dominant cost and cannot be trimmed without breaking Chromium's ability
# to start. If you are trying to shrink this image, the headless shell
# binary is the only safe target; the /usr/lib growth is load-bearing.
ENV PLAYWRIGHT_BROWSERS_PATH=/home/phantom/.cache/ms-playwright
RUN mkdir -p "$PLAYWRIGHT_BROWSERS_PATH" && \
    bunx playwright install --with-deps --only-shell chromium && \
    chown -R phantom:phantom /home/phantom/.cache && \
    rm -rf /var/lib/apt/lists/*

# Copy default phantom-config (constitution.md, persona.md, etc.)
# These get backed up so they survive the empty volume mount on first run.
COPY --from=builder /app/phantom-config ./phantom-config

# Create volume mount points with correct ownership
RUN mkdir -p /app/data /app/repos && \
    chown -R phantom:phantom /app

# Backup phantom-config defaults so they survive empty volume mount
RUN cp -r /app/phantom-config /app/phantom-config-defaults

# Make entrypoint executable
RUN chmod +x /app/scripts/docker-entrypoint.sh

# Health check: curl the /health endpoint every 30 seconds
# Start period gives 120s for first-run model pull + init
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
  CMD curl -sf http://localhost:3100/health | jq -e '.status != "down"' > /dev/null || exit 1

EXPOSE 3100

# Run as non-root user
USER phantom
ENV HOME=/home/phantom

# tini as init process for signal handling and zombie reaping
ENTRYPOINT ["tini", "--"]

# The entrypoint script handles waiting for deps, model pull, and init
CMD ["/app/scripts/docker-entrypoint.sh"]
