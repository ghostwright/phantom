---
name: Bug Report
about: Something is broken or not working as expected
title: ""
labels: bug
assignees: ""
---

## Description

A clear description of the bug.

## Steps to Reproduce

1. ...
2. ...
3. ...

## Expected Behavior

What you expected to happen.

## Actual Behavior

What actually happened.

## Environment

- **OS:** (e.g., Ubuntu 24.04, macOS 15)
- **Docker version:** (run `docker --version`)
- **Phantom version:** (check `http://localhost:3100/health` or `package.json`)
- **Deployment method:** Docker / bare metal
- **Model:** (e.g., Opus 4.7)

## Logs

Paste relevant log output. For Docker deployments:

```bash
docker logs phantom --tail 50
```

For bare metal:

```bash
# Check the process output or journalctl if using systemd
```

## Additional Context

Any other information that might help: screenshots, config snippets (with secrets removed), or links to related issues.
