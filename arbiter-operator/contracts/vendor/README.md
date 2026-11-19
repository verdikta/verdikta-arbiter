# Pinned Chainlink Operator adaptation

`Operator.sol` is the MIT-licensed file from the published
`@chainlink/contracts@1.4.0` package:
`src/v0.8/operatorforwarder/Operator.sol`.
Original file SHA-256:
`581105b56dac6fbdb575cfa00142b616a7f345a56425a914b61dd775f4075a81`.

Upstream's external request entry points and ERC-677 receiver are not virtual.
Checking only fulfillment lets unauthorized requests start paid off-chain work.
This adaptation exposes the shared admission hook after the real payment token
has authenticated and overwritten the payload's sender/payment fields.

The entire diff from the published file is:

1. Resolve relative imports through the pinned npm package.
2. Make `s_commitments` internal for the exact pending-request view.
3. Make `_verifyAndProcessOracleRequest` internal virtual.
4. Make `_verifyOracleRequestAndProcessPayment` virtual.

The upstream function bodies, layout, token receiver, escrow, cancellation,
authorized senders and ownership remain unchanged. Policy lives in
`../ArbiterOperator.sol`. `test/vendor.test.js` verifies the source hash and exact
allowed diff; do not weaken that test to accommodate an unreviewed update.
Pin and review both this file and its imported dependencies when upgrading.

This is a new deployment, not a storage-compatible upgrade mechanism. Existing
operators are not proxies. See [migration guidance](../../../docs/development/request-authorization.md).
