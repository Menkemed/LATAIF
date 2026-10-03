# LATAIF v0.8.77

Repairs: creating a repair always reacts, and in-house costs are no longer counted twice.

- **Create Repair explains what is missing:** instead of silently doing nothing, the form names the
  missing required fields.
- **Required fields marked:** Client and Issue are marked as required.
- **Opens the new repair:** after Create Repair, the detail page of the new repair opens.
- **Clear cost names:** on internal repairs the cost fields are called "Additional In-house Cost" —
  only extra costs for the job, not regular salary or materials already bought as an expense.
- **Estimates are information only:** an estimated in-house cost is never booked; only the actual or
  additional in-house cost is.
- **Hybrid workshop fee counted once:** the workshop fee of a hybrid repair is no longer also counted
  as own work.
- **Unchanged:** external repairs behave as before.

No existing data is changed. Update the main computer first, then the second computer.
