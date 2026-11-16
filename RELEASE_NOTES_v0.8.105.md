# LATAIF v0.8.105

This version improves the Collections Excel, adds an Approval Excel and corrects the Approval print. Bookings, payments, VAT and stock are not changed.

- **Collections Excel** (Collections → Export Excel):
  - **One sheet per category** (Watches, Gold Jewelry, Accessories …), and at the end a **Total** sheet with one line per category:
    - items, in stock, sold, other status;
    - pieces in stock, stock value, planned sale value.

    Each category name on the Total sheet links to its sheet.
  - **Item details as columns:** every detail of the category (case size, dial, karat, weight, stones …) has its own column. Only columns that have at least one value are shown.
  - **Reference / Model No** is one column (reference number and model number are the same thing). It stands directly next to **Serial Number**.
    - "No", "Nr." and "#" in a detail name count as "Number", so "Serial No" and "Serial Number" share one column.
    - If an item has two different values for one column, both are shown ("A / B"); nothing is dropped.
  - Columns are grouped in a fixed order: item, details, purchase, prices, stock, other.
  - Each category sheet ends with its own TOTAL row.
- **Approval Excel (new)** (Approvals list and approval detail → **Export Excel**):
  - Same filter as the print: All / Sold / Open / Returned.
  - One sheet per approval client, and at the end a **Total** sheet with one line per client (with a link to the client's sheet).
  - Each item shows:
    - image, SKU, brand, name, category, condition;
    - the item details (Reference / Model No next to Serial Number);
    - transfer number and date, Return By (red when overdue), days on approval, status, sold and returned date;
    - Our Price, Sale Price, Amount Due, Paid, Outstanding;
    - the settlement model.
  - Amount Due, Paid and Outstanding are filled **only for sold items**.
  - No purchase prices, margins, notes or buyer details, so the file can be given to the client.
- **Approval print (Print Items) corrected:**
  - **Outstanding is now correct.** It only counts items that are sold and not fully paid. Before, the Our Price of every item still with the client, or already returned, was shown as outstanding (for example 2,060 BHD with nothing sold). Paid and Outstanding show "—" for items that are not sold.
  - The summary line also shows **Paid**, and the table ends with a **Total** row.
  - **A4 portrait** with normal margins:
    - all columns fit the page width and nothing is cut off;
    - the table header repeats on every page;
    - a row is never split across two pages.
  - **Small product image** for each item (the same main image as in the Excel, reduced for printing). Printing starts once the images are loaded. An image that cannot be loaded is left out; the print still runs.
  - **Includes: Box · Papers · Warranty Card …** under the item, only when the item has them (older items with the Box/Papers yes/no field count too).
  - The **Ref / Serial** column shows SKU, reference, model number and serial number, each on its own line.
  - The grey detail line no longer repeats what is shown elsewhere:
    - no reference or serial number;
    - for jewellery without brand: no type, karat or weight, because the name already shows them;
    - no diamond weight in front of the stones.
  - Print and Approval Excel show the same items and the same amounts for every filter.
- **Consignment print:** also prints on A4 with the repeating table header. Columns and amounts are unchanged.

**Database:** no change (no new table or column). The update does not change any booking, payment, VAT, stock, item or photo. All three exports only read data.

**Known limits:**
- **Box/Papers in Excel:**
  - "Includes" (Box, Papers …) is shown in the Approval print, not in the two Excel files.
  - Some older jewellery and accessory items still have Box/Papers/Certificate as fields outside the category definition (34 values). These are not in the Collections Excel; the version before had no detail columns at all.
- **Approval print:** with many items, preparing the images takes a few seconds before the print dialog opens.
- **Unchanged from v0.8.104:**
  - Existing photos keep their size.
  - Remove (approval transfers) has no extra role check.
  - Older repairs book header costs at "Ready".
  - Supplier returns: a gain has no account; VAT on refunded added costs is not calculated.
  - Partners: production with a joint item and correcting a joint purchase line stay blocked.

**Before you update** (the main computer is on v0.8.104; the second computer is still on v0.8.101):

1. Stop entering anything on the phone, and wait until every phone upload has been processed on the main computer.
2. Check **Unresolved saves** on the second computer. Clarify open entries; do not remove them blindly.
3. Close both computers.
4. Make a full archive copy of the data folder (both databases, the complete media folder, the staging folders and the key files) on E: and F:, and check it.

**Update** the main computer first, then the second computer. Mixed versions work; the exports and the print run on each computer with its own version.
