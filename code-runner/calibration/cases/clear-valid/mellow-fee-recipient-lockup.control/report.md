# Each fee payment locks the fee recipient again

The targeted lockup holds newly minted shares for a while. Deposits are its purpose, and mint applies it to whoever receives shares.

Fees are paid by minting to the fee recipient, on deposits, redemptions and reports. Each one sets a new lock, so a small action repeated often enough means the recipient can never move what it has earned.

The test turns on a thirty-day lockup, mints shares for a holder, waits a year, and submits a report, which pays a protocol fee. It then reads the recipient's lock.
