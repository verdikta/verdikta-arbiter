# calcReserveAtRatioSwap gives up on a ratio inside its table

The swap function starts from a pair of prices in a lookup table and steps towards the target.

In this part of the table the two prices are far apart. Each step moves further from the target, and after the last round the function returns zero, with no revert to say so.

A caller gets a reserve of zero for a ratio of about one to four and a half. The test asks for that reserve.
