#!/bin/bash
# The stake-attestation build lands its node PRs in the integration branch
# claude/stake-attestation, not main, so the arbiter's CI must run on PRs into
# (and pushes to) that branch too — issue #105. This pins those triggers, the
# e2e path filter, and the parts that must not move: the nightly L4, the
# dispatch inputs, and the fork-PR secret gates.
# Run: bash .github/tests/workflow-triggers.test.sh   (needs ruby for YAML)
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WF="$ROOT/.github/workflows"
INTEGRATION=claude/stake-attestation
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }

# q FILE EXPR -> EXPR evaluated in Ruby against the parsed workflow, as JSON.
# `w` is the workflow, `on` its triggers (YAML 1.1 reads the key `on` as true).
q() {
    ruby -ryaml -rjson -e 'w = YAML.safe_load(File.read(ARGV[0])); on = w["on"] || w[true] || {}
puts JSON.generate(eval(ARGV[1]))' "$WF/$1" "$2"
}
is() { # is FILE EXPR EXPECTED_JSON MESSAGE
    local got; got=$(q "$1" "$2" 2>&1)
    [ "$got" = "$3" ] && ok || bad "$1: $4 (got $got)"
}

for f in e2e.yml repo-policy.yml secret-scan.yml code-runner.yml; do
    [ -f "$WF/$f" ] && ok || { bad "$f is missing"; continue; }
    for ev in pull_request push; do
        for b in main master "$INTEGRATION"; do
            is "$f" "on.dig('$ev', 'branches').to_a.include?('$b')" true "$ev does not run for branch $b"
        done
    done
    # pull_request_target runs fork code with the base repository's secrets.
    is "$f" "on.key?('pull_request_target')" false "uses pull_request_target"
    is "$f" "w['permissions']" '{"contents":"read"}' "token permissions changed"
done

# The policy and secret scans run on every PR, whatever it touches.
for f in repo-policy.yml secret-scan.yml; do
    for ev in pull_request push; do
        is "$f" "(on['$ev'] || {}).keys & ['paths', 'paths-ignore', 'branches-ignore']" '[]' "$ev has a path or branch-ignore filter"
    done
done

# e2e: the path filter covers the existing components plus code-runner and
# testing-tool (the stake-attestation runner and the claim scenarios), and is
# the same for PRs and pushes.
for ev in pull_request push; do
    for p in 'e2e/**' 'external-adapter/**' 'ai-node/**' 'code-runner/**' 'testing-tool/**' '.github/workflows/e2e.yml'; do
        is e2e.yml "on.dig('$ev', 'paths').to_a.include?('$p')" true "$ev paths miss $p"
    done
done
is e2e.yml "on.dig('pull_request', 'paths') == on.dig('push', 'paths')" true "pull_request and push path filters differ"

# code-runner: its unit and Docker jobs run for every change to code-runner/.
for ev in pull_request push; do
    for p in 'code-runner/**' '.github/workflows/code-runner.yml'; do
        is code-runner.yml "on.dig('$ev', 'paths').to_a.include?('$p')" true "$ev paths miss $p"
    done
done
is code-runner.yml "w['jobs'].keys" '["unit","docker"]' "jobs added or removed (check their secret gates)"
is code-runner.yml "w.dig('jobs', 'docker', 'strategy', 'matrix', 'runtime')" '["runc","runsc"]' "Docker tests no longer run under both runtimes"

# Unchanged: the nightly L4 and the dispatch inputs.
is e2e.yml "on['schedule']" '[{"cron":"0 7 * * *"}]' "nightly schedule changed"
is e2e.yml "on.dig('workflow_dispatch', 'inputs').map { |k, v| [k, v['type'], v['default']] }" \
    '[["run_l4","boolean",false],["class_id","string","5555"],["expect_common","string",""],["expect_release","string",""],["scenario","string",""]]' \
    "dispatch inputs changed"
is e2e.yml "w.dig('jobs', 'l4-testnet', 'if')" \
    "\"github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && inputs.run_l4)\"" \
    "L4 now runs on other events"
is e2e.yml "w.dig('jobs', 'l4-testnet', 'environment')" '"e2e"' "L4 left the e2e environment"

# Unchanged: secrets stay out of fork PRs. L2 is the only PR job that reads one.
is e2e.yml "w.dig('jobs', 'l2-mock', 'if')" \
    "\"github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository\"" \
    "L2's same-repo gate changed"
is e2e.yml "w['jobs'].keys" '["l2-mock","l4-testnet"]' "jobs added or removed (check their secret gates)"

echo "pass=$pass fail=$fail"; [ "$fail" = "0" ]
