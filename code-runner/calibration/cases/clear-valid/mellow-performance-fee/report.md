# The performance fee can take the whole supply

A price here is shares per asset, so it falls as a share gains value. The fee should be a part of that gain, expressed in shares, and that needs the price in the denominator.

The formula divides by a fixed 1e24 instead. With a price of 100 falling to 90, a fee of ten percent, and 900 shares, it charges 900 shares: the entire supply.

The right amount is 10. The test sets the fee manager's minimum price at 100 and asks for the fee at 90.
