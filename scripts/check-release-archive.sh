#!/bin/sh
set -eu

if [ "$#" -gt 1 ]; then
    echo "usage: $0 [git-ref]" >&2
    exit 2
fi

ref="${1:-HEAD}"
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

archive_paths="$(git archive --format=tar "$ref" | tar -tf -)"
if ! printf '%s\n' "$archive_paths" | "$script_dir/check-local-only.sh" --stdin; then
    echo "Release source archive dry-run contains forbidden paths." >&2
    exit 1
fi
