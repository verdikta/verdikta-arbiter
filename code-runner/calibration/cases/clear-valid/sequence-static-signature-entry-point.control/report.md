# A static signature bound to the entry point cannot validate a user operation

A static signature can name the one caller allowed to use it. For a user operation that caller is the entry point.

validateUserOp checks the entry point, then calls itself externally to check the signature. By then msg.sender is the wallet, so the bound caller never matches.

It also reverts rather than returning the failure value, which breaks what an entry point expects. The test binds a signature to the entry point and validates as the entry point.
