# LATAIF v0.8.46

Safety around destructive actions, and a correction in the accounting backfill.

## The safety backup is now checked before anything is deleted

Every reset takes a safety copy of your data first. Until now that copy was written and trusted.
It is now read back and checked before the reset is allowed to continue: the file has to be there,
have the right size, and match its checksum.

If anything is off — a copy that never arrived, a file that cannot be read back, a size or checksum
that does not match — the reset stops and nothing is deleted. A backup that cannot be verified no
longer counts as a backup.

The reset offered on the sign-in screen now follows exactly the same rules as the one in Settings:
the same confirmation, the same block while sync or LAN is configured, and the same verified backup
beforehand.

## Historical overpayments are booked correctly

When the accounting backfill replayed old invoice payments, a payment larger than its invoice was
booked entirely against the outstanding amount. A 100 BD invoice paid with 120 BD ended up showing
a receivable of −20 BD instead of 20 BD of store credit for the customer.

The backfill now works out how much of each invoice was still open at the time of each payment, in
date order. A payment covers at most what was outstanding; anything above it becomes customer
credit, exactly as it does when a payment is taken in the app today. Payments that were already
booked stay untouched, and running the backfill again changes nothing.

## Stability

Internal build and compatibility improvements.
