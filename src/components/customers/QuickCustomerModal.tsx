import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useCustomerStore } from '@/stores/customerStore';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (customerId: string) => void;
}

export function QuickCustomerModal({ open, onClose, onCreated }: Props) {
  const { createCustomer } = useCustomerStore();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [vatAccountNumber, setVatAccountNumber] = useState('');
  const [personalId, setPersonalId] = useState('');
  const [saving, setSaving] = useState(false);

  function reset() {
    setFirstName(''); setLastName(''); setPhone(''); setWhatsapp(''); setVatAccountNumber(''); setPersonalId('');
  }

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
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Input label="FIRST NAME" value={firstName} onChange={e => setFirstName(e.target.value)} autoFocus />
          <Input label="LAST NAME" value={lastName} onChange={e => setLastName(e.target.value)} />
        </div>
        <Input label="PHONE" placeholder="+973..." value={phone} onChange={e => setPhone(e.target.value)} />
        <Input label="WHATSAPP" placeholder="+973..." value={whatsapp} onChange={e => setWhatsapp(e.target.value)} />
        <Input label="PERSONAL ID (CPR / PASSPORT)" placeholder="e.g. 900123456" value={personalId} onChange={e => setPersonalId(e.target.value)} />
        <Input label="VAT ACCOUNT NUMBER (optional)" placeholder="For NBR B2B export" value={vatAccountNumber} onChange={e => setVatAccountNumber(e.target.value)} />
        <div className="flex justify-end gap-3" style={{ paddingTop: 8, borderTop: '1px solid #E5E9EE' }}>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button variant="primary" onClick={handleSave} disabled={saving}>Create & Select</Button>
        </div>
      </div>
    </Modal>
  );
}
