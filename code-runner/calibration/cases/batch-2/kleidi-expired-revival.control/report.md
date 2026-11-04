# Raising the expiration period brings expired operations back

An operation that nobody ran within its window is expired, and owners may reasonably stop thinking about it.

The window is worked out from today's setting. Raise the setting, and every operation still in the list comes back, for anyone to execute.

The test lets an operation expire, raises the period to thirty days, and asks again whether it is expired.
