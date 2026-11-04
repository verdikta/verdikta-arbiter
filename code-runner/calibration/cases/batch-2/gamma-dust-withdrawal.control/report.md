# Dust stakes from a stranger can price a staker out of withdrawAllUnlockedToken

stake takes the account to stake for, and no minimum. A stranger can add as many locks of one wei to a victim as they like.

withdrawAllUnlockedToken asks for the entire list once per ten entries, so its cost grows with the square of the list.

With 400 dust locks, it needs well over 30 million gas.
