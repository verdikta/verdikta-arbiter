# A wallet answers as a sapient signer with a constant

A wallet can be another wallet's sapient signer. The parent builds a leaf of its configuration from what the signer answers, and the interface says that answer is the signer's image hash.

This implementation always answers one. A parent configured with a real image hash can then never validate through that signer.

The test makes a signature for an empty configuration, reads the image hash it recovers, and compares that with the answer.
