# Anyone can upgrade an upgradeable well

A UUPS contract must restrict _authorizeUpgrade to whoever may upgrade. This override verifies the delegatecall, the aquifer and the implementation, and has no owner check.

So any account can point a well's proxy at another implementation that an aquifer bored, and take over what the well holds.
