# A staker promoted when the tree grows keeps being paid at the lower rate

With fifteen stakers the tiers hold 3, 4 and 8. The staker at rank 7 belongs in tier 2, and getUserAPY says 35%.

The tier history behind claimInterest was never told: at the step from fourteen to fifteen, the tier 2 size does not change, and the branch that handles that case looks up the rank from the old counts.

After a year of the minimum stake the staker receives 20% and is told 35%. The difference stays in the contract.

The test stakes fifteen times, waits a year, claims, and compares what was paid with the rate the contract states.
