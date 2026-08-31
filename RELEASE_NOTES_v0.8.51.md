# LATAIF v0.8.51

Two things around consignment items: the payout model of an item you already took in can now
be changed, and putting a new item in no longer risks entering it twice.

## The payout model of an item already in stock

Until now the payout model was decided once, at intake. If it was agreed differently
afterwards, or simply picked wrongly, the item had to be deleted and entered again.

It can now be changed on the item itself, between the three models the shop already uses:

- **Percentage** — the shop keeps a percentage of the sale.
- **Fixed consignor amount** — the consignor is paid the agreed amount, whatever the item sells
  for.
- **Cost / excess split** — the consignor gets their cost back, and what is earned above it is
  split.

The value that belongs to the new model comes with it, and the one belonging to the model you
left behind is dropped, so an item never carries the terms of two models at once.

## What cannot be changed, and why

Once an item has been sold or paid out, its terms are part of a booking. From that moment the
model is fixed and the screen says so instead of silently refusing: the sale price, the
commission, the payout and its payments, and the link to the invoice stay exactly as they were
booked. Nothing is recalculated backwards.

An item that expired, or that came back without ever being sold, carries no booking — those are
free to change like any other unsold item.

And the margin line of a sold fixed-amount item keeps naming the amount it was actually booked
on. Editing the agreed price afterwards no longer makes that line describe terms that were never
in force.

## Entering an item once

When a new item looks like one you already have, the shop shows you the two side by side. That
is unchanged. What changed is what happens after you decide.

**Copy details** now takes the model details over and leaves it at that: nothing is created, the
form stays open for you to finish, and the hint does not immediately reappear for the item you
just copied from. Should you change something afterwards that makes it look like a different
existing item, the check does its work again — the hint is not switched off, only answered.

What the copy never takes is what belongs to the physical piece in front of you: its own number
and its serial number stay yours to enter.

**Create anyway** creates one item, once. A double click, or an impatient second press while the
first is still being written, no longer produces two items and two consignments from one
decision. Entering a genuine second piece of the same model later still works exactly as before.

## Nothing to migrate

No database change, no migration, no cleanup of existing items.
