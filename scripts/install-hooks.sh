#!/usr/bin/env bash
# pi-conductor — install git hooks.
#
# One-time setup: points git at the in-repo `hooks/` directory so the
# pre-commit hook (and any future hooks we ship) run automatically.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

git config core.hooksPath hooks
chmod +x hooks/pre-commit

echo "✓ git hooks installed (core.hooksPath=hooks)"
echo "  pre-commit hook will run 'npm test' before every commit."
echo "  Bypass for true emergencies only: git commit --no-verify"
