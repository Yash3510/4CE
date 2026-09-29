import type { PiiType } from '../pii/types';

export interface Settings {
  serverUrl: string;
  maxSteps: number;
  faces: boolean;
  ocr: boolean;
  /** Re-read the composed frame with OCR and patch anything readable before sending. */
  verifyFrame: boolean;
  marks: boolean;
  maxWidth: number;
  jpegQuality: number;
  /** Values that must never reach the server (the testbed plants these). */
  canaries: string[];
  /** Pause between steps, so an audience can follow a live run. */
  stepPauseMs: number;
}

export const DEFAULT_SETTINGS: Settings = {
  serverUrl: 'http://localhost:8765',
  maxSteps: 15,
  faces: true,
  ocr: true,
  verifyFrame: true,
  marks: true,
  maxWidth: 1280,
  jpegQuality: 0.8,
  canaries: [],
  stepPauseMs: 0,
};

export type Profile = Partial<Record<PiiType, string>>;

export const PROFILE_FIELDS: { type: PiiType; label: string; placeholder: string }[] = [
  { type: 'NAME', label: 'Full name', placeholder: 'Ananya Iyer' },
  { type: 'EMAIL', label: 'Email', placeholder: 'you@example.in' },
  { type: 'PHONE', label: 'Mobile', placeholder: '98xxxxxxxx' },
  { type: 'DOB', label: 'Date of birth', placeholder: 'dd/mm/yyyy' },
  { type: 'ADDRESS', label: 'Address', placeholder: 'House, street, city' },
  { type: 'PINCODE', label: 'PIN code', placeholder: '560034' },
  { type: 'AADHAAR', label: 'Aadhaar', placeholder: '12 digits' },
  { type: 'PAN', label: 'PAN', placeholder: 'ABCDE1234F' },
  { type: 'ACCOUNT', label: 'Bank account', placeholder: 'account number' },
  { type: 'IFSC', label: 'IFSC', placeholder: 'SBIN0001234' },
  { type: 'UPI', label: 'UPI ID', placeholder: 'name@okaxis' },
];

export async function loadSettings(): Promise<Settings> {
  const { settings } = await browser.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings as Partial<Settings> | undefined) };
}
export async function saveSettings(s: Settings) {
  await browser.storage.local.set({ settings: s });
}
export async function loadProfile(): Promise<Profile> {
  const { profile } = await browser.storage.local.get('profile');
  return (profile as Profile) ?? {};
}
export async function saveProfile(p: Profile) {
  await browser.storage.local.set({ profile: p });
}
