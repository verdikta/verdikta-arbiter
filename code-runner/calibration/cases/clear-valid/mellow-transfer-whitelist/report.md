# The transfer whitelist blocks the accounts it is meant to allow

IShareManager documents canTransfer as the permission to send or receive shares while hasTransferWhitelist is on.

updateChecks tests the sender's flag the wrong way round: an account with the flag set is refused, however the receiver is marked.

The test turns the whitelist on, marks both accounts as allowed, and calls updateChecks. It reverts with TransferNotAllowed. A share transfer between two allowed accounts is impossible.
