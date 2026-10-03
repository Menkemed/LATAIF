# LATAIF v0.8.75

Phone edits can no longer get stuck and hold up the phone queue.

- **Purchase price cannot be emptied from the phone:** saving an item edit with an empty purchase
  price is now refused right away with a clear message. Enter `0` if the item has no purchase
  price. Sale price, minimum price and year can still be left empty. The same check runs on the
  main computer before anything is saved — photo and fields are applied together or not at all.
- **The phone queue keeps moving:** a phone job that can never succeed is now set aside with a
  clear reason instead of being retried endlessly, and the next phone jobs are processed.
- **Photo changes are not reported as conflicts by mistake:** if a photo change was already
  applied and is sent once more, it now counts as done instead of a "gallery changed" conflict.
  A real competing photo change is still reported as a conflict.
- **The phone waits up to 40 seconds** (was 20) for the main computer to confirm a change, so the
  "accepted, but the desktop has not applied it yet" note no longer appears too early.

Update the main computer first, then the second computer. Reload the phone page once after the
update. No existing data is changed.

After the update on the main computer, a phone job that was stuck before (for example a photo change
with an empty purchase price) is set aside automatically and the following phone jobs run again. Set
that photo once more, with purchase price `0` or unchanged.
