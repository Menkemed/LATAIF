// Custom Country-Codes — vom User in Settings → Country Codes hinzugefuegt.
// Built-in COUNTRIES sind statisch im Code; hier kommen die zusaetzlichen Eintraege
// rein. Persistenz via `settings` Tabelle, Key = 'contacts.custom_countries',
// Value = JSON-Array.

import { create } from 'zustand';
import { query } from '@/core/db/helpers';
import { getDatabase, saveDatabase } from '@/core/db/database';
import type { CountryCode } from './country-codes';

const SETTING_KEY = 'contacts.custom_countries';
const SETTING_BRANCH = 'branch-main';

interface CountryCodesState {
  customCountries: CountryCode[];
  loaded: boolean;
  load: () => void;
  saveAll: (list: CountryCode[]) => void;
  add: (c: CountryCode) => void;
  update: (iso: string, patch: Partial<CountryCode>) => void;
  remove: (iso: string) => void;
}

function isValidCountry(c: unknown): c is CountryCode {
  const o = c as Record<string, unknown>;
  return typeof o?.iso === 'string'
      && typeof o?.dial === 'string'
      && typeof o?.label === 'string'
      && typeof o?.flag === 'string';
}

export const useCountryCodesStore = create<CountryCodesState>((set, get) => ({
  customCountries: [],
  loaded: false,

  load: () => {
    try {
      const rows = query(
        'SELECT value FROM settings WHERE branch_id = ? AND key = ?',
        [SETTING_BRANCH, SETTING_KEY]
      );
      if (rows.length > 0 && rows[0].value) {
        const parsed = JSON.parse(rows[0].value as string);
        if (Array.isArray(parsed)) {
          set({ customCountries: parsed.filter(isValidCountry), loaded: true });
          return;
        }
      }
    } catch (err) {
      console.warn('[country-codes-store] load failed:', err);
    }
    set({ customCountries: [], loaded: true });
  },

  saveAll: (list: CountryCode[]) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO settings (branch_id, key, value, category, updated_at)
       VALUES (?, ?, ?, 'contacts', ?)
       ON CONFLICT(branch_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [SETTING_BRANCH, SETTING_KEY, JSON.stringify(list), now]
    );
    saveDatabase();
    set({ customCountries: list, loaded: true });
  },

  add: (c) => {
    // iso muss eindeutig sein. Wenn schon vorhanden — replace.
    const next = [...get().customCountries.filter(x => x.iso !== c.iso), c];
    get().saveAll(next);
  },

  update: (iso, patch) => {
    const next = get().customCountries.map(c => c.iso === iso ? { ...c, ...patch } : c);
    get().saveAll(next);
  },

  remove: (iso) => {
    const next = get().customCountries.filter(c => c.iso !== iso);
    get().saveAll(next);
  },
}));
