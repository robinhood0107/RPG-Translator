#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 --stdin | <file>..." >&2
  exit 2
}

if [ "$#" -eq 0 ]; then
  usage
fi

patterns=(
  'MYCODE_STRUCTURE_DEEP_DIVE'
  'mycode'
  'RPG-Maker-Live-Translator'
  'goal\.md'
  'SPEC\.md'
  'spec_ko\.md'
  'AGENTS\.md'
  'ROADMAP\.md'
  'dontupload'
  'City_Of_Secrets'
  'markdown'
  '마크다운'
  '인용'
  'Original Reference'
  'original-reference'
  'reference read'
  'reference audit'
  'source-reference'
  'source reference'
  'files read'
  'read from'
  'copied from'
  'behavior-level audit'
  'original implementation'
  'source material'
  'local reference'
  'local path'
  'local-path'
  'C:\\Users\\'
  '/mnt/c/[Uu]sers/'
)

scan_file() {
  local label="$1"
  local file="$2"
  local matched=0
  local tmp
  tmp="$(mktemp)"

  for pattern in "${patterns[@]}"; do
    if grep -E -i -n -- "$pattern" "$file" >"$tmp"; then
      if [ "$matched" -eq 0 ]; then
        echo "Public GitHub copy guard failed for ${label}:" >&2
      fi
      echo "Pattern: ${pattern}" >&2
      cat "$tmp" >&2
      matched=1
    fi
  done

  rm -f "$tmp"

  if [ "$matched" -ne 0 ]; then
    exit 1
  fi
}

if [ "$1" = "--stdin" ]; then
  tmp_input="$(mktemp)"
  cat >"$tmp_input"
  scan_file "stdin" "$tmp_input"
  rm -f "$tmp_input"
  exit 0
fi

for file in "$@"; do
  if [ ! -f "$file" ]; then
    echo "Not a file: $file" >&2
    exit 2
  fi
  scan_file "$file" "$file"
done
