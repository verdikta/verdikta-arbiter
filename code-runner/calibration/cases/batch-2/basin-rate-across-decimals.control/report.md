# calcRate gets the rate wrong across decimals

calcRate scales the reserves and then asks calcLpTokenSupply for the supply, with 18 written in for both tokens.

A well with a six-decimal token should still price by value. With 10,000 of that token against 10 of an eighteen-decimal one, the test expects a rate of one to one.

It gets about 452 to one.
