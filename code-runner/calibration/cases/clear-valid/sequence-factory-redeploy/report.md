# The factory reverts instead of answering with an existing account

ERC-4337 asks a factory that creates accounts deterministically to return the address when the account already exists, since bundlers and getSenderAddress depend on it.

This one reverts. Anyone who deploys a wallet first, which needs no permission, makes the owner's own deployment fail.

The test deploys twice with one salt and compares the addresses.
