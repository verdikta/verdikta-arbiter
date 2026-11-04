# An approved spender takes the rewards when it renews a position

A position owner may approve another account, which can then call renewLockPosition.

Renewing harvests first, and the harvest pays whoever made the call. So the approved account receives the pending rewards, and the owner loses them.

The test opens a position, approves a spender, waits an hour, renews as the spender, and reads the spender's reward balance, which should still be zero.
