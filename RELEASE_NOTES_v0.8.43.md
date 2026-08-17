# LATAIF v0.8.43

## Your data can live where you want it

Until now LATAIF kept its databases and images in a Windows application folder, and there was no way
to say otherwise. This release makes the data location something you choose — and, importantly, does
so without moving anything you did not ask it to move.

- **Updating changes nothing.** An existing installation keeps working from exactly the folder it
  already uses. Same databases, same images, same paths. There is no question to answer and no
  migration to sit through.
- **Settings → Data Location** now shows where your data actually is, next to where your backups go.
- **Move Data Location** is there when you want it, behind the owner password. Pick a folder — on
  another drive if you like — and LATAIF moves everything: the business database, the sync-server
  database, the images and the mobile upload staging.

## Moving is a copy, never a gamble

The move is deliberately unhurried, because it is the one operation that touches every byte the
business owns.

1. Everything is **copied** to the new location while the app is closed, so nothing is copied
   mid-write.
2. The copy is **verified** — every file present, every file identical, both databases intact, every
   image a product refers to actually there.
3. Only then does LATAIF switch over and restart into the new location.

- **Your old data folder is kept.** After a successful move it is still there, complete and
  untouched. LATAIF does not delete it, and this version has no button that would.
- **If anything goes wrong, you keep working.** A failed copy, a failed check, a power cut in the
  middle — in every case LATAIF comes back on the data it had before, and tells you what happened.
- If the new location turns out to be unreachable after the switch — an external drive unplugged, a
  folder deleted — LATAIF returns to the previous one rather than starting empty.

## Knowing which data is the real data

- LATAIF now records where its data lives and marks that folder as its own. If the two ever
  disagree, or the folder cannot be reached, the app **stops and says so** instead of quietly
  opening an older copy. Seeing months-old data and not realising it is the failure this prevents.
- Before a move it checks that the destination is empty, is not inside (or containing) either your
  current data folder or your backup folder, is not inside the program folder, and has enough free
  space.
- **Backups stay separate.** Your backup location is yours; a move never changes it, and the two
  locations are not allowed to sit inside one another.
- A backup, a restore, a cleanup and a data move can no longer be scheduled on top of each other —
  whichever you started finishes first.
- The automatic safety copy taken before a destructive action in Settings now goes to your
  **configured** backup location, like every other backup. Previously it always went to the
  application folder, which on this installation was a different drive entirely.
