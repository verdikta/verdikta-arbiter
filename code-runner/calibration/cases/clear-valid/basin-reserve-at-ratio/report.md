# calcReserveAtRatioLiquidity reverts for ratios its table covers

calcReserveAtRatioLiquidity walks towards the target price and calls calcRate, which calls calcLpTokenSupply, on each step.

At some reserves that last function's iteration settles into a cycle of two values, two apart. Its rule stops only at a difference of one, so it runs out of rounds and reverts.

The test steps a ratio across the price table with fixed reserves. Every step should give a reserve, and one stops with the non-convergence revert.
