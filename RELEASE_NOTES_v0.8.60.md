# LATAIF v0.8.60

This release makes invoices correctable at any time — and protects what has already been
reported to the NBR. On top of that, every confirmation prompt in the app now really waits for
your answer.

## Invoices can be corrected at any time

- **The final number stays.** Once an invoice has its final number, it keeps it for good — also
  when it is edited, becomes partly paid again and is paid in full a second time.
- **Invoices with a return can be edited.** Lines that were returned keep what was returned;
  the rest can be changed.
- **Edited lines keep their stock lot and their margin VAT.** A line is recognised by itself,
  not by its price, and shows the lot it was sold from ("fixed"). Asking for more pieces than the
  lot still has is refused with the reason on the screen.
- **A wrongly chosen customer can be corrected — also on a paid invoice.** After one explicit
  confirmation, everything booked on the invoice moves with it: receivable, payments, returns,
  credit notes, refunds and store credit. The correction is booked on the day it is made, and it
  stays traceable who paid and who received a refund.

## VAT periods

- **Mark a quarter as VAT filed.** In Analytics → Finance → Quarterly VAT, a quarter that has
  ended can be marked as filed — only after you confirm, and only after the return was actually
  submitted (an export alone is not a filing). The time, the person and the reported invoices
  are recorded.
- **Filed and VAT-paid quarters are protected.** Nothing that would change what was reported can
  be saved anymore: amounts, dates, customer, payments, cancelling, the butterfly mark, and the
  customer's name / VAT number or the article's brand / name as they appear in the return.
  Internal notes stay editable. The app says why a change is refused.
- **The quarterly overview now uses the same basis as the NBR export:** fully paid invoices, in
  the calendar quarter of full payment (Q1 Jan–Mar … Q4 Oct–Dec), independent of the fiscal year
  setting. Partly paid invoices are listed separately and are not part of any quarter yet. A
  filed quarter shows the figures recorded at filing. **Figures shown for past quarters can
  differ from what the previous version showed** — the old overview counted by invoice date,
  included partly paid invoices and counted margin VAT twice.

## Confirmation prompts

In the app, "Cancel" in a confirmation prompt did not stop the action — deleting payments,
expenses, credit notes, transfers, agents, partners and gold items, undoing conversions, repair
steps, the database reset on the login screen and others went ahead whatever you clicked. All
prompts now wait for your answer, and "Cancel" changes nothing.

## Upgrading

No manual step is needed. The update adds one table for VAT filings; existing data is not
rewritten.
