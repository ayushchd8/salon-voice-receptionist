import { describe, expect, it } from 'vitest';
import { callingCodeFromSalonPhone, maskPhone, normalizePhone, speakablePhone } from './phone.js';

describe('normalizePhone', () => {
  it('collapses every common rendering of one UK number to a single E.164 value', () => {
    // This is the whole point: phone is the customer identity key, so these
    // must not create four different customer records.
    const variants = ['+447700900123', '+44 7700 900123', '07700900123', '07700 900 123', '00447700900123'];
    const normalized = variants.map((v) => normalizePhone(v, { defaultCallingCode: '44' }));
    expect(new Set(normalized)).toEqual(new Set(['+447700900123']));
  });

  it('keeps an already-international number untouched regardless of default', () => {
    expect(normalizePhone('+12125550123', { defaultCallingCode: '44' })).toBe('+12125550123');
  });

  it('rejects a national-format number when no country can be inferred', () => {
    // Guessing here would silently attach a customer to the wrong country code.
    expect(normalizePhone('07700900123')).toBeNull();
  });

  it('rejects values that cannot be a phone number', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('abc')).toBeNull();
    expect(normalizePhone('12345', { defaultCallingCode: '44' })).toBeNull();
    expect(normalizePhone('1234567890123456789', { defaultCallingCode: '44' })).toBeNull();
  });

  it('infers the calling code from the salon own number', () => {
    expect(callingCodeFromSalonPhone('+44 20 7946 0000')).toBe('44');
    expect(callingCodeFromSalonPhone('+1 212 555 0100')).toBe('1');
    expect(callingCodeFromSalonPhone(null)).toBeUndefined();
  });
});

describe('log redaction', () => {
  it('masks the middle of a number so logs carry no reversible PII', () => {
    const masked = maskPhone('+447700900123');
    expect(masked).toBe('+4477••••0123');
    expect(masked).not.toContain('700900');
  });

  it('handles a missing number without leaking "undefined" into logs', () => {
    expect(maskPhone(null)).toBe('(none)');
  });
});

describe('speakablePhone', () => {
  it('spaces digits so TTS reads them out individually', () => {
    expect(speakablePhone('+447700900123')).toBe('plus 4 4 7 7 0 0 9 0 0 1 2 3');
  });
});
