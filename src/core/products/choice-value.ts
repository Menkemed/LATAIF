// ════════════════════════════════════════════════════════════════════════════
// CLEARABLE CHOICE FIELDS — one semantic for every clickable option control.
//
// The defect: the chip/toggle controls (select options, Yes/No) only ever ASSIGNED. Once a user had
// clicked "Two-Tone Steel/Gold" or "Yes", there was no gesture that got back to "nothing chosen" —
// the value could be changed but never removed, so an accidental click became permanent data.
//
// The semantic here is the obvious one and needs no extra UI: clicking the option that is already
// selected clears it. Every surface (create dialog, quick-add, edit) calls this function, so the
// three implementations that used to differ cannot drift again.
//
// ## Clearing means the key is GONE, not empty
//
// A cleared attribute is REMOVED from the object rather than set to `''`/`null`. That is the shape
// the rest of the product contract already expects:
//   • `hasValue()` treats an absent key as missing, so a REQUIRED field still blocks the save —
//     "clearable" is a UI capability, not a statement about requiredness (the SSOT owns that),
//   • `stripStaleAttributes()` deletes keys for the same reason, so both paths agree,
//   • the mobile v2 validator rejects unknown/stale keys, so leaving `karat_color: ''` behind would
//     make a product the desktop saved and the phone refuses.
//
// Non-attribute selections (condition, stock status, …) use `toggleChoice`, which returns the same
// verdict for a plain scalar.
// ════════════════════════════════════════════════════════════════════════════

export type ChoiceValue = string | number | boolean;

/** Are these the same choice? Compared by value, so a numeric option and its string form agree. */
export function isSameChoice(current: unknown, option: ChoiceValue): boolean {
  if (current === undefined || current === null) return false;
  if (typeof current === typeof option) return current === option;
  // A select stores what it rendered; a number attribute may round-trip as a string through a form.
  return String(current) === String(option);
}

/**
 * The new value after clicking `option` — `undefined` when the click CLEARS the field.
 *
 * Use for standalone selections that are not part of the attributes object.
 */
export function toggleChoice<T extends ChoiceValue>(current: unknown, option: T): T | undefined {
  return isSameChoice(current, option) ? undefined : option;
}

/**
 * The attributes object after clicking `option` on `key`.
 *
 * Pure — the input is never mutated. Clicking the selected option deletes the key entirely; any
 * other click assigns it.
 */
export function applyChoiceSelection<V extends Record<string, unknown>>(
  attrs: V | undefined,
  key: string,
  option: ChoiceValue,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(attrs ?? {}) };
  if (isSameChoice(next[key], option)) delete next[key];
  else next[key] = option;
  return next;
}

/** Did this click clear the field? Useful where the caller wants to react (e.g. clear an error). */
export function clearsChoice(attrs: Record<string, unknown> | undefined, key: string, option: ChoiceValue): boolean {
  return isSameChoice((attrs ?? {})[key], option);
}
