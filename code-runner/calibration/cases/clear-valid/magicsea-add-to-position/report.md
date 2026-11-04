# Anyone can add dust to a position and shorten its lock

addToPosition is meant for a position's owner or operator. Its check asks whether the caller may act for the caller, which is always true.

Adding also rewrites the lock duration from the remaining time. So one wei from a stranger cuts a two-week lock to one week after a week has passed.

A voter needs a minimum lock, so this can take a position out of a vote.

The test opens a two-week position, waits a week, adds one wei as a stranger, and reads the lock duration, which should be what the owner set.
