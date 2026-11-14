# Well data decoding tests the wrong decimal for token one

A zero in the well data means 18 decimals. The function applies that default to token zero, then tests token zero again before setting token one.

Token zero is never zero at that point, so the default for token one is never applied. A zero stays a zero, and reserves are then scaled by the wrong power of ten throughout the well function.

The test decodes 18 and 0, and reads token one's decimals.
