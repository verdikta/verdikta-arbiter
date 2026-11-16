# Queued proposals can price the guardian out of pausing

The guardian's pause is the wallet's answer to stolen signer keys. It cancels all live proposals, one by one, in that transaction.

A thief with the keys can schedule as many proposals as they like. Each makes the pause dearer.

With 2,500 queued, the pause needs more than 30 million gas. Then it cannot be mined, and any of the proposals can run when ready.
