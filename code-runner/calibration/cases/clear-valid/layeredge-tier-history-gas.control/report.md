# Others coming and going can price a staker out of withdrawing

Every action a staker takes first brings its interest up to date, and that reads its tier history from the start.

A staker near a tier boundary gets a new history entry each time the count crosses that boundary, and anyone can make the count cross it by staking and leaving.

Twenty thousand such visits leave the staker's own withdrawal needing about 36 million gas, more than a 30 million gas block. Its funds are then stuck.

The test pauses gas metering for the set-up, then measures one withdrawal.
