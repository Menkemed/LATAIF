const colorMap: Record<string, string> = {
  available: '#7EAA6E', in_stock: '#7EAA6E',
  reserved: '#0F0F10',
  offered: '#AA956E',
  sold: '#6B7280',
  consignment: '#6E8AAA',
  draft: '#6B7280',
  sent: '#6E8AAA',
  viewed: '#AA956E',
  accepted: '#7EAA6E',
  rejected: '#AA6E6E',
  expired: '#6B7280',
  issued: '#AA956E',
  partially_paid: '#0F0F10',
  paid: '#7EAA6E',
  overdue: '#AA6E6E',
  cancelled: '#6B7280',
  lead: '#6E8AAA',
  qualified: '#AA956E',
  active: '#7EAA6E',
  dormant: '#6B7280',
  lost: '#AA6E6E',
  profit: '#7EAA6E',
  loss: '#AA6E6E',
  pending: '#AA956E',
  info: '#6E8AAA',
  // Repair
  received: '#6E8AAA',
  diagnosed: '#AA956E',
  in_progress: '#0F0F10',
  ready: '#7EAA6E',
  picked_up: '#6B7280',
  // Stock
  in_repair: '#AA956E',
  with_agent: '#6E8AAA',
  on_order: '#0F0F10',
  // Consignment
  paid_out: '#7EAA6E',
  returned: '#6B7280',
  returned_to_owner: '#6B7280',
  // Agent
  transferred: '#6E8AAA',
  settled: '#7EAA6E',
  partial: '#AA956E',
  // Order
  deposit_received: '#0F0F10',
  sourcing: '#AA956E',
  sourced: '#6E8AAA',
  arrived: '#7EAA6E',
  notified: '#0F0F10',
  completed: '#7EAA6E',
  // Plan §Loan canonical
  open: '#AA6E6E',
  partially_repaid: '#AA956E',
  repaid: '#7EAA6E',
  // Plan §Repair canonical extras
  sent_to_workshop: '#AA956E',
  delivered: '#6B7280',
  // Plan §Sales canonical
  partial_invoice: '#AA956E',
  final: '#7EAA6E',
  // Plan §Purchases / Returns
  unpaid: '#AA6E6E',
  confirmed: '#7EAA6E',
  refunded: '#7EAA6E',
  requested: '#AA956E',
  approved: '#7EAA6E',
  closed: '#6B7280',
};

interface StatusDotProps {
  status: string;
  label?: string;
}

// User-Naming: "FINAL" → "Paid", "PARTIAL" → "Partially Paid", "DRAFT" → "Pending" für Sales/Invoices.
const SALES_LABEL_MAP: Record<string, string> = {
  final: 'Paid',
  partial: 'Partially Paid',
  draft: 'Pending',
};

export function StatusDot({ status, label }: StatusDotProps) {
  const key = String(status || '').toLowerCase();
  const displayLabel = label
    || SALES_LABEL_MAP[key]
    || String(status || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const color = colorMap[key] || '#6B7280';

  return (
    <span className="inline-flex items-center gap-2">
      <span
        className="rounded-full shrink-0"
        style={{ width: 6, height: 6, background: color }}
      />
      <span style={{ fontSize: 13, color: '#0F0F10' }}>{displayLabel}</span>
    </span>
  );
}
