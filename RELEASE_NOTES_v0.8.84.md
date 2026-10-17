# LATAIF v0.8.84

Optional stone quantity for every stone type.

- **Stones (Gold-Diamond Jewellery):** the quantity of a stone row is now optional — for diamonds, rubies, sapphires,
  emeralds and every other stone type. A row can be saved with only its stone type (and carat, colour, clarity or shape
  where known). An empty quantity stays empty; it is never filled in as 0 or 1. A quantity that is entered must still
  be a whole number of at least 1.
- **Existing items:** stored quantities stay exactly as they are. A quantity disappears only when you clear the field
  and save.
- **Everywhere the same rule:** New Item, item editing, repairs, purchase and consignment on the computer, the phone
  (New Collection Item and the phone purchase/consignment forms) and the Excel import (an empty "Stone N Qty" column is
  no longer an error).
- **Display:** a row without quantity shows no "Qty". Lists and documents show the carat total as before; where a stone
  type has a row without quantity and no carat, only the stone type is shown — no invented count.

Nothing else changes: item stock quantities, stock movements, bookings and the database structure stay as they are.
Update the main computer and the second computer as usual; no ledger backfill is needed.
