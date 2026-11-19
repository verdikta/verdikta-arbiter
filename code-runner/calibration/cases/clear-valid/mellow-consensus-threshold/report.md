# One signer sent twice meets a threshold of two

A signature queue accepts an order once enough of the configured signers have signed it. The count is taken from the length of the list.

Nothing stops the list from holding one signer several times. Each entry verifies, and the length meets the threshold.

The test sets up two signers and a threshold of two, has the first sign an order, sends that signature twice, and asks checkSignatures, which should say no.
