# The performance fee is charged when the price falls

A performance fee should come out of gains.

This one charges when the reported price goes below the lowest price stored, and stores the new low. So each fall in price mints shares to the fee recipient, which dilutes everyone else, and a rise mints nothing.

The test stores a price of 1, reports 0.9, and asks for the fee.
