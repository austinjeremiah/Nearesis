#!/bin/sh
# Fails if git tracks anything that must stay local (final directive s24): the Build Bible, the owner's directive, env files
# (only .env.example is allowed), private keys and runtime data. Reads `git ls-files`, so it judges what a push would publish.
# CI runs it as the first step; it never installs hooks. POSIX sh.
#   NEARESIS_PROHIBITED_REPO   repository to check (default: the one containing this script)
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
repo="${NEARESIS_PROHIBITED_REPO:-$here}"
top="$(git -C "$repo" rev-parse --show-toplevel)"
bad="$(git -C "$top" ls-files -z \
  | tr '\0' '\n' \
  | grep -E '(^|/)NEARESIS_Build_Bible(/|$)|(^|/)final_master_prompt[^/]*\.md$|(^|/)\.env($|\.)|\.pem$|(^|/)\.data(/|$)' \
  | grep -Ev '(^|/)\.env\.example$' || true)"
if [ -n "$bad" ]; then
  echo "prohibited paths are tracked by git:" >&2
  echo "$bad" | sed 's/^/  /' >&2
  echo "remove them from the index (git rm --cached) and keep them ignored" >&2
  exit 1
fi
echo "prohibited-path check passed ($(git -C "$top" ls-files | wc -l | tr -d ' ') tracked files)"
