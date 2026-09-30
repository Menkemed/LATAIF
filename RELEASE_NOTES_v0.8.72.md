# LATAIF v0.8.72

Every record can now carry the day it really happened — useful when something is entered later.

- **A date field when you create a record:** Order, Purchase, Repair, Consignment, Approval
  transfer and Production. It starts on today and can be set to an earlier day.
- **No future dates:** a day in the future, or a day that does not exist, is refused — on the main
  computer, on the second computer and on the phone alike.
- **Order:** the new "Order Date" is shown in the list, on the order page, on the receipt and in
  search. A deposit taken when the order is created is booked on that day. The order date can be
  corrected later under "Edit"; payments keep their own date. The list is sorted by order date.
- **Repair, Consignment, Approval, Production:** "Received Date", "Agreement Date", "Transfer
  Date" and "Production Date" are chosen when the record is created. Items made in a production
  take the production date as their purchase date.
- **Phone:** New Purchase ("Purchase date", under Purchase details), Repair Intake ("Received
  Date") and Consignment Intake ("Agreement date") have the same field. The chosen day is kept in
  a purchase draft, survives closing the page and waiting without connection, and is never
  replaced by a later "today" when the phone sends again.
- **Purchase:** payments entered with a new purchase are booked on the purchase date, as before.
- Older records are unchanged; orders created before this version show the day they were entered.

Update the main computer first, then the second computer. Reload the phone page once after the
update. The update adds one field to orders; no existing data is changed.
