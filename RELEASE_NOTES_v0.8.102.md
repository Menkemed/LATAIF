# LATAIF v0.8.102

Payments get their real date: expenses and Pay Supplier can be booked on the day the money was paid, and an expense can be paid with several payment methods at once. Every repair cost has its own cost date. New repair costs are always cost lines, and the workshop fee and the estimate are kept apart.

- **Paying expenses** (Expenses list and the payable chip on a repair):
  - **Payment date:** prefilled with today; an earlier day can be chosen. It is booked on that day: the expense, the books, Banking and the payment history.
  - **Several payment methods** in one payment ("Add payment method"), for example part cash and part bank, each with its own date. Banking shows one line per payment.
- **Pay Supplier:**
  - **Payment date:** prefilled with today; an earlier day can be chosen. All parts of the payment use it: paid expenses and purchases, the supplier balance, Banking and the history. An amount above what is owed (supplier credit) is booked on the same day.
  - **Banking** now also shows such an overpayment as its own line "Prepayment", and a refund of that credit as money in. The account balances were already right.
- **Rules for a payment date:**
  - It is a calendar day in Bahrain, at most today, never a future day.
  - It cannot be before the opening (15 Oct 2026), and it cannot be in a VAT quarter that is already filed or paid.
  - It cannot be before the cost or purchase it pays. The message names the document.
- **Repairs – cost date:**
  - **Every cost line** (work, material, in-house) has a cost date. The cost is booked on that day, independent of when it is paid.
  - **Default** is the day the repair was received. If the repair was received before the opening (15 Oct 2026), there is no default: the form asks you to choose a day. New Repair asks for it too, when costs are entered.
  - **"Edit date"** on each line, also after payment, with a short reason:
    - The old booking is reversed on its own day and booked again on the new day.
    - The amount, the item cost, partner shares and payments stay the same. The change is in the history.
    - Not possible, with a clear message, when:
      - the repair is invoiced;
      - the own item is sold;
      - the new day is after a payment of that cost;
      - the old or new day is in a closed period.
- **Repairs – simpler costs:**
  - **New costs are always cost lines**, each with its cost date:
    - "+ Add Work" → In-house for own staff (no payment);
    - "+ Add Work" → External workshop for anyone you pay (a payable, paid with its own payment date);
    - "+ Add Material" for parts.
  - **Edit and Quick Edit** no longer offer "Own cost", "Internal paid from" or a typed "Actual cost" on new repairs; a short hint points to the cost lines. Older repairs that already have such header costs keep them, and they can still be changed.
  - **New Repair:** the workshop fee is the workshop's actual cost and becomes the work line. The new optional field "Estimate" is information only and is never booked. The fee is no longer stored as the estimate.
  - **An estimate never becomes a booked cost.** A change that would turn it into one is refused.

**Database:** the first start adds one empty field, the cost date of repair cost lines. Existing repairs, cost lines, expenses, payments, purchases, bookings and media are not changed. Older cost lines without a cost date keep booking as before.

**Known limits:**
- **Older repairs:** their header costs (own cost in the repair header, an old workshop fee without a work line) have no cost date. They are booked at "Ready", as before.
- **Unchanged from v0.8.101:**
  - Sales users can still record money in the places listed for v0.8.101.
  - Supplier returns: a gain has no account; VAT on refunded added costs is not calculated.
  - Partners: production with a joint item and correcting a joint purchase line stay blocked.

**Before you update** (the main computer and the second computer are both on v0.8.101):

1. Stop entering anything on the phone.
2. Check **Unresolved saves** on the second computer. Clarify open entries; do not remove them blindly.
3. Close both computers.
4. Make a full archive copy of both databases, the complete media folder (all files, no cleanup) and the key files, and check it.

**Update** the main computer first, then the second computer, both from v0.8.101.

The payment date, several payment methods, the cost date, "Edit date" and the estimate field need v0.8.102 on both computers.

While the second computer is still on v0.8.101:
- **Payments:** it books them on today's date.
- **Refused with a message:**
  - adding costs to a repair received before the opening;
  - typing own cost or actual cost on a new repair.
- In those cases, use the main computer or update the second computer first.
