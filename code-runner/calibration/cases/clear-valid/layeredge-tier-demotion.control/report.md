# A staker who should fall to tier 3 stays recorded in tier 2

With fifteen stakers the tiers hold 3, 4 and 8. When someone in tier 3 leaves, fourteen split 2, 4 and 8, so rank 3 falls to tier 2 and rank 7 falls to tier 3.

The branch for an unchanged tier 2 size looks up only the rank at the new boundary, which is 6. Rank 7 is never written.

So rank 7 keeps its tier 2 record and goes on earning the higher rate, while getCurrentTier says tier 3.

The test gets fifteen stakers with the seventh correctly in tier 2, has a tier 3 staker leave, and compares the seventh staker's last recorded tier with tier 3.
