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

## Verdikta Contracts (Base Sepolia — Testnet)

| Contract | Address | Notes |
|---|---|---|
| Aggregator | `0x262f48f06DEf1FE49e0568dB4234a3478A191cFd` | Dispatcher aggregator |
| ArbiterOperator | `0xD67D6508D4E5611cd6a463Dd0969Fa153Be91101` | Chainlink operator |
| Wrapped VDKA | `0x2F1d1aF9d5C25A48C29f56f57c7BAFFa7cc910a3` | Wrapped Verdikta token |
| Wrapped VDKA (Mainnet) | `0x1EA68D018a11236E07D5647175DAA8ca1C3D0280` | Wrapped Verdikta token on Base Mainnet |

## Updating This Document

When deploying new contracts:

1. Record the deployment transaction hash.
2. Update the table above with the new address and link.
3. Update `arbiter-operator/deployment-addresses.json` to stay in sync.
4. Commit both changes in the same PR.
