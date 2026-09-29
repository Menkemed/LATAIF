# LATAIF v0.8.70

The Excel import now fills Gold-Diamond Jewellery exactly like the item form.

- **Item Type and Karat & Color:** Gold-Diamond Jewellery rows get the same fields as when the
  item is entered by hand — Item Type, Karat & Color, Weight, Description, Stones. Use the new
  columns "Item Type" and "Karat & Color"; spelling does not matter ("rings", "18k yellow").
- **Older files still import:** "Karat" / "Carat" together with "Metal" / "Material" become
  Karat & Color (e.g. 18 + White Gold → 18K White; 21, 22 and 24 are always Yellow). Nothing is
  guessed — without a clear color the preview warns. "Material" is never used as Item Type.
- **No brand or model needed** for Gold-Diamond Jewellery; the item is named from its details
  (e.g. "Ring · Diamond Ring · 18K Yellow · 6.40 g"). Values without their own field (Serial,
  Size, Markup, Description 2/3) are kept in the item notes.
- **Template, "How to", expected columns and preview** show the gold fields. Stones work as in
  v0.8.69.
- Watches and all other categories import exactly as before.

Update the main computer first, then the second computer. No data is changed by the update.
