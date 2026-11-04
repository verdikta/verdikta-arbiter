# One wei staked into an empty lock takes all the rewards

Reward tokens arrive by transfer, and notifyUnseenReward, which anyone can call, shares out what has arrived.

If nobody is staked at that moment, the first to stake one wei can notify, claim the lot and leave. On one wei the penalty rounds to nothing.

The test sends a thousand tokens to the empty lock and has an attacker do that.
