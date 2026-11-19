# upgradeToAndCall is open to any account

upgradeToAndCall moves a well's proxy to a new implementation and then delegates a call to it, in one transaction.

Nothing in that path looks at the caller.

The test has a stranger call it on a well the owner set up, and reads where the proxy points afterwards.
