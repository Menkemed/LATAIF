# LATAIF v0.8.49

Fixes for what the phone showed after the last update: the page itself, and what it says
after you press Save.

## The phone no longer keeps yesterday's page

After updating to v0.8.48 a phone could keep serving the previous version of the capture
page from its own cache — with the old edit fields, and without the fresh read. The server
had never said whether its answers may be reused, so the browser decided for itself. Every
answer that can change now says it must not be stored: the page, the search, an item read,
the check history. Photos are the exception and stay cached, because a photo is stored
under a name derived from its content and can never change behind that name.

Returning to the page with the phone's own back gesture is a different thing, and it gets
its own handling: a restored page re-reads the item it is showing instead of trusting the
screen it was restored with.

## After "Saved." you see what was saved

The detail view used to keep showing the values from the moment you opened the item, even
after a successful save — which looked as if nothing had been stored. Saving is durable:
the job is queued and the desktop applies it a moment later. The page now waits for that
and then shows the item as the desktop stored it. Until then it says the save was accepted;
only the confirmed state gets "Saved." And if the desktop has not applied it within the
waiting time, it says exactly that instead of claiming success.

The confirmation is decided on content, not on timing: if someone edits the same item at
the desk while your job is still queued, that does not confirm your change. For photos,
what is checked is the resulting gallery — every photo you kept is still there and in the
order you asked for, every photo you removed is gone, and the cover is the one you chose.

A note on newly added photos: a photo that does not exist yet has no identity this phone
could know in advance, so the page confirms that a photo appeared where you asked for it,
and shows you the result — it does not claim to have identified that particular photo.

## The rest

Notes and what is included are now shown in the item's detail view; both were editable but
invisible there. An optional number field you never touched is no longer sent as a change,
so nothing is cleared that you did not clear yourself. Deliberately emptying a field still
works and still clears it.

## Nothing to migrate

No database change, no migration, no cleanup of existing items.
