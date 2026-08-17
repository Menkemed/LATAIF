# LATAIF v0.8.45

Two small corrections to Backup & Restore.

## Snapshot folders now show your own clock

A backup taken at 22:42 used to sit in a folder named for 19:42. Neither number was wrong — the
folder was named in UTC, the list showed your local time — but nothing on the folder said so.

- New snapshots are named with the **local time you would have seen**, and the time zone is written
  into the name: `snap-2026-08-17T22-42-45_UTC+03-00_…`. Folder and list now agree, and the name
  still says exactly what it means on a machine in any other zone.
- **Existing snapshots keep their names.** Nothing is renamed. Old and new folders sit side by side
  and both list, restore and expire exactly as before.
- Ordering and the "keep the newest N" rule continue to use each snapshot's recorded creation
  moment, not its folder name, so a mixed set is always sorted correctly.

## A stray `·` in the snapshot list

The separator in each snapshot row was printed as its escape code instead of the character. It now
shows the intended `·`.
