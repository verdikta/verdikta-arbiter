#!/bin/bash
# KEY=value files the installer edits, such as ai-node/.env.local.
#
# The install and the upgrade used to write a provider key with
# `sed "s/^KEY=.*/KEY=$value/"`, so a value with `/`, `&` or `\` broke the
# expression or was written wrong. These helpers read and write one key, with the
# value taken literally. Which side wins (installer/.api_keys or .env.local) is
# the caller's decision: see apply_env_key in bin/upgrade-arbiter.sh.
#
#   env_file_value KEY FILE        -> prints the value FILE gives KEY
#   env_file_set   KEY VALUE FILE  -> sets KEY to VALUE in FILE

# env_file_value KEY FILE — prints the value of the last `KEY=` line of FILE (the
# one dotenv keeps), with the blanks around it and one pair of matching quotes
# removed. An unquoted value ends at `#`, as in dotenv. Prints nothing when FILE
# or the line is missing or the value is empty. Always returns 0.
env_file_value() {
    local key="$1" file="$2" line value
    [ -f "$file" ] || return 0
    line=$(grep -- "^${key}=" "$file" 2>/dev/null | tail -n 1) || line=""
    value="${line#*=}"
    value="${value%$'\r'}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    case "$value" in
        \"*\") value="${value#\"}"; value="${value%\"}" ;;
        \'*\') value="${value#\'}"; value="${value%\'}" ;;
        *)
            value="${value%%#*}"
            value="${value%"${value##*[![:space:]]}"}"
            ;;
    esac
    printf '%s' "$value"
    return 0
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
