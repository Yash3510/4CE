// PII classes 4CE recognises, and how each one is hidden in the outgoing frame.

export type PiiType =
  | 'PASSWORD'
  | 'OTP'
  | 'CVV'
  | 'CARD'
  | 'CARD_EXP'
  | 'AADHAAR'
  | 'PAN'
  | 'GSTIN'
  | 'PASSPORT'
  | 'VOTER_ID'
  | 'ACCOUNT'
  | 'IFSC'
  | 'UPI'
  | 'EMAIL'
  | 'PHONE'
  | 'NAME'
  | 'ADDRESS'
  | 'PINCODE'
  | 'DOB'
  | 'USERNAME'
  | 'FACE'
  | 'TEXT_IN_IMAGE';

/** How a class is drawn over the screenshot before it leaves the device. */
export type RedactStyle = 'blackout' | 'token' | 'blur';

export const STYLE: Record<PiiType, RedactStyle> = {
  PASSWORD: 'blackout',
  OTP: 'blackout',
  CVV: 'blackout',
  CARD: 'blackout',
  CARD_EXP: 'token',
  AADHAAR: 'token',
  PAN: 'token',
  GSTIN: 'token',
  PASSPORT: 'token',
  VOTER_ID: 'token',
  ACCOUNT: 'token',
  IFSC: 'token',
  UPI: 'token',
  EMAIL: 'token',
  PHONE: 'token',
  NAME: 'token',
  ADDRESS: 'token',
  PINCODE: 'token',
  DOB: 'token',
  USERNAME: 'token',
  FACE: 'blur',
  TEXT_IN_IMAGE: 'token',
};

/** Secrets are never typed back by late binding unless they came from the user's own profile. */
export const SECRET: ReadonlySet<PiiType> = new Set(['PASSWORD', 'OTP', 'CVV']);

export type Pass = 'structure' | 'text' | 'context' | 'known' | 'pixel';

/** A rectangle in CSS pixels, relative to the viewport. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Finding {
  type: PiiType;
  value: string;
  rects: Rect[];
  pass: Pass;
  conf: number;
  rule: string;
  elementId?: string;
}

export interface TextMatch {
  type: PiiType;
  start: number;
  end: number;
  value: string;
  conf: number;
  rule: string;
}
