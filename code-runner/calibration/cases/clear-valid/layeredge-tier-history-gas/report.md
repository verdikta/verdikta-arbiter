# Others coming and going can price a staker out of withdrawing

Every action a staker takes first brings its interest up to date, and that reads its tier history from the start.

A staker near a tier boundary gets a new history entry each time the count crosses that boundary, and anyone can make the count cross it by staking and leaving.

About two thousand such visits, an hour apart, leave the staker's own withdrawal needing more gas than a 30 million gas block holds. Its funds are then stuck.

The test pauses gas metering for the set-up, then measures one withdrawal.
