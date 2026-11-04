# Paying back the principal through adjustPosition wipes the interest

The unlock price of a protected listing is tokenTaken scaled by the compound factor since the listing's checkpoint.

adjustPosition changes tokenTaken directly. Repaying the amount originally taken brings it to zero, and zero scaled by any factor is zero.

The test takes 0.4 of a token against a listing, waits a week, repays 0.4 through adjustPosition, and reads the unlock price. Interest of about 0.002 was owed, and the price reads zero.
