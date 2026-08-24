# LATAIF v0.8.48

Search that finds the item you meant, and editing from the phone that always works on the item as it
is right now.

## Searching finds items, not machine data

Typing `large` in Collection returned six items when only two are called Large. The other four
matched because the AI's description of their photo happens to say "large, bold hour markers".
Typing a reference number like `126` returned the entire stock — every item, because the AI image
vector is a long list of numbers and the search compared those numbers as text. Searching for
`steel` or `serial number` also returned everything, because the category definition was searched
along with the item: every watch matched, not because the watch is steel, but because its category
offers Steel as a choice.

Search now works on what identifies an item: SKU, brand, name, reference, serial, model, condition,
description, notes, location, what is included, the supplier, the category name and the item's own
category attributes. `large` finds the two Cartier Tank Must Large. A reference number finds the
item that carries it.

Prices, tax scheme, ownership and the internal stock status are no longer searched as free text.
Those are filters, not names — and as text they only produced accidents. The filter buttons for them
are unchanged. The AI description, the image vector, image hashes and the AI's own notes stay stored
and keep serving the AI features; they are simply not search terms any more.

This applies everywhere an item can be searched: Collection, invoices, offers, orders, repairs and
consignments. Each of those lists still finds its own documents by their own fields — invoice
number, customer, phone, note, amount, status.

An item whose category was switched off later keeps its attributes in the search. Deactivating a
category means it is no longer offered for new items; it does not mean the items already in it stop
being what they are.

## Editing an item from the phone shows the item as it is now

Opening an item from the search results now re-reads it from the desktop first. Before, going back
to the list and opening the same item again showed the state from before your last change — you had
to search again to see your own edit. Editing is only offered on an item that was read successfully;
if that read fails, the form stays closed with a note and a retry button, rather than saving against
a view that no longer exists.

## More of an item can be edited from the phone

Beyond name, brand, condition, location and notes, the phone can now edit the category attributes of
the item — reference, serial, dial, material and whatever else its category defines — and what is
included with it. The fields come from the same definition the capture form uses, so there is no
second list to keep in sync. Only the fields you actually changed are sent.

## Prices on the phone: visible, with a reason when they are locked

The three prices — purchase, sale and minimum sale — can be corrected from the phone as long as the
item is still free own stock: yours, and not yet part of any business record.

As soon as the item appears in a purchase, a sale, an invoice, an offer, an order, a stock lot, a
consignment, a transfer to an agent, a return, a production or a repair, the prices are locked. They
stay on screen with their current values and say why, for example "Price editing locked — linked to
Invoice". Consignment stock and items out with an agent say so in their own words. If the reason is
not certain, the fields stay locked but no reason is invented. Everything else about the item stays
editable — the note on a sold item can still be corrected.

The lock is decided on the desktop, inside the same step that writes the change, and a locked item's
save is refused as a whole: no price moves and no photo moves either.

## Nothing to migrate

No database change, no migration, no cleanup of existing items.
