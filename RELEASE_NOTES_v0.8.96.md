# LATAIF v0.8.96

Repairs now work the way the approved preview shows them, sale prices can be changed directly in the Collection, and saving on the second computer gives clear answers.

- **New Repair — "Who does the work?":** **In-house** and **External workshop** can each be ticked and unticked freely.
  - When ticked, their fields appear: **Work Type** and **Extra In-house Cost**, or **Workshop**, **Work Type** and **Workshop Fee**.
  - Both ticked is **Hybrid**; nothing ticked is saved as **Not set yet**, and the first work line sets the type later.
  - Unticking keeps what you typed, so ticking again brings it back. Only what is ticked when you create the repair is saved.
  - External needs a workshop. Without a fee the workshop and its work type are only planned and nothing is booked.
- **Repair list:** the search also finds workshops, work types and material suppliers. **Unassigned** finds repairs that are not set yet. The list shows "Showing x of y", splits the cost into work and material, and the button is now **Quick Edit**.
- **Quick Edit:** **Close** and **Save** at the bottom, the margin also in percent, and a reminder when amounts are not saved yet.
- **Repair detail:** a **Quick Edit** button, status steps with the current step in violet, lines grouped by in-house, each workshop and material, and five totals: work, material, total, charge and margin. A planned workshop fills in **+ Add Work**.
- **Older repairs with a workshop fee and no work line:** they now stay exactly as they are. Until v0.8.95 every start turned such a fee into a work line without a note in the history. A line is now only created with **Turn into a work line**; a paid fee is refused and stays.
- **Phone:** filters for work type and source, cards with issue, cost and charge, and work and material apart with totals and margin.
- **Collection:** **Edit prices** on each card changes sale price and minimum price directly, also for items from a purchase. The purchase price is only shown; it changes through **Purchase → Edit**. Purchases, stock lots and bookings stay as they are.
- **Prices from a purchase:** sale and minimum price of such items can now be changed on the main computer, the second computer and the phone. This also fixes the error when editing Tudor items on the second computer.
- **Saving on the second computer:**
  - A refusal shows its real reason and leaves no entry under **Unresolved saves**. **No answer from the primary** only appears when the result is really unknown.
  - **Clarify now** only asks the main computer and never sends anything. If the save never arrived, you decide with **Save it now** or **Discard**.
  - **Save it now** does not overwrite newer item data, and **Remove** asks first and never reports an unclear save as done.
- **Repair buttons:** selected buttons are violet instead of black.

**Database:** the update adds one column to repairs (planned work type) and a new repair type value for "Not set yet". The migration runs by itself at the first start and does not change existing repairs, repair lines, invoices, payments, purchases, bookings or media.

**Known open points, not fixed in this version:**

- After the last workshop line is cancelled, a Hybrid repair stays Hybrid and shows "no active work line".
- A cancelled line disappears instead of being shown crossed out. The source of a saved line cannot be changed; cancel it and add a new one.
- Items bound to an invoice, offer, order, repair or consignment stay price-locked on the second computer and the phone, with a clear reason.
- On the second computer, only item saves are checked against newer data.
- The six older phone uploads held back since August and October stay held back.

**Before you update:**

1. Check that **Unresolved saves** on the second computer is empty. Clarify open entries; do not remove them blindly.
2. Stop entering anything on the phone.
3. Close the second computer, then the main computer.
4. Make a full archive copy of both databases, the complete media folder (all files, no cleanup) and the key files, and check it.

**Update** the main computer first and the second computer straight after it. Do not click the update banner on the second computer first: a new second computer cannot save the new repair fields to an old main computer.
