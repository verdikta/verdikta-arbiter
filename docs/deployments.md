# Deployed Contract Addresses

Canonical contract addresses for each supported network.

> **Note:** The majority of Verdikta smart contracts (dispatcher, client, aggregator) live in the
> [verdikta-dispatcher](https://github.com/verdikta/verdikta-dispatcher) repository.
> This document covers contracts deployed from the **verdikta-arbiter** repo.

## LINK Token Addresses (Third-Party)

These are the official Chainlink LINK token contracts used by Verdikta on each network.

| Network | Address | Explorer |
|---|---|---|
| Base Sepolia | `0xE4aB69C077896252FAFBD49EFD26B5D171A32410` | [BaseScan Sepolia](https://sepolia.basescan.org/address/0xE4aB69C077896252FAFBD49EFD26B5D171A32410) |
| Base Mainnet | `0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196` | [BaseScan](https://basescan.org/address/0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196) |
| Sepolia (Ethereum) | `0x779877A7B0D9E8603169DdbD7836e478b4624789` | [Etherscan](https://sepolia.etherscan.io/address/0x779877A7B0D9E8603169DdbD7836e478b4624789) |

## Verdikta dispatcher contracts (what `register-oracle.sh` registers with)

Read back on-chain 2026-09-14 (`cast call <aggregator> 'reputationKeeper()(address)'`,
then `cast call <keeper> 'verdiktaToken()(address)'`). The aggregator is the address you pass
as `--aggregator` / `VA_AGGREGATOR_ADDRESS`; the keeper is what actually pulls the 100 wVDKA
stake, so **the wVDKA you hold must be the keeper's `verdiktaToken()`** — a stale aggregator
approves the wrong token and reverts.

| Network | Aggregator (dispatcher) | ReputationKeeper | Wrapped VDKA (`verdiktaToken()`) |
|---|---|---|---|
| Base Sepolia | `0xe8a385E473EA710c5a88Cc72681a16a26fe380e4` | `0xE09821277D9af702F7910a57e85EaC6D83e4d794` | `0x94e3c031fe9403c80E14DaFbCb73f191C683c2B1` |
| Base Mainnet | `0xd8F38bCBEE43bE3bd31655a563f20c9B3e67142a` | `0x2D96cc4F6619d08FC14b7ee0eec02d1F3eE1d0b0` | `0x1EA68D018a11236E07D5647175DAA8ca1C3D0280` |

The live values are also served per owner by the status page:
`https://arbiters.verdikta.org/api/arbiters/owned?owner=<address>` returns `aggregatorAddress`
and `keeperAddress` for the network it tracks.

### Retired (do not register with these)

| Network | Aggregator | ReputationKeeper | Wrapped VDKA | Why it is here |
|---|---|---|---|---|
| Base Sepolia | `0x262f48f06DEf1FE49e0568dB4234a3478A191cFd` | `0x89E57080822fa64A808Ace0a06c4429Ea22e6ce8` | `0x2F1d1aF9d5C25A48C29f56f57c7BAFFa7cc910a3` | Earlier deployment. This document listed it as current until 2026-09-14; the first agent-driven registration copied it from here, approved 100 wVDKA to the retired keeper and reverted (verdikta/verdikta-agents#281). |

Each arbiter's own `ArbiterOperator` address is per install (`installer/.contracts` → `OPERATOR_ADDR`),
not a shared contract, so it is not listed here.

## Updating This Document

When deploying new contracts:

1. Record the deployment transaction hash.
2. Update the table above with the new address and link.
3. Update `arbiter-operator/deployment-addresses.json` (LINK) and the wVDKA constants in `installer/bin/register-oracle-dispatcher.sh`, `installer/util/register-oracle.sh`, `installer/util/unregister-oracle.sh` to stay in sync.
4. Commit both changes in the same PR.
