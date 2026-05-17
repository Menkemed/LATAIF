// PhoneInput — Country-Dropdown + National-Number-Input.
//
// API:
//   <PhoneInput
//     label="PHONE"
//     value={form.phone}           // E.164-String (z.B. "+97336123456") oder leerer String
//     onChange={v => setForm({ ...form, phone: v })}
//     placeholder="3612 3456"      // optional, default = Country.example
//   />
//
// onChange liefert IMMER E.164 oder leerer String wenn das National-Feld leer ist.
// Beim Mounting wird value per Prefix-Match auf einen Country gemapped — funktioniert
// auch fuer Legacy-Daten (rohe Strings ohne '+': landen unter Default-Country).

import { useEffect, useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { COUNTRIES, splitPhone, joinPhone, digitsOnly, type CountryCode } from '@/core/contacts/country-codes';
import { useCountryCodesStore } from '@/core/contacts/country-codes-store';

interface PhoneInputProps {
  label?: string;
  value: string | undefined | null;
  onChange: (e164: string) => void;
  placeholder?: string;
  required?: boolean;
  helper?: string;
  disabled?: boolean;
}

export function PhoneInput({ label, value, onChange, placeholder, required, helper, disabled }: PhoneInputProps) {
  // Built-in + custom Liste aus Settings mergen. Custom-Eintraege erscheinen nach Built-in.
  const customCountries = useCountryCodesStore(s => s.customCountries);
  const loadCustom = useCountryCodesStore(s => s.load);
  const customLoaded = useCountryCodesStore(s => s.loaded);
  useEffect(() => { if (!customLoaded) loadCustom(); }, [customLoaded, loadCustom]);
  const allCountries = useMemo(() => [...COUNTRIES, ...customCountries], [customCountries]);

  // Initial-Split aus dem persistierten E.164-Wert.
  const initial = useMemo(() => splitPhone(value, allCountries), [value, allCountries]);
  const [country, setCountry] = useState<CountryCode>(initial.country);
  const [national, setNational] = useState<string>(initial.national);
  const [openDD, setOpenDD] = useState(false);

  // Wenn der parent value von aussen wechselt (z.B. Reset oder Edit-Loading), nachziehen.
  useEffect(() => {
    const s = splitPhone(value, allCountries);
    setCountry(s.country);
    setNational(s.national);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, allCountries]);

  function commit(nextCountry: CountryCode, nextNational: string) {
    setCountry(nextCountry);
    setNational(nextNational);
    onChange(joinPhone(nextCountry, nextNational));
  }

  function handleNationalChange(raw: string) {
    // Nur Digits erlauben; Whitespace und Trennzeichen werden gestrippt, Anzeige-Format
    // kann der User selbst nach Geschmack auf einen visuellen Separator setzen.
    const d = digitsOnly(raw);
    // Soft-Limit auf maxLength + 4 (lasse etwas Puffer fuer internationale Nummern mit Suffix).
    const max = (country.maxLength || 15) + 4;
    commit(country, d.slice(0, max));
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, position: 'relative' }}>
      {label && (
        <label className="text-overline" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {label}{required && <span style={{ color: '#DC2626' }}>*</span>}
        </label>
      )}
      <div
        style={{
          display: 'flex',
          alignItems: 'stretch',
          background: 'transparent',
          borderBottomStyle: 'solid', borderBottomWidth: 1, borderBottomColor: disabled ? '#E5E9EE' : '#D5D9DE',
          paddingBottom: 0,
        }}
      >
        {/* Country selector */}
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpenDD(v => !v)}
          className="cursor-pointer transition-colors"
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '8px 10px 8px 0',
            background: 'transparent', border: 'none', outline: 'none',
            fontSize: 14, color: '#0F0F10', minWidth: 92,
          }}
        >
          <span style={{ fontSize: 16, lineHeight: 1 }}>{country.flag}</span>
          <span className="font-mono" style={{ fontSize: 13 }}>{country.dial}</span>
          <ChevronDown size={12} style={{ opacity: 0.6 }} />
        </button>

        {/* National number */}
        <input
          type="tel"
          inputMode="numeric"
          autoComplete="tel-national"
          disabled={disabled}
          value={national}
          placeholder={placeholder || country.example || ''}
          onChange={e => handleNationalChange(e.target.value)}
          onFocus={e => { if (!disabled) e.currentTarget.parentElement!.style.borderBottomColor = '#0F0F10'; }}
          onBlur={e => { e.currentTarget.parentElement!.style.borderBottomColor = '#D5D9DE'; }}
          style={{
            flex: 1, minWidth: 0,
            background: 'transparent', border: 'none', outline: 'none',
            padding: '8px 0', fontSize: 14, color: '#0F0F10',
          }}
        />
      </div>

      {/* Country dropdown */}
      {openDD && !disabled && (
        <div
          style={{
            position: 'absolute', top: '100%', left: 0, zIndex: 50,
            marginTop: 4, minWidth: 260,
            background: '#FFFFFF', border: '1px solid #E5E9EE', borderRadius: 8,
            boxShadow: '0 6px 20px rgba(15,15,16,0.08)', overflow: 'hidden',
          }}
        >
          {allCountries.map(c => (
            <button
              key={c.iso}
              type="button"
              onClick={() => { setOpenDD(false); commit(c, national); }}
              className="cursor-pointer transition-colors"
              style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                padding: '8px 12px', background: c.iso === country.iso ? 'rgba(15,15,16,0.06)' : 'transparent',
                border: 'none', textAlign: 'left', fontSize: 13, color: '#0F0F10',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = '#F2F7FA')}
              onMouseLeave={e => (e.currentTarget.style.background = c.iso === country.iso ? 'rgba(15,15,16,0.06)' : 'transparent')}
            >
              <span style={{ fontSize: 16 }}>{c.flag}</span>
              <span style={{ flex: 1 }}>{c.label}</span>
              <span className="font-mono" style={{ fontSize: 12, color: '#6B7280' }}>{c.dial}</span>
            </button>
          ))}
        </div>
      )}

      {helper && <span style={{ fontSize: 11, color: '#6B7280' }}>{helper}</span>}
    </div>
  );
}
