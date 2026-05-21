#!/usr/bin/env bash
# Reject commits that contain residual WDD mutation markers in src/*.ts.
#
# Why: WDD verification mutates production code in-place with `// MUTATION:`
# or `// MUTATE:` comment markers, then reverts. If a builder is killed
# mid-cycle (infra crash, watchdog hard-kill), the residual marker can
# ship undetected. Witnessed in v0.11 slice 2 stash@{0} salvage.
#
# Scope: only staged TypeScript files under src/. Working-tree-only edits
# are ignored — we trust commits, not WIP.
#
# Exits 1 with a file:line:content listing if any marker is staged; 0 otherwise.
set -uo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

# Staged, modified-or-added TypeScript files under src/.
staged_files="$(git diff --cached --name-only --diff-filter=ACM | grep -E '^src/.*\.ts$' || true)"

if [[ -z "$staged_files" ]]; then
  exit 0
fi

found=0
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  # Read the STAGED content (not working tree) so partial-stages are honored.
  # Pattern matches `// MUTATION:` or `// MUTATE:` exactly (case-sensitive).
  hit="$(git show ":$f" 2>/dev/null | grep -nE '//[[:space:]]*(MUTATION|MUTATE):' || true)"
  if [[ -n "$hit" ]]; then
    while IFS= read -r line; do
      echo "$f:$line" >&2
    done <<< "$hit"
    found=1
  fi
done <<< "$staged_files"

if [[ $found -eq 1 ]]; then
  echo >&2
  echo "check-no-mutation-markers: residual WDD mutation marker(s) staged. Commit rejected." >&2
  echo "check-no-mutation-markers: revert the mutation(s) above, re-stage, and commit again." >&2
  exit 1
fi
exit 0
