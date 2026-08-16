# LATAIF v0.8.41

## AI Identify no longer touches the SKU

Identifying an item is a recognition step. It fills in what it recognises — brand, model, condition,
attributes — and it leaves the SKU alone.

- **An existing item keeps its number.** Running AI Identify on a watch that already carries, say,
  `RLX-DJ36-001` leaves that number exactly as it is. Previously it could be replaced by whatever
  reference the model returned.
- **A new item is not numbered by the AI either.** The SKU comes from LATAIF, never from the model's
  answer.

## One numbering rule for new items

An item that gets its number automatically is numbered `BRAND-CATEGORY-SEQUENCE`.

- Known brands use the code your stock already uses — **Rolex is `RLX`**, not `ROL`. A Rolex watch
  is therefore `RLX-WCH-001`, a Cartier watch `CAR-WCH-001`.
- The middle group is the **category**, so all watches of a brand count through one sequence
  regardless of model.
- **The desktop and the phone use the same generator and the same sequence.** Whichever surface
  creates the next item continues the count; the two can no longer number the same brand differently.
- The number shown in the New Item dialog is a **suggestion**: looking at it, changing the brand or
  the category, and cancelling all cost nothing. The number is claimed when you save.
- **SKUs you already have are not changed**, and a SKU you type yourself is never overwritten.
