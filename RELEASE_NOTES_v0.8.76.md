# LATAIF v0.8.76

The phone upload queue keeps moving when a single job runs into a temporary problem.

- **Persistent retry with a wait:** a phone job that fails for a temporary reason is retried later
  instead of immediately again and again.
- **Independent items are not held up:** while such a job waits, later phone jobs for other items
  are processed.
- **Same item, same order:** jobs for the same item still run strictly in the order they were sent.
- **Wait between attempts:** 30 s → 1 min → 2 min → 5 min → 15 min → at most 30 min.
- **Survives restarts:** the retry state is kept when the app or the main computer restarts.
- **Locked staging files:** a phone photo that is briefly locked by another program (for example a
  backup or virus scanner) is retried instead of being wrongly set aside.
- **Unchanged:** jobs that can never succeed are still set aside with a clear reason, as since
  v0.8.75.

Update the main computer first, then the second computer. No existing data is changed; the update adds
one small table to the main computer's server store.
