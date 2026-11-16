# A pending deposit cannot be cancelled once a price is reported

A depositor may cancel a request until a report covers it.

cancelDepositRequest reads the latest price checkpoint, and uses what that returns as the place in the tree of requests to reduce. That number is the price: about 1e18, far past the end of the tree.

So after the first report no pending deposit can be cancelled. The test makes a report, deposits, and cancels.
