# Unlocking one protected listing makes the next one cheaper

Interest on a protected listing follows a compound factor stored in checkpoints, and the rate depends on how many listings a collection has.

unlockProtectedListing takes the listing out of the count first and writes the checkpoint after. The checkpoint therefore reads a lower utilization than the period it closes had.

Two listings created together, for the same amount, have accrued the same interest, and removing one cannot make the other cheaper. The test unlocks one and reads the other's price, which comes out lower.
