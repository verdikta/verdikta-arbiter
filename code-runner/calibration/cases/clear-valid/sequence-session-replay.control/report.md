# A session signature for one wallet also validates for another

Wallets with the same configuration can share a session key. What the key signs should still say which wallet it is for.

The hash the key signs leaves the wallet out. So a signature made for one wallet passes recoverSapientSignature when another wallet presents it, and that wallet would run the same calls at the same nonce.

The test makes one session signature and presents it from two addresses. The second should be refused.
