# Swapping for a well's third token costs nothing

A well takes its pricing from its well function. calcReserve tells swapTo how large the reserve of the input token has to become for the swap to balance.

Stable2 works from reserves zero and one. It takes a longer list without complaint and ignores the rest.

So in a well of three tokens, taking the third out leaves the answer where it was, and swapTo asks for nothing in return.

The test bores a three-token well with Stable2, adds equal liquidity, and swaps token zero for 157 of token two.
