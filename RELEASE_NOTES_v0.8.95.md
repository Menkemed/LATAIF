# LATAIF v0.8.95

Repairs: who does the work is now shown from the work itself, work and material are kept apart, the list shows the invoice, and costs are never counted twice.

- **Repair — who does the work:** **In-house**, **External workshop** or **Hybrid** now follows the active work lines.
  Only own work is In-house, only a workshop is External, both is Hybrid. Material never changes it, and a material
  supplier is never treated as the workshop. The type is only changed when costs and the status path stay the same;
  otherwise it stays and the reason is written to the audit log.
- **New repair — "Who does the work?":** replaces the type buttons. A workshop without a fee is only **planned**: it books
  nothing until a work line exists. With a fee it works as before.
- **Repair list:** new columns and the filters **Work Type**, **Work Source**, **Workshop** and **Invoice**
  (All / Invoice Created / Not Created). The **Invoice** column shows the invoice number and opens the invoice, and
  shows **Invoice Draft**, **Invoice cancelled** or a marked **Invoice not found** (data problem).
- **Quick Edit and repair detail:** **Work / Labour** and **Materials / Parts** are separate, each with its total. Own
  work may cost 0.000; a workshop line needs a cost above zero. The same rules apply on the main computer, the second
  computer and the phone.
- **Repair costs:**
  - An amount on an external repair that only mirrored the estimate no longer counts next to the workshop line
    (a fee of 25 with polishing was 50, now 25). It is removed only with proof from the creation record; otherwise the
    repair stays External, the amount stays and does not count, and the conflict is written to the audit log.
  - The workshop fee of an older repair stays next to material and own work until a work line of that workshop replaces
    it, without a second payable. While the fee applies, a work line of another workshop is refused.
  - Existing repairs change only when one of their lines is changed.
- **Type conflict:** when the stored type and the work lines disagree, both are shown, for example
  **Hybrid (saved as External workshop)**. Costs, status and bookings stay as they are.

**Database:** the update adds one column to repairs (planned workshop). The migration runs by itself at the first start
and does not change existing repairs, repair lines, invoices, payments, purchases, bookings or media.

**Known open points, not fixed in this version:**

- Second computer: after a lost answer while changing a repair status, the button to save again can be missing. The
  entry stays under **Unresolved saves**; clarify it there before saving again.
- Editing Tudor items is still open.

**Before you update:** make a fresh backup of the main computer and check it. In addition, keep a full archive copy
of both databases and the complete media folder (all files, no cleanup — the app backup contains only photos that are
still in use).

**Update** the main computer first and the second computer straight after it.
