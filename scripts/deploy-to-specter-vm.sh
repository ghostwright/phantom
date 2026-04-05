#!/bin/bash
# Deploy Phantom to a Specter-provisioned VM using the Docker Hub image.
#
# Usage:
#   ./scripts/deploy-to-specter-vm.sh <vm-ip> <env-file> [phantom-name]
#
# Example:
#   ./scripts/deploy-to-specter-vm.sh <your-vm-ip> .env.<name> <name>
#
# Prerequisites:
#   - SSH access to the VM as root (Specter VMs allow root SSH)
#   - The .env file with ANTHROPIC_API_KEY, Slack tokens, etc.
#   - docker-compose.user.yaml in the repo root
#
# What this script does:
#   1. Stops and removes the specter-agent stub (if present)
#   2. Copies docker-compose.yaml and .env to the VM
#   3. Tears down any existing Docker stack (clean slate)
#   4. Starts Phantom, Qdrant, and Ollama from Docker Hub images
#   5. Waits for health check to pass
#   6. Reports status

set -euo pipefail

VM_IP="${1:?Usage: deploy-to-specter-vm.sh <vm-ip> <env-file> [phantom-name]}"
ENV_FILE="${2:?Usage: deploy-to-specter-vm.sh <vm-ip> <env-file> [phantom-name]}"
PHANTOM_NAME="${3:-phantom}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="$REPO_DIR/docker-compose.user.yaml"
REMOTE_DIR="/home/specter/phantom"

SSH_OPTS="-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: env file not found: $ENV_FILE"
  exit 1
fi

if [ ! -f "$COMPOSE_FILE" ]; then
  echo "Error: compose file not found: $COMPOSE_FILE"
  exit 1
fi

echo "=== Deploying Phantom to $VM_IP ($PHANTOM_NAME) ==="

# 1. Stop and remove specter-agent stub (if present)
echo "[1/5] Stopping specter-agent stub..."
ssh $SSH_OPTS root@"$VM_IP" bash -s << 'REMOTE'
if systemctl is-active specter-agent > /dev/null 2>&1; then
  systemctl stop specter-agent
  echo "  stopped"
else
  echo "  not running"
fi
if systemctl is-enabled specter-agent > /dev/null 2>&1; then
  systemctl disable specter-agent
  echo "  disabled"
fi
if [ -f /etc/systemd/system/specter-agent.service ]; then
  rm -f /etc/systemd/system/specter-agent.service
  systemctl daemon-reload
  echo "  service file removed"
fi
REMOTE

# 2. Copy compose file and env to the VM
echo "[2/5] Copying files to VM..."
ssh $SSH_OPTS root@"$VM_IP" "mkdir -p $REMOTE_DIR && chown specter:specter $REMOTE_DIR"
scp $SSH_OPTS "$COMPOSE_FILE" specter@"$VM_IP":"$REMOTE_DIR/docker-compose.yaml"
scp $SSH_OPTS "$ENV_FILE" specter@"$VM_IP":"$REMOTE_DIR/.env"
echo "  docker-compose.yaml and .env copied"

# 3. Tear down any existing Docker stack (clean network state)
echo "[3/5] Cleaning existing containers..."
ssh $SSH_OPTS root@"$VM_IP" "cd $REMOTE_DIR && docker compose down 2>/dev/null || true"
echo "  clean"

# 4. Start the Docker stack
echo "[4/5] Starting Phantom from Docker Hub..."
ssh $SSH_OPTS root@"$VM_IP" "cd $REMOTE_DIR && docker compose up -d"
echo "  containers started"

# 5. Wait for health check
echo "[5/5] Waiting for health check..."
MAX_WAIT=120
ELAPSED=0
while [ $ELAPSED -lt $MAX_WAIT ]; do
  HEALTH=$(ssh $SSH_OPTS specter@"$VM_IP" "curl -sf http://localhost:3100/health 2>/dev/null" || true)
  if echo "$HEALTH" | grep -q '"status":"ok"'; then
    echo ""
    echo "=== Phantom is live ==="
    echo "$HEALTH" | python3 -m json.tool 2>/dev/null || echo "$HEALTH"
    echo ""
    echo "URL: https://$PHANTOM_NAME.ghostwright.dev"
    echo "Health: https://$PHANTOM_NAME.ghostwright.dev/health"
    exit 0
  fi
  sleep 5
  ELAPSED=$((ELAPSED + 5))
  printf "."
done

echo ""
echo "Warning: health check did not pass within ${MAX_WAIT}s"
echo "Check logs: ssh specter@$VM_IP 'docker logs phantom'"
exit 1
