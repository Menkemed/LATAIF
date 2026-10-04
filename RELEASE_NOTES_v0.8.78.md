# LATAIF v0.8.78

Phone: adding photos to an existing item from the gallery, and safer photo saves.

- **Gallery for existing items:** Mobile → Check Item → Edit → Photos now offers "Take photo" and
  "Choose from gallery" — several pictures can be chosen at once.
- **Photos are added, not replaced:** existing photos stay; the new ones are added to the gallery.
- **No duplicates on retry:** if the answer to a photo save is lost, saving again does not add any
  photo twice.
- **Changed selection after a lost answer:** the phone first clarifies the earlier save and then saves
  the new selection on the confirmed state — the latest change is kept.
- **Clear conflict message:** if the item was changed on another device, the phone now says so
  ("Item changed on another device. Reload before saving your photo changes.") instead of only
  "accepted, but not applied yet".
- **Upload status:** a new read-only status endpoint lets the phone check its own photo job only.

No existing data is changed. Update the main computer first, then the second computer.
