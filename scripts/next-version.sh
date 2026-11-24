#!/usr/bin/env bash
# Print the next version for HEAD, as GitHub Actions outputs:
#   version=v1.2.4
#   previous=v1.2.3
# Bumps from the latest vX.Y.Z tag reachable from HEAD, looking at the commit messages since then:
#   "#major" or "BREAKING CHANGE" → major, "#minor" → minor, anything else → patch.
# Prints nothing if HEAD is already tagged (a re-run), so no version is made twice.
set -euo pipefail

if git tag --points-at HEAD | grep -qE '^v[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "HEAD is already tagged; nothing to do" >&2
  exit 0
fi

previous=$(git describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' 2>/dev/null || true)
if [ -n "$previous" ]; then
  messages=$(git log --format=%B "$previous..HEAD")
  IFS=. read -r major minor patch <<< "${previous#v}"
else
  messages=$(git log --format=%B HEAD)
  major=0 minor=0 patch=0
fi

if grep -qiE '#major|BREAKING CHANGE' <<< "$messages"; then
  major=$((major + 1)); minor=0; patch=0
elif grep -qiE '#minor' <<< "$messages"; then
  minor=$((minor + 1)); patch=0
else
  patch=$((patch + 1))
fi

echo "version=v$major.$minor.$patch"
echo "previous=$previous"
echo "next version: v$major.$minor.$patch (after ${previous:-no tag})" >&2
