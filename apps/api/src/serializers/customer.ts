import type { Customer, CustomerSummary } from '@salon/contracts';
import type { CustomerRow } from '../repositories/customerRepo.js';
import type { Principal } from '../plugins/auth.js';

/** Full record. Reachable only by a principal holding `customers:read:full`. */
export function serializeCustomer(row: CustomerRow): Customer {
  return {
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
    phone: row.phone,
    email: row.email,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * What the voice agent is given.
 *
 * Surname, email and staff notes are dropped *here*, before the response is
 * built — so the agent is not trusted to avoid reading a customer's private
 * notes aloud, it simply never receives them. Eleanor's record says "allergic
 * to ammonia-based colour"; that is a note for a stylist, not something to
 * recite down the phone to whoever is calling from her number.
 */
export function serializeCustomerSummary(row: CustomerRow, isReturning = true): CustomerSummary {
  return {
    id: row.id,
    firstName: row.firstName,
    phone: row.phone,
    isReturning,
  };
}

export function canReadFullCustomer(principal: Principal): boolean {
  return principal.scopes.includes('customers:read:full');
}

/** Serialise at whatever fidelity the caller's scopes permit. */
export function projectCustomer(
  row: CustomerRow,
  principal: Principal,
  isReturning = true,
): Customer | CustomerSummary {
  return canReadFullCustomer(principal)
    ? serializeCustomer(row)
    : serializeCustomerSummary(row, isReturning);
}
