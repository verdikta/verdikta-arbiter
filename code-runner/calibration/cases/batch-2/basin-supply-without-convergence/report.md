# calcLpTokenSupply returns a number when it has not converged

Both calcReserve and calcLpTokenSupply iterate up to 255 times and return when two steps agree to within one. If they never do, calcReserve reverts. calcLpTokenSupply just ends, and its return variable holds the last guess.

With reserves of 1000e18 and 100 wei the iteration has not settled when it stops. The value returned moves by more than 300,000 on one more step.

Anything computed from that supply is then wrong without anyone being told.
