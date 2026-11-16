# A batch of oracle reports charges the protocol fee once per asset

The protocol fee is charged on the time since a stored timestamp. Only a report for the base asset moves that timestamp.

Oracle.submitReports takes several assets at once, and the vault charges on each report. With the base asset last, every report in the batch sees the same old timestamp and charges the same period.

With a fee of 10% a year on 1000 shares, one year should mint 100 shares. A batch of three reports mints 100, then 110, then 121: 331 in all.

The test deploys a vault, its oracle and its fee manager, reports three assets, waits a year, reports them again with the base asset last, and reads the fee recipient's shares.
