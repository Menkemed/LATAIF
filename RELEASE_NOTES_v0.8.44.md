# LATAIF v0.8.44

A follow-up to v0.8.43: three things you pointed out about Backup & Restore, and one contradiction
underneath them that mattered more than it looked.

## Backup & Restore is easier to read

- The old **Export Backup** and **Restore from Backup** buttons in the Danger Zone are gone. Both
  were left over from before proper snapshots existed, and the restore one could not actually
  restore anything in the desktop app — it reported success and changed nothing. Use **Create
  backup** and the snapshot list; those take the databases and all images together, and verify
  themselves.
- The snapshot list now sits directly under the button that loads it, with its own **Available
  snapshots** heading, instead of trailing the media-cleanup section and looking like part of it.
- Each snapshot shows its creation time labelled as **local time**, plus its folder name. The folder
  on disk is named in UTC — that is deliberate, a folder name cannot shift with a timezone — so
  seeing both makes the few hours' difference obvious instead of puzzling.

## Moving your data is tidier

- Moving the data location no longer copies LATAIF's own bookkeeping files into the new folder.
  They belong next to the program's settings, not with your data, and copies in the data folder were
  dead weight that looked meaningful.
- If an earlier move already left such copies behind, they are cleaned up on the next start — but
  only when it can be proven they are the dead copies and not the real ones. Anything uncertain is
  left exactly where it is.

## One definition of "an image we need"

Backing up and moving disagreed about which image files matter, which is why a backup could be
complete and yet the data could not be moved afterwards.

- **Both now mean the same thing:** every image any product, list, export or phone screen can
  actually show. That is what a backup contains, that is what a move insists on, and that is what a
  restore gives you back.
- **A missing image that something really uses is still a hard stop.** Nothing was loosened there.
- **Leftovers from an upload that was never finished no longer block a move.** They are invisible to
  you, no screen refers to them, and they were the reason a perfectly good backup could not be moved.
- Cleaning up unused media stays deliberately cautious: it still protects older versions of your
  images and anything an upload is still working on, and it still deletes only after you confirm.
