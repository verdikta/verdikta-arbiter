# An upgrade can reverse a well's tokens under its liquidity providers

An upgradeable well keeps its reserves in storage slots by position, and the tokens are in the immutable data of the implementation it points at.

An upgrade to a well of the same two tokens in the other order passes every check. The first reserve then belongs to what was the second token, and swaps and withdrawals price accordingly.

Those who pay are the liquidity providers. The test reads the first token before and after.
