# Well data decoding tests the wrong decimal for token one

A zero in the well data means 18 decimals. The function applies that default to token zero, then tests token zero again before setting token one.

So token one keeps a zero when token zero has a value, and loses its real value when token zero is zero. Reserves are then scaled wrongly throughout the well function.

The test decodes 18 and 0, and reads token one's decimals.
