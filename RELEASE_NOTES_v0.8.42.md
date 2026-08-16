# LATAIF v0.8.42

Three fixes from a day of real use.

## "Create anyway" creates one item

Confirming a duplicate warning once now creates exactly one item.

- Previously the same warning could come back a moment later — because the item you had just
  created was itself the closest match — and answering it again produced a near-identical twin with
  the next SKU.
- **The warning is the only thing "Create anyway" overrides.** Missing required fields and a SKU
  that is already in use still stop the save, exactly as they do on the normal Save. Change any of
  the product's details afterwards and it is checked for duplicates again.

## SKUs you type are cleaned up

- A SKU entered with a space before or after it is stored without them, so `RLX-WCH-001` and
  ` RLX-WCH-001 ` are the same number rather than two entries that look identical in every list.
- That trimming happens **before** the "already in use" check, so a stray space can no longer slip a
  second item past a number that is taken.
- Typing only spaces counts as leaving the field empty: the item gets its automatic number as usual.

## AI Identify does not price your stock

AI Identify recognises the piece — brand, model, reference, material, condition, description — and
no longer fills in any price.

- **Purchase price, planned sale price, the minimum and maximum sale price, and the consignment
  agreed price are yours alone.** They are never filled from an estimate and never suggested.
- Prices you have already entered are left exactly as they are, including a price of **0**, which is
  a real figure and is no longer mistaken for an empty field.
- This applies everywhere identification runs: the Collection, the New Item dialog, editing an
  existing item, consignments and the background identification of synced items.
