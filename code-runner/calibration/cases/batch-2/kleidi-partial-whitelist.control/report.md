# A hot signer can choose the arguments a whitelist does not cover

Owners of the wallet whitelist calls a hot signer may make without a delay, by contract, selector and byte range.

If they whitelist only the recipient of a deposit, nothing looks at the amount. A hot signer can deposit as much as the wallet has.

The test whitelists the first argument of a lending deposit, then sends the deposit with an amount nobody approved.
