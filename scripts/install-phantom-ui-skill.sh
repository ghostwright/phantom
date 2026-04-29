#!/usr/bin/env bash
# Installs the phantom-ui skill seed into the user-level Claude Agent SDK
# skills directory. The seed is tracked in this repo at
# scripts/skills/phantom-ui.md and gets copied into
# ~/.claude/skills/phantom-ui/SKILL.md so the live agent discovers it once
# the runtime wires settingSources to include 'user'.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_FILE="${SCRIPT_DIR}/skills/phantom-ui.md"
TARGET_DIR="${HOME}/.claude/skills/phantom-ui"
TARGET_FILE="${TARGET_DIR}/SKILL.md"

if [ ! -f "${SOURCE_FILE}" ]; then
  echo "error: source file not found at ${SOURCE_FILE}"
  echo "       run this script from the repository root"
  exit 1
fi

mkdir -p "${TARGET_DIR}"
cp "${SOURCE_FILE}" "${TARGET_FILE}"
echo "installed phantom-ui skill seed at ${TARGET_FILE}"
