import { useEffect, useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { PhoneInput } from '@/components/ui/PhoneInput';
import { SoftWarn } from '@/components/ui/SoftWarn';
import { DuplicateWarningBanner } from '@/components/contacts/DuplicateWarningBanner';
import { findSimilarContacts } from '@/core/contacts/duplicate-check';
import { validateCpr, validatePhone } from '@/core/contacts/contact-validate';
import { useCustomerStore } from '@/stores/customerStore';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (customerId: string) => void;
}

export function QuickCustomerModal({ open, onClose, onCreated }: Props) {
  const { createCustomer, customers, loadCustomers } = useCustomerStore();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [vatAccountNumber, setVatAccountNumber] = useState('');
  const [personalId, setPersonalId] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (open) loadCustomers(); }, [open, loadCustomers]);

  function reset() {
    setFirstName(''); setLastName(''); setPhone(''); setWhatsapp(''); setVatAccountNumber(''); setPersonalId('');
  }

  // Duplicate-Check live waehrend der Eingabe.
  const duplicateMatches = useMemo(() => {
    if (!firstName.trim() && !lastName.trim() && !phone && !whatsapp) return [];
    return findSimilarContacts(
      { firstName: firstName.trim(), lastName: lastName.trim(), phone, whatsapp },
      customers,
    );
  }, [firstName, lastName, phone, whatsapp, customers]);

  function handleSave() {
    if (!firstName.trim() && !lastName.trim()) {
      alert('Please enter at least a first or last name.');
      return;
    }
    setSaving(true);
    try {
      const c = createCustomer({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        phone: phone.trim() || undefined,
        whatsapp: whatsapp.trim() || undefined,
        vatAccountNumber: vatAccountNumber.trim() || undefined,
        personalId: personalId.trim() || undefined,
      });
      onCreated(c.id);
      reset();
      onClose();
    } catch (e) {
      alert(`Could not create customer: ${e instanceof Error ? e.message : String(e)}`);
    }
    setSaving(false);
  }

  return (
    <Modal
      open={open}
      onClose={() => { reset(); onClose(); }}
      title="New Client"
      width={460}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {duplicateMatches.length > 0 && (
          <DuplicateWarningBanner
            matches={duplicateMatches}
            entityLabel="client"
            onSelectMatch={c => { onCreated(c.id); reset(); onClose(); }}
          />
        )}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Input label="FIRST NAME" value={firstName} onChange={e => setFirstName(e.target.value)} autoFocus />
          <Input label="LAST NAME" value={lastName} onChange={e => setLastName(e.target.value)} />
        </div>
        <div>
          <PhoneInput label="PHONE" value={phone} onChange={setPhone} />
          <SoftWarn warning={validatePhone(phone).warning} />
        </div>
        <div>
          <PhoneInput label="WHATSAPP" value={whatsapp} onChange={setWhatsapp} />
          <SoftWarn warning={validatePhone(whatsapp).warning} />
        </div>
        <div>
          <Input label="PERSONAL ID (CPR / PASSPORT)" placeholder="e.g. 900123456" value={personalId} onChange={e => setPersonalId(e.target.value)} />
          <SoftWarn warning={validateCpr(personalId).warning} />
        </div>
        <Input label="VAT ACCOUNT NUMBER (optional)" placeholder="For NBR B2B export" value={vatAccountNumber} onChange={e => setVatAccountNumber(e.target.value)} />
        <div className="flex justify-end gap-3" style={{ paddingTop: 8, borderTop: '1px solid #E5E9EE' }}>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button variant="primary" onClick={handleSave} disabled={saving}>
            {duplicateMatches.length > 0 ? 'Create anyway' : 'Create & Select'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
