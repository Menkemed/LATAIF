# LATAIF v0.8.50

One correction, found on the phone in daily use: after leaving an item, the screen you left
could come back on top of the one you were looking at.

## Leaving an item now really leaves it

Save an item on the phone and go straight back to the search list, and a few seconds later
the item opened again — underneath the list of results, with a late "Saved." above it. The
saving itself was correct and the data was never wrong; what had gone wrong was that the
page was still waiting for the desktop to confirm a screen that no longer existed, and when
the confirmation arrived it drew that screen again.

Leaving an item now ends everything that belonged to it, immediately. That holds for the
back control, and equally for switching between Scan and Search, which leaves the item just
as much even though it is not called "back". Anything still on its way — the confirmation
after a save, a scanned lookup, the retry read, the check history of the item — arrives to
find that its screen is gone and does nothing: it draws nothing, writes no message, and
starts no further read.

The check history deserves its own mention: it wrote into places that exist in the next item
too, so a slow answer for one item could land in a different one that had since been opened.
It is now bound to the item that asked for it.

## What this does not touch

Going back still restores the search exactly as it was — the same query, the same results in
the same order, and the same scroll position; nothing is fetched again. Opening a hit still
reads the item fresh from the desktop.

And a save that was already accepted stays accepted. Only the waiting and the drawing are
called off when you navigate away; the job itself is durable, travels on and is applied by
the desktop. Walking away from a save does not undo it.

The note from v0.8.49 about a newly added photo still stands unchanged: a photo that does not
exist yet has no identity the phone could know in advance, so the page shows you the resulting
gallery instead of claiming it identified that particular photo.

## Nothing to migrate

No database change, no migration, no cleanup of existing items.
