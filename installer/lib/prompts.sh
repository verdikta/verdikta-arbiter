#!/bin/bash
#
# Verdikta Arbiter installer — shared prompt helpers with an unattended mode.
#
# Every interactive question the installer, upgrader and the operator tools ask
# goes through one of the three helpers below. In the default (interactive)
# mode they behave exactly like the `read -p` / `read -sp` / y-n loops they
# replaced. When VERDIKTA_UNATTENDED=1 is exported (install.sh --answers FILE,
# install.sh --unattended, upgrade-arbiter.sh --answers FILE, ...) they never
# touch stdin: each question is answered from a VA_* environment variable, or
# from the unattended default the call site declares, or the run fails fast
# with the name of the missing answer. Nothing ever blocks waiting for a TTY.
#
#   ask_yes_no    PROMPT [DEFAULT] [KEY] [UNATTENDED_DEFAULT]   -> return 0 (yes) / 1 (no)
#   prompt_value  PROMPT VAR       [KEY] [UNATTENDED_DEFAULT]   -> sets $VAR (visible input)
#   prompt_secret PROMPT VAR       [KEY] [UNATTENDED_DEFAULT]   -> sets $VAR (masked input)
#
#   DEFAULT            — interactive default applied when the operator presses
#                        Enter ("y" or "n"; empty = keep asking, the historical
#                        behaviour of the install scripts). Also the last-resort
#                        unattended answer.
#   KEY                — name of the VA_* variable that answers this question
#                        in unattended mode (e.g. VA_START_SERVICES).
#   UNATTENDED_DEFAULT — answer used in unattended mode when $KEY is unset.
#
# Unattended semantics for value prompts: an unset key behaves exactly like the
# operator pressing Enter (empty string), so every call site keeps applying its
# own default. A key that is consumed twice (the script re-asked because
# validation rejected the value) aborts the run instead of looping forever.
#
# Exit code 65 is reserved for "unattended run needs an answer it does not have".
#
# Sourced by: installer/bin/install.sh, setup-environment.sh, setup-docker.sh,
# setup-chainlink.sh, install-ai-node.sh, deploy-contracts.sh, configure-node.sh,
# register-oracle-dispatcher.sh, upgrade-arbiter.sh, util/register-oracle.sh,
# util/update-rpc-endpoints.sh.

VERDIKTA_UNATTENDED="${VERDIKTA_UNATTENDED:-0}"
UNATTENDED_EXIT_CODE=65

# Keys already consumed in this process (space-separated), to detect re-asks.
_VA_CONSUMED_KEYS=""

unattended_mode() {
    [ "$VERDIKTA_UNATTENDED" = "1" ]
}

# unattended_fail KEY PROMPT [REASON]
unattended_fail() {
    local key="$1" prompt="$2" reason="${3:-no answer available}"
    echo "" >&2
    echo "ERROR (unattended): cannot answer the question: ${prompt}" >&2
    if [ -n "$key" ]; then
        echo "  ${reason}; set ${key} in the answers file (see installer/config/unattended.env.example)." >&2
    else
        echo "  ${reason}; this question has no unattended answer and needs an interactive run." >&2
    fi
    exit "$UNATTENDED_EXIT_CODE"
}

# Abort when stdin is exhausted in interactive mode, instead of spinning on a
# y/n loop that will never get an answer (piped stdin, closed terminal, ...).
_prompt_eof_fail() {
    local prompt="$1"
    echo "" >&2
    echo "ERROR: no input available for the question: ${prompt}" >&2
    echo "  stdin is closed or exhausted. Run interactively, or use --answers FILE / --unattended." >&2
    exit "$UNATTENDED_EXIT_CODE"
}

# _va_consume KEY PROMPT — marks KEY consumed; fails on the second consumption.
_va_consume() {
    local key="$1" prompt="$2"
    [ -z "$key" ] && return 0
    case " $_VA_CONSUMED_KEYS " in
        *" $key "*)
            unattended_fail "$key" "$prompt" "the value of ${key} was rejected by validation"
            ;;
    esac
    _VA_CONSUMED_KEYS="$_VA_CONSUMED_KEYS $key"
}

# _va_lookup KEY -> prints the value of the variable named KEY ("" if unset).
_va_lookup() {
    local key="$1"
    [ -z "$key" ] && { echo ""; return; }
    eval "printf '%s' \"\${${key}:-}\""
}

# _va_yes_no_value VALUE -> normalises y/yes/true/1 and n/no/false/0; prints
# "y" / "n", or "" when unrecognised.
_va_yes_no_value() {
    case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
        y|yes|true|1)  echo "y" ;;
        n|no|false|0)  echo "n" ;;
        *)             echo "" ;;
    esac
}

# ask_yes_no PROMPT [DEFAULT] [KEY] [UNATTENDED_DEFAULT]
ask_yes_no() {
    local prompt="$1"
    local default="${2:-}"
    local key="${3:-}"
    local unattended_default="${4:-}"
    local response

    if unattended_mode; then
        _va_consume "$key" "$prompt"
        local raw normalised
        raw="$(_va_lookup "$key")"
        if [ -n "$raw" ]; then
            normalised="$(_va_yes_no_value "$raw")"
            [ -z "$normalised" ] && unattended_fail "$key" "$prompt" "${key}='${raw}' is not a yes/no value"
        elif [ -n "$unattended_default" ]; then
            normalised="$(_va_yes_no_value "$unattended_default")"
        elif [ -n "$default" ]; then
            normalised="$(_va_yes_no_value "$default")"
        else
            unattended_fail "$key" "$prompt"
        fi
        echo "$prompt (y/n): $normalised  [unattended${key:+: $key}]"
        [ "$normalised" = "y" ]
        return
    fi

    # Interactive: identical to the loops this helper replaced.
    local prompt_text="$prompt"
    if [ "$default" = "y" ]; then
        prompt_text="$prompt (Y/n)"
    elif [ "$default" = "n" ]; then
        prompt_text="$prompt (y/N)"
    else
        prompt_text="$prompt (y/n)"
    fi

    while true; do
        if ! read -p "$prompt_text: " response; then
            _prompt_eof_fail "$prompt"
        fi
        if [ -z "$response" ] && [ -n "$default" ]; then
            response="$default"
        fi
        case "$response" in
            [Yy]* ) return 0;;
            [Nn]* ) return 1;;
            * ) echo "Please answer yes (y) or no (n).";;
        esac
    done
}

# prompt_value PROMPT VAR [KEY] [UNATTENDED_DEFAULT]
prompt_value() {
    local prompt="$1" varname="$2" key="${3:-}" unattended_default="${4:-}"
    local value=""

    if unattended_mode; then
        _va_consume "$key" "$prompt"
        value="$(_va_lookup "$key")"
        [ -z "$value" ] && value="$unattended_default"
        if [ -n "$value" ]; then
            echo "${prompt}${value}  [unattended${key:+: $key}]"
        else
            echo "${prompt}(default)  [unattended${key:+: $key}]"
        fi
    else
        if ! read -p "$prompt" value; then
            _prompt_eof_fail "$prompt"
        fi
    fi
    eval "$varname=\"\$value\""
}

# prompt_secret PROMPT VAR [KEY] [UNATTENDED_DEFAULT]
# Masked entry with the "✓ Key entered: abcd****" feedback the installer prints.
prompt_secret() {
    local prompt="$1" varname="$2" key="${3:-}" unattended_default="${4:-}"
    local value=""

    if unattended_mode; then
        _va_consume "$key" "$prompt"
        value="$(_va_lookup "$key")"
        [ -z "$value" ] && value="$unattended_default"
        if [ -n "$value" ]; then
            echo "${prompt}(provided, ${#value} chars)  [unattended${key:+: $key}]"
        else
            echo "${prompt}(blank)  [unattended${key:+: $key}]"
        fi
    else
        if ! read -sp "$prompt" value; then
            echo
            _prompt_eof_fail "$prompt"
        fi
        echo  # newline after silent input
        if [ -n "$value" ]; then
            local len=${#value}
            local visible="${value:0:4}"
            if [ "$len" -le 4 ]; then
                echo -e "\033[0;32m  ✓ Key entered (${len} chars)\033[0m"
            else
                echo -e "\033[0;32m  ✓ Key entered: ${visible}$(printf '*%.0s' $(seq 1 $((len - 4))))\033[0m"
            fi
        fi
    fi
    eval "$varname=\"\$value\""
}

# read_secret PROMPT VAR — historical name kept for the scripts that used it;
# same as prompt_secret without an unattended key (callers pass the key
# explicitly through prompt_secret when they have one).
read_secret() {
    prompt_secret "$1" "$2" "${3:-}" "${4:-}"
}

# load_answers_file FILE — sources an answers file (KEY=value lines, bash
# syntax) exporting every variable, and switches to unattended mode.
load_answers_file() {
    local file="$1"
    if [ ! -f "$file" ]; then
        echo "ERROR: answers file not found: $file" >&2
        exit "$UNATTENDED_EXIT_CODE"
    fi
    set -a
    # shellcheck disable=SC1090
    source "$file"
    set +a
    export VERDIKTA_UNATTENDED=1
    VERDIKTA_UNATTENDED=1
}
