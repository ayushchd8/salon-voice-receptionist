/**
 * API scopes.
 *
 * The voice agent and the staff UI hold separate credentials with separate
 * scope sets, independently revocable. The agent deliberately lacks
 * `customers:read:full` — see the PII projection in the customer serializer.
 * Revoking the agent key silences the phone line without logging staff out.
 */
export const SCOPES = [
  'salon:read',
  'services:read',
  'services:write',
  'hours:read',
  'hours:write',
  'policies:read',
  'policies:write',
  'staff:read',
  'staff:write',
  'availability:read',
  'customers:read',
  /** Unredacted customer records: staff notes, email, surname, full history. */
  'customers:read:full',
  'customers:write',
  'appointments:read',
  'appointments:write',
  /** Create an appointment that deliberately overlaps another. Staff only. */
  'appointments:overbook',
  'calls:read',
  'calls:write',
] as const;

export type Scope = (typeof SCOPES)[number];

/** What the voice agent is allowed to do. Note the absence of any `*:write`
 *  on configuration, and of `customers:read:full`. */
export const AGENT_SCOPES: readonly Scope[] = [
  'salon:read',
  'services:read',
  'hours:read',
  'policies:read',
  'staff:read',
  'availability:read',
  'customers:read',
  'customers:write',
  'appointments:read',
  'appointments:write',
  'calls:write',
];

/** What staff can do: everything except forging call records. */
export const STAFF_SCOPES: readonly Scope[] = SCOPES.filter((s) => s !== 'calls:write');
