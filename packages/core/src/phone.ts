/**
 * Phone-number normalisation.
 *
 * Phone is the identity key on a voice channel, so "+44 7700 900123",
 * "07700 900123" and "07700900123" must all resolve to the same customer
 * record. Normalisation happens once, here, before anything reaches the
 * database — the unique index on (salon_id, phone) is only meaningful if the
 * values reaching it are canonical.
 *
 * This is deliberately not libphonenumber: the full library is 500 kB to solve
 * a problem this system has a narrower version of. The trade-off is recorded
 * in SCALING.md — swap it in when the salon list goes international.
 */

export interface NormalizePhoneOptions {
  /** Country calling code, digits only ("44", "1"). Used for national-format numbers. */
  defaultCallingCode?: string;
}

/** Infer the default calling code from the salon's own number, if it has one. */
export function callingCodeFromSalonPhone(salonPhone: string | null | undefined): string | undefined {
  if (!salonPhone) return undefined;
  const m = /^\+(\d{1,3})/.exec(salonPhone.replace(/[^\d+]/g, ''));
  if (!m) return undefined;
  const digits = m[1]!;
  // Longest-first match against the codes this prototype knows about.
  for (const code of ['44', '353', '61', '64', '49', '33', '34', '39', '1']) {
    if (digits.startsWith(code)) return code;
  }
  return digits.slice(0, 2);
}

/**
 * Returns E.164 ("+447700900123") or null when the input cannot be canonicalised.
 * Null is a validation failure, never a silent pass-through — an un-normalised
 * number in the database would fragment a customer's history.
 */
export function normalizePhone(
  input: string,
  options: NormalizePhoneOptions = {},
): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const hasPlus = trimmed.startsWith('+');
  let digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;

  // A national subscriber number is never shorter than this; prepending a
  // country code to a handful of digits would manufacture a plausible-looking
  // number out of a typo.
  const MIN_NATIONAL_DIGITS = 7;

  if (hasPlus) {
    // Already international.
  } else if (digits.startsWith('00')) {
    digits = digits.slice(2);
  } else if (digits.startsWith('0')) {
    const cc = options.defaultCallingCode;
    const national = digits.slice(1);
    if (!cc || national.length < MIN_NATIONAL_DIGITS) return null;
    digits = cc + national;
  } else if (options.defaultCallingCode && digits.length <= 11) {
    const cc = options.defaultCallingCode;
    if (digits.startsWith(cc)) {
      // Already carries the country code, just without the '+'.
    } else if (digits.length < MIN_NATIONAL_DIGITS) {
      return null;
    } else {
      digits = cc + digits;
    }
  }

  // E.164: country code + subscriber number, 7–15 digits, no leading zero.
  if (digits.length < 7 || digits.length > 15) return null;
  if (digits.startsWith('0')) return null;

  return `+${digits}`;
}

/**
 * Redacted rendering for logs and non-voice display: "+4477••••0123".
 * Logs carry identifiers, not personal data — see ARCHITECTURE.md §7.
 */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '(none)';
  if (phone.length <= 8) return `${phone.slice(0, 2)}••••`;
  return `${phone.slice(0, 5)}••••${phone.slice(-4)}`;
}

/** Digit-by-digit rendering so TTS reads a number out loud correctly. */
export function speakablePhone(phone: string): string {
  const international = phone.startsWith('+');
  const digits = phone.replace(/\D/g, '').split('').join(' ');
  return international ? `plus ${digits}` : digits;
}
