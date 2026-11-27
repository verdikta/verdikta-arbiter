# Dispatcher Registration

How an arbiter joins the Verdikta dispatcher, stays selectable, gets paid and leaves. This page
describes the **v2 dispatcher** (verdikta-dispatcher `beacon` branch: a new `ReputationKeeper`, a new
`ReputationAggregator` and `JuryBeacons`). v2 is a redeploy, not an upgrade: every arbiter registers
again, and its addresses are set at the v2 deployment. The v1 addresses in
[deployments.md](../../../docs/deployments.md) are v1 only; do not register a v2 node with them.

!!! note "Terms"
    - **Operator**: your `ArbiterOperator` contract (`OPERATOR_ADDR` in `installer/.contracts`).
      Its `owner()` is your wallet: it registers, exits and is paid.
    - **Job**: one Chainlink job of your node. Each job id is a separate arbiter.
    - **Key**: the keeper's id for one arbiter, `keyOf(operator, jobId)` =
      `keccak256(abi.encodePacked(operator, jobId))`, where `jobId` is the 32-character job id as
      bytes32 (its UTF-8 bytes). `query-oracle-classes.js` prints it.

## What you need

- **wVDKA for the stake**: the keeper's `stakeRequirement()` **per job id** (100 wVDKA by default),
  in the token the keeper names as `verdiktaToken()`. It is pulled from the wallet that registers.
- **The v2 aggregator address**, set at the v2 deployment. The scripts find the keeper through it
  (`keeper()`).
- **ETH on the node's key** for gas: commits, reveals and health answers are all sent from it.
- An operator deployed with request authorization (the installer's operator). Its owner must be the
  registering wallet (or the keeper owner registers for you).

## Register

The installer offers registration as its last step (`register-oracle-dispatcher.sh`). Afterwards, or
again later, run:

```bash
~/verdikta-arbiter-node/register-oracle.sh
```

It asks for the aggregator address and the class IDs (unattended: `VA_AGGREGATOR_ADDRESS`,
`VA_CLASS_IDS`; the fee is `VA_ORACLE_FEE_ETH`, default 0.00002 ETH) and runs
`arbiter-operator/scripts/register-oracle-cl.js`, which for each job:

1. **Checks the gate.** The aggregator must be approved by its keeper. If the operator does not yet
   list the v2 keeper, the script calls the operator's `addReputationKeeper(<v2 keeper>)` (only when
   the registering wallet owns the operator; otherwise it stops and the operator owner must do it).
   Without that call the operator refuses every v2 request.
2. **Checks the fee.** The fee is in ETH (no LINK anywhere), stored as a `uint64` in wei. A fee above
   the aggregator's `maxOracleFee()` (0.0004 ETH by default) is refused: such an arbiter could never be
   selected.
3. **Checks the stake** and approves `stakeRequirement() × (jobs not yet registered)` wVDKA to the
   keeper. Already registered jobs are skipped and cost nothing.
4. **Creates the job's hash chain** in `~/verdikta-arbiter-node/health-chains/<key>.json` and
   registers with `registerArbiter(operator, jobId, fee, classes, chainHead)`, the head of that chain.
5. **Records the registration** in `health-chains/registrations.json`, and `apply-health-jobs.sh
   --apply` then creates one Chainlink health job per registered job.

Rules the keeper enforces (`registerArbiter` reverts otherwise):

| Rule | Error |
|---|---|
| 1 to 5 classes per job | `BadClasses` |
| fee > 0, and the operator is a contract | `BadParams` |
| caller is the operator's `owner()` or the keeper owner | `NotArbiterOwner` |
| the key is not registered already (a banned key never can be again) | `AlreadyRegistered` |
| the stake transfer succeeds | `TransferFailed` (or the token's own revert) |

!!! warning "Back up `health-chains/`"
    The chain files hold the seeds the node answers health calls from. Back up the directory with the
    node's keys. A lost file is not fatal (the node re-syncs, below), but the arbiter is frozen until
    the re-sync completes.

!!! tip "Registering from a browser (head 0)"
    A browser cannot hold the hash chain, so it may register with `chainHead = 0`. The arbiter then
    starts frozen, in re-sync, with a health call pending. To let the node answer, run
    `register-oracle.sh` on the node with the same aggregator: it skips the registered jobs, records
    them in `registrations.json` and creates their health jobs. The first health answer installs a
    fresh chain, and the arbiter is selectable once the re-sync below has completed.

A new job id is a new arbiter. Regenerating the node's jobs (an upgrade that changes the job
template, or a new arbiter count) gives new ids, so `upgrade-arbiter.sh` refuses it on a registered
node: exit first (see [Upgrading](../maintenance/upgrading.md)).

## Health calls

The keeper sends a **health call** (`HealthCall(key, sentAt)`) to every juror it selects, to 3 other
arbiters of each shortlist (`liveRandom`), to each beacon it picks, and when the keeper owner sends
them (`sendHealthCalls`). The arbiter must answer within the keeper's `callDeadline` (60 s) with the
next value of its hash chain. Otherwise it is **frozen**: not selectable, until it answers.

The node does this without you:

- **The health job** (`chainlink-node/healthJobSpec`, one cron job per registered job) runs every
  10 s. It reads `healthState(key)` (pending, sent at, current head) with one `ethcall` and, while a
  call is pending, asks the External Adapter over the `verdikta-ai` bridge for the value.
- **The adapter** answers from `health-chains/<key>.json`. The job sends `rotateChain(key, preimage,
  newHead)` from the node's key (an authorized sender of the operator). With `newHead == preimage`
  that is a plain answer; 1,000 values before a chain ends the adapter installs a new chain in the
  same transaction.
- **Re-sync.** If the keeper's head is on none of the node's chains (registered with head 0, or the
  file lost) or the chain is used up, the adapter answers with the head of a fresh chain. The keeper
  adopts it (`ChainResynced(key)`) and freezes the arbiter until it answers a call sent after the
  re-sync. The job's next answer sends that call and the one after answers it, so the job alone
  recovers in three transactions. An unreadable chain file stops the adapter instead: restore it
  (mode 0600) or remove it.
- **Stale reads.** The job reads the head over RPC, and a lagging RPC can show a head the keeper has
  moved past. The adapter keeps the previous chain for a day after the keeper switches to a new one
  (a rotation or a re-sync), so such a head is still recognised, and it skips a head behind the last
  one it answered (or one a landed re-sync replaced) for up to 25 s instead of answering it. Still
  there after that, the head is real (a reorg): it is answered as usual, or, if it is more than 2
  values behind the last answer on the same chain, the adapter re-syncs onto a fresh chain. The
  keeper reverts a re-sent answer (`StaleAnswer`, `BadPreimage`), so a stale answer costs only gas.
- **Values handed out.** The file also records the highest value handed out on each chain and the
  last head answered, saved before each answer. A head beyond every value handed out (a chain file
  restored from an old backup, or a leaked seed) is never answered from: that chain is abandoned and
  the adapter re-syncs onto a fresh one. Anyone holding the bridge token (`EA_API_TOKEN`) can still
  step the chain ahead of the keeper one value at a time; the node's own reads then look stale and
  end in a re-sync, which exposes no further values. Keep the token secret.

A frozen arbiter is not scored for a round it did not commit in (being down costs it selection, not
points), but it is if it committed: a commit proves the node was up. Freezing is judged at the
round's deadline.

### Monitoring

```bash
~/verdikta-arbiter-node/arbiter-doctor.sh            # cfg.health_chains, svc.health_jobs
~/verdikta-arbiter-node/apply-health-jobs.sh --check # every registered job has a current health job
cd ~/verdikta-arbiter-node/arbiter-operator
HARDHAT_NETWORK=base_sepolia node scripts/query-oracle-classes.js \
  --aggregator <v2 aggregator> --oracle <OPERATOR_ADDR> --jobid <job id without hyphens>
```

`query-oracle-classes.js` prints the keeper's view of one job: flags, classes, quality and
timeliness, offenses and `blockedUntil`, fee, stake, the health-call state, `frozen`, the head and,
while exiting, when `completeExit` is allowed. The keeper views behind it are `getArbiter(key)`,
`healthState(key)`, `isFrozen(key)`, `isEligible(key, maxFee)` and `arbiterClasses(key)`.

To end a freeze without waiting for the next selection, the operator owner or an authorized sender can
call `requestHealthCall(key)`; the health job then answers it. No installer script wraps this call
(for example: `cast send <keeper> 'requestHealthCall(bytes32)' <key>`).

## Being selected

At each request the keeper walks the request's class in random order and shortlists up to 60
eligible arbiters. **Eligible** means registered and not paused, banned, exiting, under-staked
(stake below `stakeRequirement()`), blocked or frozen, with a fee at or below the request's ceiling
(the requester's `maxFee`, capped at `maxOracleFee()`). From the shortlist it draws the jury, weighted
by reputation (quality and timeliness, blended by the request's `alpha`) and by fee: a lower fee gets
more weight, but a fee below the request's floor (`minFee`) gets no more than the floor does.

**A thin pool repeats arbiters.** With fewer eligible arbiters than the jury size, every eligible one
is drawn and the remaining slots repeat them, so one job can fill several slots of a round. It gets
one request per slot and is paid and scored once per slot. Selection fails only when no arbiter is
eligible.

## Commit and reveal

The node needs no setting for this; the External Adapter implements the v2 formats:

- **Commit** (`cid` = `1:<cids>[:addendum]`): the node answers with
  `keccak256(abi.encode(aggId, operator, response, salt))`, all 32 bytes, with a fresh 128-bit salt.
  (v1 sent 16 bytes of a SHA-256 without the round; a v1-format commit can never be revealed in v2.)
- **Reveal** (`cid` = `2:<64 hex>`, the full commit hash): the node answers with its scores and
  `<justification cid>:<32 hex salt>`. A request takes one answer: there is no retry.
- **Gas.** The reveal that completes a round pays for aggregating it (up to about 7M gas at the largest
  juries and answers), so the job's transaction gas limit is 9M; `upgrade-arbiter.sh` applies it to
  live jobs.

## Jury beacons

Some requests (the Jumbo class preset) draw their jury from **beacons**: 4 arbiters of the class get a
health call, and the first 2 values revealed within 120 s seed the draw. A beacon call is an ordinary
health call and the health job answers it; no other code or setting is needed. Answering fast matters:
a used beacon is paid one fee, and a beacon that misses the 60 s deadline is also frozen.

## Earnings

Fees are in ETH and accrue in the **aggregator**, as `ethOwed[<operator owner>]`:

- **Base fee**: for each slot the job fills, `max(your fee, the request's minFee)`, credited when the
  request is dispatched to your operator.
- **Bonus**: `bonusMultiplier` (3 by default) × that fee, for each revealed answer in the cluster
  that decides the round.
- **Beacon fee**: `max(the request's fee ceiling, minFee)` for each beacon value of yours that was used.
- **Committer share**: when a round got at least M commits but nobody promoted it before its deadline, its
  unspent prepay is split equally among the slots that committed, at settlement
  (`CommitPayment(aggId, payee, amount)`, one event per committed slot). The requester gets none of it back,
  so withholding the promotion buys it no re-roll.
- **Arbiter pool**: the prepay of rounds that end without a refund for other reasons (a cancelled undrawn
  round, a missed beacon quorum, a draw that failed after the beacon stage when the outcome could depend on
  the seed, and the indivisible remainder of a committer share) goes to a pool in the aggregator,
  `ethOwed(address(0))`, that nobody can withdraw. Each jury draw pays an eighth of the pool to one
  registered arbiter, picked at random by the keeper's `poolPayee(seed)` from the draw's seed
  (`PoolPayment(aggId, payee, amount)`). You are eligible while registered and not paused, banned, exiting
  or understaked; you need not be drawn for the round. The pick makes at most two tries, and if both land
  on ineligible arbiters nobody is paid and the pool waits for the next draw.

The aggregator does not send it: the operator owner withdraws it with the aggregator's `withdrawEth()`
(or the aggregator owner calls `withdrawEthFor(owner)` for it). Read the balance with `ethOwed(owner)`. No
installer script wraps these (for example: `cast send <aggregator> 'withdrawEth()'` from the owner's
wallet). `recover-chainlink-funds.sh` moves ETH (and any legacy LINK) off the node's keys; it does not
touch `ethOwed`.

## Scores and penalties

Each arbiter has two scores, **quality** and **timeliness**, from 0 to 1,000 (`cap`), starting at 500
(`start`). They change when a round settles (owner-settable `points`):

| Outcome in a round | Timeliness | Quality |
|---|---|---|
| Promoted and revealed (even late) | +20 | by distance from the result: close +20, off −50, far −200 (finished rounds only) |
| Promoted, no reveal, round finished | −200 | |
| Promoted, no reveal, round failed | −500 | |
| Sent the job, no commit, and the round failed for lack of commits, though at least half of M committed | −400 | |
| Committed but not promoted, a round in which fewer than half of M committed (the request's or a shared outage's failure), a slot never sent the job, or anything else | 0 | 0 |

A score that reaches 0 restarts at 500 and **blocks** the arbiter (not selectable) for
`lockDuration` (24 h) × 2^offenses. One offense is forgiven per 90 clean days (`decayPeriod`). The
3rd block (`maxOffenses`) is a permanent **ban**: the key can never register again. A block may also
burn stake (`burnPerBlock`, 0 by default; the whole stake on a ban only if `burnOnBan` is set). A
stake left below the requirement makes the arbiter ineligible until topped up with
`topUpStake(key, amount)`.

## Pause, fee changes and exit

| Action | Keeper call (operator owner or keeper owner) | Script |
|---|---|---|
| Stop being selected for a while | `setPaused(key, true)`; `setPaused(key, false)` to resume | none |
| Change the posted fee | `setFee(key, fee)` (wei, > 0) | none |
| Add stake | `topUpStake(key, amount)` (wVDKA approved to the keeper first) | none |
| Leave and get the stake back | `requestExit(key)`, then `completeExit(key)` after `unbondingPeriod` | `unregister-oracle.sh` |

To leave, run:

```bash
~/verdikta-arbiter-node/unregister-oracle.sh
```

The first run calls `requestExit` for each job: it stops being selectable at once, but its stake
stays bonded for the keeper's `unbondingPeriod` (2 days by default, never less), and blocks and bans
still apply. Run it again after that: it calls `completeExit`, which refunds the remaining stake to the
operator's `owner()` and frees the job's class slots. Each run does whichever step is due and prints
when the next one is. `completeExit` reverts with `StillBonded` before the period ends and with
`Blocked` while the arbiter is blocked; a frozen arbiter can exit. A second `requestExit` reverts with
`AlreadyExiting`. Keep the node and its health jobs running until the exit is complete; delete the
health jobs in the Chainlink UI afterwards.

A key that exits and registers again keeps its scores and offenses, and takes its classes from the
new registration.

!!! note "v1"
    v1 used `registerOracle`, `deregisterOracle` and `setOracleActive`, with no hash chain or health
    calls. Those calls do not exist in v2. Scripts and docs that use them are for the v1 deployment.
