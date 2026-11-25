# Oracle Registration

An installed arbiter answers requests only once its jobs are registered with the Verdikta
dispatcher. With the v2 dispatcher each job registers with the `ReputationKeeper` through
`registerArbiter`, with a wVDKA stake and the head of a hash chain, and must then answer the keeper's
health calls to stay selectable.

- [Dispatcher Registration](dispatcher.md): register, stay healthy, earnings, scores, pause and exit.
