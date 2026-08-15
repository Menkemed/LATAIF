# LATAIF v0.8.40

## An inventory you can put down and pick up again

A stocktake is now a **run**, not something that disappears when the dialog closes.

- Close the view, close the window, restart the app — reopening puts every card back in the column
  you left it in, with its note. The run stays open until you end it.
- **Finish inventory** ends the run and empties the three columns for the next one. It deletes
  nothing from the stock-check history: every observation you recorded stays on record.
- The header shows since when the current inventory has been running.

## Checks from the phone land in the inventory you are working on

A check recorded on `/mobile` no longer only appears in the history — it fills the card.

- Check items on the phone while the inventory is open; the next time you open it on the desktop
  they are already in **Available** / **Not available**, with the note you wrote on the phone.
- **You can start on the phone.** Walk the shelf with `/mobile` first and open the desktop
  inventory afterwards — those checks are waiting for you in the right columns, everything else in
  **To check**.
- If the phone and the desktop disagree about an item, the **later** observation is what you see.
  Both stay in the history; correcting an item writes a new entry rather than overwriting the old one.
- Putting a card back into **To check** stays that way — an earlier phone check does not undo it.
- Each branch has its own inventory. A check in one branch never appears in another's.
- Stock checks you recorded **before this version** stay in the history and are never taken as the
  starting state of a new inventory.

Opening the inventory does not record anything, and pressing Save when nothing has changed writes
nothing.

## Product preview above the inventory dialog

Hovering a row in the inventory now shows the product preview **on top of** the dialog instead of
behind its blurred background.

## One SKU sequence for the desktop and the phone

The desktop now numbers new items from the same durable counter the phone already used.

- **A suggested number costs nothing.** Open the New Item dialog, look at the number it offers,
  press Cancel — the counter has not moved, and the next dialog offers the same number again.
- The number is **claimed when you save**, not when it is shown. If someone else took it in the
  meantime, your item simply gets the next one — no duplicates.
- **A number that has been handed out is never handed out again**, not even after the item that
  held it is deleted.
- A SKU you typed yourself is kept exactly as you typed it and does not move the counter. If you
  used a number the counter has not reached yet, a later item skips over it instead of colliding.
- A fast double-click on **Add to Collection** creates **one** item and uses **one** number.

---

Stock checks record *what you observed*. They do not change an item's quantity, price, status,
attributes or photos.
