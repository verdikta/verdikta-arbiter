#!/bin/bash
# KEY=value files the installer edits, such as ai-node/.env.local.
#
# The install and the upgrade used to write a provider key with
# `sed "s/^KEY=.*/KEY=$value/"`, so a value with `/`, `&` or `\` broke the
# expression or was written wrong. These helpers read a key the way the AI Node
# reads it and write one with the value taken literally. Which side wins
# (installer/.api_keys or .env.local) is the caller's decision: see apply_env_key
# in bin/upgrade-arbiter.sh.
#
#   env_file_value KEY FILE        -> prints the value the AI Node would load for KEY
#   env_file_set   KEY VALUE FILE  -> sets KEY to VALUE in FILE

# env_file_value KEY FILE — prints the value FILE gives KEY, as the AI Node loads
# it: @next/env reads .env.local with dotenv's parse(), and the Python below is that
# function (dotenv 16, lib/main.js) with its LINE expression and value clean-up
# unchanged, so a quoted value, a trailing `# comment`, `export KEY=` and blanks
# around `=` read as they do there. The last line for KEY wins, as in dotenv. Not
# applied: dotenv-expand's `$VAR` expansion. Prints nothing when FILE or KEY is
# missing or the value is empty.
# Returns 0 when it could read FILE (or FILE is missing), and non-zero when it could
# not (no python3, an unreadable file): the caller then knows nothing about KEY.
env_file_value() {
    local key="$1" file="$2"
    [ -f "$file" ] || return 0
    python3 - "$key" "$file" <<'PY'
import re, sys
key, path = sys.argv[1], sys.argv[2]
with open(path, 'rb') as f:
    src = f.read().decode('utf-8', 'replace')
LINE = re.compile(r'''(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)''', re.M)
lines = re.sub(r'\r\n?', '\n', src)
parsed = {}
for match in LINE.finditer(lines):
    value = (match.group(2) or '').strip()
    maybe_quote = value[:1]
    value = re.sub(r'''^(['"`])([\s\S]*)\1$''', r'\2', value, flags=re.M)
    if maybe_quote == '"':
        value = value.replace('\\n', '\n').replace('\\r', '\r')
    parsed[match.group(1)] = value
sys.stdout.write(parsed.get(key, ''))
PY
}

# env_file_set KEY VALUE FILE — writes VALUE, literally, on every `KEY=` line of
# FILE, or appends `KEY=VALUE` on a line of its own when there is none (creating
# FILE). The rest of FILE is kept. Leaves FILE.bak, as the sed it replaces did.
# Returns 1, with FILE unchanged, for a value with a line break, and non-zero when
# FILE cannot be written.
env_file_set() {
    local key="$1" value="$2" file="$3" escaped
    case "$value" in
        *$'\n'*|*$'\r'*) return 1 ;;
    esac
    if [ -f "$file" ] && grep -q -- "^${key}=" "$file"; then
        # The replacement side of s///: `\`, `/` and `&` are the characters sed reads.
        escaped=$(printf '%s' "$value" | sed -e 's/[\/&\\]/\\&/g') || return 1
        sed -i.bak "s/^${key}=.*/${key}=${escaped}/" "$file" || return 1
    else
        if [ -s "$file" ] && [ -n "$(tail -c 1 "$file")" ]; then
            printf '\n' >> "$file" || return 1
        fi
        printf '%s=%s\n' "$key" "$value" >> "$file" || return 1
    fi
    return 0
}
