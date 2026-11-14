# A proposal to shorten the window can stop executing while it reads as ready

A proposal has until its window closes. Anyone can see that with isOperationReady, and anyone can execute it.

One proposal is different. If it shortens the window, then four days into a five-day window, with three days as the new length, it reads as ready and reverts when executed.

The safe has wasted the delay, and has to start again.
