#!/bin/sh
set -eu

usage() {
    echo "usage: $0 --staged|--tree|--stdin" >&2
}

mode="${1:-}"
case "$mode" in
    --staged)
        paths="$(git diff --cached --name-only --diff-filter=ACMR)"
        ;;
    --tree)
        paths="$(git ls-files)"
        ;;
    --stdin)
        paths="$(cat)"
        ;;
    *)
        usage
        exit 2
        ;;
esac

blocked="$(
    printf '%s\n' "$paths" | awk '
        NF == 0 { next }
        $0 ~ /^(SPEC\.md|spec_ko\.md|AGENTS\.md|ROADMAP\.md)$/ { print; next }
        $0 ~ /^(dontupload|\.gstack)(\/|$)/ { print; next }
        $0 ~ /^docker-compose\.gemma-.*-speed\.yml$/ { print; next }
        $0 ~ /(^|\/)\.env($|\.)/ && $0 !~ /(^|\/)\.env\.example$/ { print; next }
        $0 ~ /\.(gguf|safetensors|ckpt|bin|onnx|sqlite|sqlite3|db|log)$/ { print; next }
        $0 ~ /(^|\/)(exports|screenshots|test-results|playwright-report|coverage|node_modules|target|dist)(\/|$)/ { print; next }
        $0 ~ /(^|\/)(runtime-export|runtime-exports|benchmark-results|benchmarks-output)(\/|$)/ { print; next }
        $0 ~ /(^|\/)(secret|secrets|api-key|apikey|token)[^\/]*\.(json|txt|env|toml|yaml|yml)$/ { print; next }
    '
)"

if [ -n "$blocked" ]; then
    echo "Forbidden local-only, generated, or sensitive paths detected:" >&2
    printf '%s\n' "$blocked" >&2
    exit 1
fi
