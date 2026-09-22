# LATAIF v0.8.59

This release is about one thing above all: **stock is taken when an item is sold, and given back
exactly as it was taken.** Around that sit a few smaller corrections — the scrap trade screen,
the two sides of a person who is both client and supplier, a clearer label on supplier figures,
and the retirement of the old row sync.

## The new stock rule

Until now an item without a purchase lot (an item entered by hand or from the phone) lost a
piece from stock **when the invoice was paid**, and always exactly one piece, whatever the
invoice said. An unpaid invoice therefore left the piece sitting in stock, and an invoice over
three pieces took one.

From this version:

- **The sale takes the stock, not the payment.** The moment the invoice is created, the items on
  it leave stock — with the quantity the line actually says.
- **What a line took is recorded.** Cancelling, deleting or editing gives back exactly that, no
  more and no less. Paying an invoice a second time, or re-opening and closing it, moves nothing.
- **Selling more than you have is refused** — with the reason on the screen, before anything is
  written.
- **A repair service is not stock.** It has no lot, takes nothing, and returns nothing.

The same rule now holds where stock used to be able to disappear or double:

- **Agent sales.** Marking a transfer sold takes the piece; converting it into an invoice does
  not take it a second time. Undoing the conversion keeps the sale, deleting the transfer gives
  the piece back. An invoice created from an agent sale can no longer be edited directly — undo
  the conversion first, and the screen says so.
- **Production.** Every input records what it consumed. Deleting a production record returns
  exactly that, from exactly those lots, and removes the output products it created. A
  production recorded before this version cannot be deleted automatically, because what it
  consumed was never written down — the screen explains that instead of guessing.
- **Returns.** A return that was put back into stock can no longer be cancelled once the piece
  has been sold again; the later sale has to be resolved first.

### Invoices from before this version

Invoices that already existed keep the old arithmetic — nothing is recalculated backwards. The
app sorts them once at startup: an invoice that already took its piece will not take another,
one that has not yet taken it still takes exactly one when it is first settled, and cancelling
gives back exactly that one piece.

Their **items cannot be edited**. How much stock such a line took was never recorded, so
changing it would mean guessing. The screen says so and points to cancelling the invoice and
writing a new one where that is possible.

## A client who is also a supplier

A client card now shows the supplier side of the same person, and a supplier card the client
side — each with the official balance of that side, the same number those pages show themselves.
Gold and store credit stay separate, as they are.

Only an explicit link counts as one and the same person. A match on name or phone number is
shown as a **possible match** without any balance, so nobody's money is ever shown under the
wrong name.

## Smaller things

- **Scrap gold:** the screen is in English throughout, and the hint about keeping an item
  instead of selling it on now has a button that opens the precious-metal entry directly.
- **Supplier figures** are labelled **Purchases + Expenses**, in the supplier card, the supplier
  list and the payables report — because that is what the number contains.
- **Deleting a production record** now says what it really does: the inputs go back to stock, the
  outputs created here are removed, a booked labour/overhead expense is reversed, and it is
  refused when an output has already left stock.
- **Photos and documents:** several gaps found in the phone and second-computer audit are
  closed — among them photos of a cancelled order returning to the item, and the finance role no
  longer being able to create or re-price items from the phone.
- **The old row sync is retired.** A normal login can no longer push rows into the main computer;
  everything goes through the checked commands. This affects no single-computer installation.

## Installation

Windows installer, over the existing installation. Data, settings and the data folder stay where
they are; the database is upgraded once at the first start.
