# LATAIF v0.8.47

Photographing and editing stock from the phone — and a set of rules that make sure editing an item
can never cost you a photo.

## Several photos for a new item

The capture form now keeps a list instead of a single picture. Take or pick several photos at once,
tap one to make it the cover, remove one before saving, and add more without losing what you already
selected. The strip you see is the order that gets saved, and the first photo is the cover. Up to
eight photos per item.

## Editing an item from Check Item

Look an item up, open it, and edit it — no longer only on the desktop. The item's own photos are now
shown in full, in order, with the cover marked.

Name, brand, condition, location and notes can be changed. Only the fields you actually touched are
sent, so a field you did not open cannot be blanked by accident. SKU, prices, category and the
photos are not part of a text edit at all: after changing a name, every photo is provably the same
one it was before — same order, same cover, same files.

## Editing the photos of an item

Add photos, remove specific ones, change the order, choose a different cover, or cancel. Existing
photos keep their identity throughout: reordering moves positions, it does not re-create anything,
and removing one leaves the others exactly as they were. The eight-photo limit applies to the result,
so swapping one photo for another on a full item is fine.

Removing a photo from an item detaches it from that item. Cleaning up the stored file stays the job
of the existing storage maintenance, as before.

## What protects your photos

- **A gallery that cannot be read is not an empty gallery.** If the photos of an item cannot be read
  for any reason, the app says so and refuses to edit them — instead of showing "no photos" and
  letting a save act on that.
- **Nothing is deleted by omission.** A photo is only removed when it was explicitly marked for
  removal. A save that does not account for every photo it was based on is refused, not interpreted.
- **An item that changed in the meantime is a conflict.** If the item's photos moved on since the
  screen was opened — someone added, removed or reordered — the save is refused with "Item changed.
  Reload before saving." Nothing is half-applied and nothing is overwritten with the older view.
- **A failed save changes nothing.** If preparing a new photo fails, or the save itself fails, the
  previous photos, their order and the cover stay exactly as they were — including the case where a
  removal and an addition were requested together.
- **Sending the same save twice does the work once.** A double tap, a retry after a lost connection
  or a resume after a restart apply the change a single time: no duplicated photos, no second cover.
- **An instruction the app does not recognise is refused** rather than guessed at.

## Stability

Internal build, test and compatibility improvements.
