# A plain transfer to a wallet never reaches its implementation

A wallet is a proxy in front of an implementation, and an implementation can have a receive function, to act on a payment.

The proxy does not forward a call with no calldata. It keeps the money and returns, and the implementation hears nothing.

The test deploys a wallet over an implementation that counts payments, sends it an ether, and reads the count.
