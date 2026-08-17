// ════════════════════════════════════════════════════════════════════════════
// DATA-ROOT-I1 / B2 — pure logic behind the Move Data Location panel.
//
// Kept out of the component so the two things worth testing are testable without a DOM: what the
// owner is told when a target is refused, and whether the confirm button may fire at all.
//
// Every refusal here has to answer "what do I do now?", not just "no". The backup-overlap case is
// the one that will actually happen: the live install keeps backups at `E:\`, so a perfectly
// sensible-looking `E:\LATAIF\Data` puts the data set inside the backup root. Telling someone
// "invalid path" would be true and useless; telling them to point backups at `E:\LATAIF\Backups`
// first is the whole difference between a dead end and a next step. We never change the backup
// location for them — that is their decision, made in the panel right above this one.
// ════════════════════════════════════════════════════════════════════════════

export function explainMoveCode(code: string): string {
  switch (code) {
    case 'MOVE_TARGET_OVERLAPS_BACKUP_ROOT':
      return 'The data folder and the backup folder must not contain each other. Set the backup location to a separate folder first (for example E:\\LATAIF\\Backups), then move the data to E:\\LATAIF\\Data.';
    case 'MOVE_TARGET_IS_SOURCE':
      return 'That is already the current data location.';
    case 'MOVE_TARGET_OVERLAPS_SOURCE':
      return 'The new folder must not contain, or sit inside, the current data folder.';
    case 'MOVE_TARGET_OVERLAPS_APP_FOLDER':
      return 'The data must not live inside the program folder — an update would put it at risk.';
    case 'MOVE_TARGET_NOT_EMPTY':
      return 'That folder is not empty. Choose an empty folder or create a new one; nothing there will ever be overwritten.';
    case 'MOVE_TARGET_HAS_LATAIF_DATA':
      return 'That folder already contains a LATAIF data set. Two data sets are never merged — choose an empty folder.';
    case 'MOVE_INSUFFICIENT_SPACE':
      return 'Not enough free space at the destination for a complete copy.';
    case 'MOVE_FREE_SPACE_UNKNOWN':
      return 'The free space at the destination could not be determined, so the copy was not started.';
    case 'MOVE_TARGET_NOT_WRITABLE':
      return 'That folder cannot be written to. Check the drive is connected and you have permission.';
    case 'MOVE_TARGET_UNREACHABLE':
      return 'That location cannot be reached right now.';
    case 'MOVE_TARGET_NOT_ABSOLUTE':
    case 'MOVE_TARGET_NOT_NORMALIZABLE':
      return 'That path could not be checked safely, so it was refused.';
    case 'MOVE_SOURCE_HAS_REPARSE_POINT':
      return 'The current data folder contains a shortcut or junction. Please contact support — moving it could silently lose data.';
    case 'MOVE_ALREADY_PENDING':
      return 'A move is already scheduled. Restart the app to complete it.';
    case 'MOVE_BLOCKED_BY_MAINTENANCE':
      return 'Another maintenance action (backup, restore or cleanup) is still pending. Restart the app first.';
    case 'MOVE_OPERATION_PENDING':
      return 'A data move is scheduled. Restart the app to complete it before running anything else.';
    case 'PRIMARY_OWNER_INVALID_CREDENTIALS':
    case 'OWNER_INVALID_CREDENTIALS':
      return 'Owner email or password is not correct.';
    default:
      return 'The data location could not be changed.';
  }
}

/** Only a code — never a path, a hash or a raw error string — ever reaches the DOM. */
export function sanitizeMoveError(e: unknown): string {
  const raw = typeof e === 'string' ? e : (e as { message?: string })?.message ?? '';
  const code = raw.trim().split(/\s+/)[0] ?? '';
  return explainMoveCode(code);
}

export interface MoveGateInput {
  email: string;
  password: string;
  target: string | null;
  planned: boolean;
  busy: boolean;
  pending: boolean;
}

/**
 * The confirm button opens only when the owner is identified, a target has been chosen AND
 * successfully preflighted, nothing else is in flight, and no move is already scheduled. `busy` is
 * what makes a double click harmless: the second click sees the first one's state.
 */
export function canConfirmMove(i: MoveGateInput): boolean {
  return (
    i.email.trim().length > 0 &&
    i.password.length > 0 &&
    !!i.target &&
    i.planned &&
    !i.busy &&
    !i.pending
  );
}
