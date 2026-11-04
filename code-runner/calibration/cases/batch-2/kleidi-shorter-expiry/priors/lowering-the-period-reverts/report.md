# updateExpirationPeriod reverts when it lowers the period too far

The safe schedules a change to a shorter expiration period. Execution runs the change and then the second readiness check, which uses the period that was just set.

A proposal executed with fewer days left than that gap reverts, and the period cannot be lowered that way.
