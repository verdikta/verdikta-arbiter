#!/bin/bash
# Live install metadata (installer/.contracts, installer/.env) vs the clone.
#
# The repository clone an upgrade runs from may be the very clone the node
# was installed from (the agents lane reuses ~/verdikta-arbiter), and then
# its installer/.contracts and installer/.env are the INSTALL-TIME snapshot.
# Copying those over the target's files erased everything written to the
# live copies since: AGGREGATOR_ADDRESS / CLASSES_ID /
# AGGREGATOR_REGISTRATION_ACTIVE from register-oracle.sh, RPC edits from
# update-rpc-endpoints.sh (issue #25). The live file is the truth.

# copy_if_missing SRC DST LABEL — copy only when DST does not exist.
# Prints what it did. Returns 0 in every non-error case.
copy_if_missing() {
    local src="$1" dst="$2" label="${3:-file}"
    if [ -f "$dst" ]; then
        echo "Keeping the live $label at $dst (the clone's copy is the install-time snapshot)."
        return 0
    fi
    if [ -f "$src" ]; then
        mkdir -p "$(dirname "$dst")"
        cp "$src" "$dst"
        echo "$label copied to $dst"
        return 0
    fi
    echo "$label not found at $src (nothing to copy)"
    return 0
}
