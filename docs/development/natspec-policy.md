# NatSpec Documentation Policy

## Scope

This policy applies to **Verdikta-authored Solidity contracts** in this repository and in the
[verdikta-dispatcher](https://github.com/verdikta/verdikta-dispatcher) repository.

Third-party or vendored interfaces (e.g., Chainlink `OperatorInterface.sol`,
`LinkTokenInterface.sol`, `OracleInterface.sol`) are excluded.

Test fixtures (files inside `__tests__` or `test` directories) are excluded.

## Minimum Requirements

Every Verdikta-authored contract and public/external function **must** include:

1. **Contract-level** `@title` and `@notice` tags.
2. **Function-level** `@notice` for every `public` / `external` function.
3. **`@param`** tag for every function parameter.
4. **`@return`** tag for every named or unnamed return value.
5. **`@dev`** tag when implementation details are non-obvious (e.g., reentrancy guards, gas optimizations, trust assumptions).

## Example

```solidity
/// @title ArbiterOperator
/// @notice Chainlink Operator extended with Verdikta-specific authorization logic.
contract ArbiterOperator is Operator {
    /// @notice Authorize a list of sender addresses to call this operator.
    /// @param senders Addresses to authorize.
    function setAuthorizedSenders(address[] calldata senders) external onlyOwner {
        // ...
    }
}
```

## Enforcement

- Reviewers should verify NatSpec compliance during PR review for any `.sol` file diff.
- A future CI lint step (e.g., `solhint` with `natspec` rules) may automate enforcement.

## Current Status (verdikta-arbiter)

| Contract | NatSpec Compliant |
|---|---|
| `arbiter-operator/contracts/ArbiterOperator.sol` | Yes |
| `chainlink-node/MyOperator.sol` | No (third-party reference — excluded) |
| `chainlink-node/MyQuery.sol` | Partial (reference contract — excluded) |
| `external-adapter/FixedOperator.sol` | Partial |
| `external-adapter/fixed-operator/FixedOperator.sol` | Partial |
| Interfaces under `external-adapter/interfaces/` | N/A (third-party — excluded) |
| Test fixtures | N/A (excluded) |
