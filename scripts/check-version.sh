#!/usr/bin/env bash
# Fails unless package.json and the runtime VERSION constant equal $1 (e.g. 0.1.1 or v0.1.1).
set -euo pipefail
cd "$(dirname "$0")/.."
want="${1#v}"
[[ "$want" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.+].*)?$ ]] || { echo "usage: $0 <version>" >&2; exit 2; }
fail=0
check() { if [[ "$2" != "$want" ]]; then echo "version mismatch: $1 is '$2', expected '$want'" >&2; fail=1; fi; }
check package.json "$(node -p "require('./package.json').version")"
check src/client.ts "$(sed -nE 's/^export const VERSION = "(.*)";/\1/p' src/client.ts)"
exit $fail
