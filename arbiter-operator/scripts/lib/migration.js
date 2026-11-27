/* What an operator migration needs to know before it starts, and what must be true when it
 * is done (installer/bin/migrate-operator.sh; scripts/operator-migration.js is the Hardhat
 * side). A node whose ArbiterOperator predates request authorization moves to a new
 * contract: every registration is on (operator, job id), so each job is deregistered from
 * the old contract and registered again on the new one, and the keeper's registry, not
 * installer/.contracts, says what those registrations are: which job ids, on which classes,
 * at what fee, with how much stake, locked until when.
 *
 * No ethers here: contracts are passed in (ethers Contracts in the script, fakes in
 * installer/tests/operator-migration.test.cjs), so the rules are tested without a chain.
 */
const { toBytes32, jobIdText, isRegistered, listRegisteredJobs } = require("./registry.js");

const lower = (address) => String(address).toLowerCase();
const DEFAULT_STAKE = 100n * 10n ** 18n;
// One deployment (3.5M gas limit in deploy.js), the senders, a keeper on the operator, an
// approval and a registration per job; deregistrations come first and are counted too.
const gasBudget = (jobs) => 3_500_000n + 200_000n + 150_000n + 100_000n + 450_000n * BigInt(jobs) + 250_000n * BigInt(jobs);

function formatUnits(wei, decimals = 18) {
  const value = BigInt(wei), base = 10n ** BigInt(decimals);
  const fraction = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${value / base}${fraction ? `.${fraction}` : ""}`;
}

/* The plan: everything read, nothing sent.
 *
 *   nodeJobIds   the node's own job ids (installer/.contracts), as text. A registration the
 *                keeper holds for another id of this operator is an orphan: it is
 *                deregistered with the rest (its stake comes back) and not registered again.
 *
 * `problems` are reasons not to start; an empty list means the migration can run. */
async function readPlan({ provider, signerAddress, operator, operatorAddress, aggregator, aggregatorAddress, keeper, keeperAddress, token, nodeJobIds = [], now = Math.floor(Date.now() / 1000), readOptions = {} }) {
  const problems = [], notes = [];
  const owner = await operator.owner();
  if (lower(owner) !== lower(signerAddress)) {
    problems.push(`the key in installer/.env is ${signerAddress}, and the operator contract's owner is ${owner}: only the owner can deregister its jobs and get the stake back`);
  }
  if (!await keeper.isContractApproved(aggregatorAddress)) {
    problems.push("the ReputationKeeper does not approve the aggregator in installer/.contracts (AGGREGATOR_ADDRESS): it is not the live dispatcher, and a new operator registered through it would be sent nothing");
  }
  const senders = [...await operator.getAuthorizedSenders()].map(String);
  if (senders.length === 0) problems.push("the operator contract authorizes no node key (getAuthorizedSenders is empty), so there is nothing to carry over to the new one");

  let stakeRequirement = DEFAULT_STAKE;
  try { stakeRequirement = BigInt(await keeper.STAKE_REQUIREMENT()); } catch { /* an older keeper: 100 */ }

  const registered = await listRegisteredJobs(keeper, operatorAddress, readOptions);
  const mine = new Set(nodeJobIds.map((id) => toBytes32(id)));
  const jobs = [];
  for (const id of registered) {
    const info = await keeper.getOracleInfo(operatorAddress, id);
    if (!isRegistered(info)) continue;
    const classes = [...await keeper.getOracleClassesByKey(operatorAddress, id)].map((c) => Number(c));
    const fee = info.fee === undefined ? info[5] : info.fee;
    const stake = info.stakeAmount === undefined ? info[6] : info.stakeAmount;
    const lockedUntil = Number(info.lockedUntil === undefined ? info[7] : info.lockedUntil);
    jobs.push({ id: jobIdText(id), bytes32: id, classes, feeWei: BigInt(fee).toString(), stakeWei: BigInt(stake).toString(), lockedUntil, ofThisNode: mine.has(id) });
    if (lockedUntil > now) {
      problems.push(`job ${jobIdText(id)} is locked on the keeper until ${new Date(lockedUntil * 1000).toISOString()}: it cannot be deregistered before then`);
    }
  }
  const moving = jobs.filter((job) => job.ofThisNode);
  const orphans = jobs.filter((job) => !job.ofThisNode);
  for (const job of orphans) notes.push(`job ${job.id} is registered for this operator and is not a job of this node: it is deregistered (its stake is refunded) and not registered again`);
  const unregistered = nodeJobIds.filter((id) => !registered.includes(toBytes32(id)));
  for (const id of unregistered) notes.push(`job ${id} of this node is not registered on the keeper: it is moved to the new operator and left unregistered, as it is now`);
  if (moving.length === 0) notes.push("none of this node's jobs is registered: the migration deploys the new operator and moves the jobs, and registers nothing");

  /* Jobs registered alike are registered again in one run: same classes, same fee. */
  const groups = [];
  for (const job of moving) {
    const classes = job.classes.join(","), feeEth = formatUnits(job.feeWei);
    let group = groups.find((g) => g.classes === classes && g.feeEth === feeEth);
    if (!group) groups.push(group = { classes, feeEth, jobIds: [] });
    group.jobIds.push(job.id);
    if (job.classes.length === 0) problems.push(`the keeper names no class for job ${job.id}`);
  }

  const refund = jobs.reduce((sum, job) => sum + BigInt(job.stakeWei), 0n);
  const tokenBalance = BigInt(await token.balanceOf(signerAddress));
  const stakeNeeded = stakeRequirement * BigInt(moving.length);
  if (tokenBalance + refund < stakeNeeded) {
    problems.push(`re-registering ${moving.length} job(s) takes ${formatUnits(stakeNeeded)} wVDKA; the owner holds ${formatUnits(tokenBalance)} and the deregistration refunds ${formatUnits(refund)} (a slashed job gives back less than it takes): ${formatUnits(stakeNeeded - tokenBalance - refund)} short`);
  }

  const feeData = await provider.getFeeData();
  const gasPrice = BigInt(feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n);
  const ethNeeded = gasBudget(jobs.length) * gasPrice * 12n / 10n;
  const ethBalance = BigInt(await provider.getBalance(signerAddress));
  if (ethBalance < ethNeeded) {
    problems.push(`the owner holds ${formatUnits(ethBalance)} ETH, and the migration's transactions may take up to ${formatUnits(ethNeeded)} at the current gas price`);
  }

  let responseTimeoutSeconds = 300;
  try { responseTimeoutSeconds = Number(await aggregator.responseTimeoutSeconds()); } catch { /* an older aggregator: its 5 minutes */ }

  return {
    signer: signerAddress, operator: operatorAddress, operatorOwner: owner, aggregator: aggregatorAddress, keeper: keeperAddress,
    senders, jobs, groups, orphans: orphans.map((job) => job.id), unregistered,
    tokenBalance: formatUnits(tokenBalance), refund: formatUnits(refund), stakeNeeded: formatUnits(stakeNeeded),
    ethBalance: formatUnits(ethBalance), ethNeeded: formatUnits(ethNeeded), responseTimeoutSeconds, problems, notes,
  };
}

/* The new operator, before anything is pointed at it: this release's contract, owned by the
 * key that deployed it, with nothing configured yet. */
async function checkDeployment({ operator, signerAddress }) {
  const problems = [];
  let version = null;
  try { version = await operator.requestAuthorizationVersion(); } catch { /* not this release's contract */ }
  if (version !== 1n) problems.push("the deployed contract does not report request authorization v1");
  const owner = await operator.owner();
  if (lower(owner) !== lower(signerAddress)) problems.push(`the deployed contract's owner is ${owner}, not the deploying key ${signerAddress}`);
  return problems;
}

/* The end state. `expectedJobIds`: the jobs that were registered and are this node's.
 * `anonymousRequestReverts`: async () => boolean, a simulated request from an address no
 * keeper approves (the script builds the call; it is the hole the migration closes). */
async function verifyMigration({ signerAddress, oldOperatorAddress, newOperator, newOperatorAddress, aggregatorAddress, keeper, keeperAddress, senders = [], expectedJobIds = [], anonymousRequestReverts, readOptions = {} }) {
  const problems = [...await checkDeployment({ operator: newOperator, signerAddress })];
  const authorized = new Set([...await newOperator.getAuthorizedSenders()].map(lower));
  for (const sender of senders) if (!authorized.has(lower(sender))) problems.push(`node key ${sender} is not an authorized sender of the new operator: its answers would revert`);
  const expected = expectedJobIds.map((id) => toBytes32(id));
  if (expected.length > 0) {
    if (!await newOperator.isReputationKeeper(keeperAddress)) problems.push("the new operator does not list the ReputationKeeper: it refuses every request");
    else if (!await newOperator.isRequesterApproved(aggregatorAddress)) problems.push("the new operator does not approve the aggregator: it refuses the dispatcher's requests");
  }
  const onNew = await listRegisteredJobs(keeper, newOperatorAddress, readOptions);
  for (const id of expected) if (!onNew.includes(id)) problems.push(`job ${jobIdText(id)} is not registered on the new operator`);
  for (const id of onNew) if (!expected.includes(id)) problems.push(`job ${jobIdText(id)} is registered on the new operator and was not on the old one`);
  const onOld = await listRegisteredJobs(keeper, oldOperatorAddress, readOptions);
  if (onOld.length > 0) problems.push(`${onOld.length} job id(s) are still registered on the old operator, with their stake: ${onOld.map(jobIdText).join(", ")}`);
  if (anonymousRequestReverts && !await anonymousRequestReverts()) problems.push("a request from an unapproved address was not refused by the new operator");
  return { problems, registered: onNew.map(jobIdText) };
}

module.exports = { readPlan, checkDeployment, verifyMigration, formatUnits, gasBudget };
