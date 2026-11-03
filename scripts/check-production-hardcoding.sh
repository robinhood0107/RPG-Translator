#!/bin/sh
set -eu

usage() {
    echo "usage: $0 [--stdin]" >&2
}

mode="${1:-}"
case "$mode" in
    "")
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

blocked_paths="$(
    printf '%s\n' "$paths" | awk '
        NF == 0 { next }
        $0 ~ /(^|\/)(tests?|test|fixtures?)(\/|$)/ { next }
        $0 ~ /\.(test|spec)\.(ts|tsx|js|jsx|rs)$/ { next }
        $0 ~ /^crates\/core\/src\/batch\.rs$/ { next }
        $0 ~ /^apps\/desktop\/src\/mockData\.ts$/ { print; next }
        $0 ~ /^apps\/desktop\/src\/.*\.(ts|tsx)$/ { print; next }
        $0 ~ /^apps\/desktop\/src-tauri\/src\/.*\.rs$/ { print; next }
    '
)"

if [ -z "$blocked_paths" ]; then
    exit 0
fi

patterns='mockData|mockCommand|translate_with_fake_provider|desktop-fake|synthetic-workbench|C:/Games|C:/Exports|exports/synthetic-ko|Run fake provider|allowLocalTestMutation|Allow local test game writes|로컬 테스트 게임 쓰기 허용'
matches="$(
    printf '%s\n' "$blocked_paths" | while IFS= read -r path; do
        [ -f "$path" ] || continue
        grep -nE "$patterns" "$path" || true
    done
)"

if [ -n "$matches" ]; then
    echo "Forbidden production mock, fake provider, or hardcoded sample path detected:" >&2
    printf '%s\n' "$matches" >&2
    exit 1
fi
