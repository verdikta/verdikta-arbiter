// Called before stake approval/registration, including when all jobs are active.
const OperatorAuthorizationABI = [
  'function requestAuthorizationVersion() view returns (uint256)',
  'function owner() view returns (address)',
  'function isReputationKeeper(address) view returns (bool)',
  'function addReputationKeeper(address)',
  'function isRequesterApproved(address) view returns (bool)',
  'function isReputationKeeperListEmpty() view returns (bool)',
];

// A contract's own refusal (the function is not there, or it reverted), as against an RPC
// that failed. ethers reports it as CALL_EXCEPTION; Hardhat's provider, which these scripts
// run on, as a ProviderError with the node's own code 3 and "execution reverted" (measured
// on Base, 2026-11: with the ethers codes alone a legacy operator's missing function was
// taken for an RPC failure).
const contractRefused = error => Boolean(error) && (['CALL_EXCEPTION', 'BAD_DATA'].includes(error.code) || error.code === 3
  || /execution reverted/i.test(String(error.message || '')));

async function ensureRequestAuthorization({ operator, keeper, keeperAddress, aggregatorAddress, signerAddress,
  sendWithRetry = async (_label, send) => send(), log = console.log }) {
  let version;
  try { if (typeof operator.requestAuthorizationVersion === 'function') version = await operator.requestAuthorizationVersion(); } catch (error) {
    // Only the contract's own refusal means "legacy": after an RPC failure a v1 operator
    // would be registered without its keeper, and would then deny every request.
    if (!contractRefused(error)) throw error;
  }
  if (version !== 1n) {
    // An ArbiterOperator from before request authorization. It keeps its registrations, so
    // that a job count or a class can still change: the node's jobs ask the keeper about
    // each requester (installer/util/job-template.cjs), and the contract is replaced by
    // installer/bin/migrate-operator.sh. Its keeper list is left as it is. Anything else
    // that lacks the version is not an operator this script registers.
    let legacy = false;
    try { legacy = typeof operator.isReputationKeeperListEmpty === 'function' && typeof await operator.isReputationKeeperListEmpty() === 'boolean'; } catch (error) {
      if (!contractRefused(error)) throw error;
    }
    if (!legacy) throw new Error('Operator requires request-authorization v1. Deploy the hardened operator and migrate its jobs before registration.');
    if (!await keeper.isContractApproved(aggregatorAddress)) {
      throw new Error('The selected aggregator is not approved by its ReputationKeeper. Ask the keeper owner to approve it before registration.');
    }
    log('Note: this operator contract predates request authorization. Its jobs must be this release\'s (node job-template.cjs check); migrate the contract with installer/bin/migrate-operator.sh.');
    return;
  }
  // The explicitly selected aggregator chooses the keeper. Never self-approve
  // an aggregator: that decision belongs to the keeper owner.
  if (!await keeper.isContractApproved(aggregatorAddress)) {
    throw new Error('The selected aggregator is not approved by its ReputationKeeper. Ask the keeper owner to approve it before registration.');
  }
  if (!await operator.isReputationKeeper(keeperAddress)) {
    if ((await operator.owner()).toLowerCase() !== signerAddress.toLowerCase()) {
      throw new Error('The operator owner must configure the selected ReputationKeeper before registration.');
    }
    log(`Adding the selected aggregator's ReputationKeeper to the operator: ${keeperAddress}`);
    await sendWithRetry('addReputationKeeper', async () => {
      // Recheck after an RPC retry in case the previous transaction was mined.
      if (!await operator.isReputationKeeper(keeperAddress)) {
        await (await operator.addReputationKeeper(keeperAddress)).wait();
      }
    });
  }
  if (!await operator.isRequesterApproved(aggregatorAddress)) {
    throw new Error('The operator does not authorize the selected aggregator. Registration stopped before stake approval.');
  }
}

module.exports = { ensureRequestAuthorization, OperatorAuthorizationABI, contractRefused };
