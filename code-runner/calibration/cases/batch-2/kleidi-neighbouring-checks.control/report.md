# Two neighbouring arguments cannot both be whitelisted

Owners whitelist a call by byte ranges, so that a hot signer can make it with the values they chose.

To cover a deposit they need a range for the recipient and a range for the amount, and the second begins where the first ends. The check for overlaps treats that as an overlap, and reverts.

So a call with arguments side by side cannot have all of them checked. The test adds both ranges.
