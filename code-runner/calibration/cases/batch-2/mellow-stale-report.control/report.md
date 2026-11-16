# A report of any age still validates a price

A signed order is checked against the oracle before it is honoured.

That check looks at how far the order's price is from the last report, and not when that report was made. If reports stop, the old price goes on validating orders while the market moves away from it.

The test makes a report, moves a year on, and asks whether the same price is valid.
