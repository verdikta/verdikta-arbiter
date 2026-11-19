// Called before stake approval/registration, including when all jobs are active.
const OperatorAuthorizationABI = [
  'function requestAuthorizationVersion() view returns (uint256)',
  'function owner() view returns (address)',
  'function isReputationKeeper(address) view returns (bool)',
  'function addReputationKeeper(address)',
  'function isRequesterApproved(address) view returns (bool)',
];

async function ensureRequestAuthorization({ operator, keeper, keeperAddress, aggregatorAddress, signerAddress,
  sendWithRetry = async (_label, send) => send(), log = console.log }) {
  let version;
  try { version = await operator.requestAuthorizationVersion(); } catch { /* legacy operator */ }
  if (version !== 1n) throw new Error('Operator requires request-authorization v1. Deploy the hardened operator and migrate its jobs before registration.');
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

module.exports = { ensureRequestAuthorization, OperatorAuthorizationABI };
