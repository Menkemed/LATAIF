# LATAIF v0.8.69

Stones in the Excel import, and one fix for AI Identify on the phone.

- **Excel import with stones:** Gold-Diamond Jewellery items can bring their stones along. Each
  stone has its own column group — Stone 1 Type, Stone 1 Qty, Stone 1 Carat, Stone 1 Color,
  Stone 1 Clarity, Stone 1 Shape, Stone 1 Name — and Stone 2 …, Stone 3 … for more stones. The
  stones are checked exactly like on the desktop and the phone; a row with an invalid stone (e.g.
  "Other" without a name, a quantity of 2.5) is shown as invalid and not imported.
- **Diamond Weight:** calculated from the diamond rows with carat. Older files with only a Diamond
  Weight column still import as before — no stones are made up from it.
- **Download template** on the Import page: example rows (several stones per item) and a
  "How to" sheet with all allowed values. The preview shows the stones of every row.
- **Phone, AI Identify:** when the AI picks a material with gold (e.g. Two-Tone Steel/Gold),
  "Karat & Color" now appears straight away — in collection, purchase and consignment.

Update the main computer first, then the second computer. No data is changed by the update.
