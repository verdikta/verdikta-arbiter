# Anyone can upgrade an upgradeable well

A UUPS contract must restrict _authorizeUpgrade to whoever may upgrade. This override verifies the delegatecall, the aquifer and the implementation, and has no owner check.

So any account can point a well's proxy at any other well implementation bored by the same aquifer, and with it take over the liquidity behind the proxy.

The test bores a well, puts a proxy in front of it as the owner, bores a second well, and calls upgradeTo as a stranger. The proxy should still point at the first.
