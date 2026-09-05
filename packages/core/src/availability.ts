/**
 * The availability engine.
 *
 * Pure: it takes plain data (opening hours, closed dates, staff, existing
 * blocked ranges, policy) and returns bookable slots. No database, no clock —
 * `now` is injected — so every scheduling rule is testable as a function over
 * fixtures, and the same code path that offers a slot is the one that later
 * validates the booking of it.
 */
import { DateTime } from 'luxon';
import type {
  BusyBlock,
  ComputedSlot,
  Interval,
  SchedulingContext,
  ServiceDef,
  StaffDef,
} from './types.js';
import { canStaffPerform, computeBlockRange, staffIntervalsForDate } from './policy.js';
import {
  canonicalInstant,
  localDatesBetween,
  localToInstant,
  overlaps,
  speakableLabel,
  toSalonTime,
} from './time/zone.js';

export interface AvailabilityRequest {
  context: SchedulingContext;
  service: ServiceDef;
  staff: StaffDef[];
  /** Already-blocked ranges (buffers included) for the staff under consideration. */
  busy: BusyBlock[];
  /** Requested window, ISO instants. */
  from: string;
  to: string;
  now: string;
  /** Restrict to one staff member ("I always see Priya"). */
  staffId?: string | undefined;
  limit?: number;
}

const MAX_DAYS_SCANNED = 120;

/**
 * Bookable slots inside the requested window, earliest first.
 *
 * One slot per start time: when several staff are free the least-loaded
 * qualified one is chosen, so a caller with no preference hears a clean list of
 * times rather than the same time repeated once per stylist.
 */
export function computeAvailability(request: AvailabilityRequest): ComputedSlot[] {
  const { context, service, limit = 20 } = request;
  const granularity = context.policy.slotGranularityMinutes;

  // Canonicalise up front: the comparisons below order instants as strings,
  // which is only sound once every value is in the same UTC rendering.
  const from = canonicalInstant(request.from);
  const to = canonicalInstant(request.to);
  const now = canonicalInstant(request.now);

  const eligibleStaff = request.staff.filter(
    (s) =>
      s.active &&
      canStaffPerform(s, service.id) &&
      (request.staffId === undefined || s.id === request.staffId),
  );
  if (eligibleStaff.length === 0) return [];

  const busyByStaff = new Map<string, BusyBlock[]>();
  for (const raw of request.busy) {
    const block: BusyBlock = {
      ...raw,
      blockStart: canonicalInstant(raw.blockStart),
      blockEnd: canonicalInstant(raw.blockEnd),
    };
    const list = busyByStaff.get(block.staffId);
    if (list) list.push(block);
    else busyByStaff.set(block.staffId, [block]);
  }
  // Fewer existing bookings overall => preferred when several staff are free,
  // which spreads the day's work rather than loading the first stylist listed.
  const loadOf = (staffId: string) => busyByStaff.get(staffId)?.length ?? 0;

  const earliestAllowed = DateTime.fromISO(now)
    .plus({ minutes: context.policy.minLeadMinutes })
    .toUTC()
    .toISO()!;
  const latestAllowed = DateTime.fromISO(now)
    .plus({ days: context.policy.maxAdvanceDays })
    .toUTC()
    .toISO()!;

  const windowStart = from > earliestAllowed ? from : earliestAllowed;
  const windowEnd = to < latestAllowed ? to : latestAllowed;
  if (windowStart >= windowEnd) return [];

  const dates = localDatesBetween(windowStart, windowEnd, context.timezone).slice(0, MAX_DAYS_SCANNED);

  // start ISO -> the best staff option found for it
  const byStart = new Map<string, { staff: StaffDef; end: string }>();

  for (const date of dates) {
    for (const staff of eligibleStaff) {
      const shifts = staffIntervalsForDate(date, context, staff);
      if (shifts.length === 0) continue;
      const busy = busyByStaff.get(staff.id) ?? [];

      for (const shift of shifts) {
        for (const candidate of candidateStarts(date, shift, granularity, context.timezone)) {
          if (candidate < windowStart || candidate >= windowEnd) continue;

          const range = computeBlockRange(candidate, service);
          // The service itself must finish before the shift ends; buffers may
          // spill past closing (cleanup happens after the last customer leaves).
          if (range.end > shift.end) continue;

          const conflicts = busy.some((b) =>
            overlaps(range.blockStart, range.blockEnd, b.blockStart, b.blockEnd),
          );
          if (conflicts) continue;

          const existing = byStart.get(candidate);
          if (!existing || loadOf(staff.id) < loadOf(existing.staff.id)) {
            byStart.set(candidate, { staff, end: range.end });
          }
        }
      }
    }
  }

  return [...byStart.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, limit)
    .map(([start, { staff, end }]) => toSlot(start, end, staff, context.timezone, now));
}

/**
 * Nearest bookable slots *outside* the requested window.
 *
 * Populated when the requested window is empty so "we're full then" is never a
 * dead end — the agent always has two or three concrete times to offer instead.
 * Searching backwards as well as forwards matters: the day before is often a
 * better answer for the caller than the following week.
 */
export function findAlternatives(
  request: AvailabilityRequest,
  count = 3,
): ComputedSlot[] {
  const from = canonicalInstant(request.from);
  const to = canonicalInstant(request.to);
  const now = canonicalInstant(request.now);

  const searchFrom = DateTime.fromISO(from).minus({ days: 2 }).toUTC().toISO()!;
  const searchTo = DateTime.fromISO(to).plus({ days: 10 }).toUTC().toISO()!;

  const wider = computeAvailability({
    ...request,
    from: searchFrom > now ? searchFrom : now,
    to: searchTo,
    limit: 400,
  });

  const anchor = DateTime.fromISO(from).toMillis();
  const outsideRequested = wider.filter((s) => s.start < from || s.start >= to);

  // Nearest to the time they asked for, then chronological within equal distance.
  const ranked = outsideRequested.sort((a, b) => {
    const da = Math.abs(DateTime.fromISO(a.start).toMillis() - anchor);
    const db = Math.abs(DateTime.fromISO(b.start).toMillis() - anchor);
    return da === db ? (a.start < b.start ? -1 : 1) : da - db;
  });

  // Spread the suggestions across different days where possible: three times on
  // the same afternoon is a worse offer than one each on three days.
  const picked: ComputedSlot[] = [];
  const seenDays = new Set<string>();
  for (const slot of ranked) {
    if (picked.length >= count) break;
    if (seenDays.has(slot.localDate)) continue;
    seenDays.add(slot.localDate);
    picked.push(slot);
  }
  for (const slot of ranked) {
    if (picked.length >= count) break;
    if (!picked.includes(slot)) picked.push(slot);
  }

  return picked.sort((a, b) => (a.start < b.start ? -1 : 1));
}

/**
 * Candidate start times inside a shift, aligned to the wall-clock grid.
 *
 * Aligned to the hour rather than to the shift start so a salon opening at
 * 09:20 still offers 09:30, 09:45, 10:00 — the times a customer expects to
 * hear — instead of 09:20, 09:35, 09:50.
 *
 * Built by setting wall-clock hour/minute on the local date rather than by
 * adding minutes to midnight, so a DST transition shifts the instants without
 * corrupting the local times.
 */
function candidateStarts(
  date: string,
  shift: Interval,
  granularityMinutes: number,
  timezone: string,
): string[] {
  const shiftStartLocal = toSalonTime(shift.start, timezone);
  const startMinutes = shiftStartLocal.hour * 60 + shiftStartLocal.minute;
  const aligned = Math.ceil(startMinutes / granularityMinutes) * granularityMinutes;

  const out: string[] = [];
  for (let m = aligned; m < 24 * 60; m += granularityMinutes) {
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    const iso = localToInstant(date, `${hh}:${mm}`, timezone).toUTC().toISO()!;
    if (iso >= shift.end) break;
    if (iso < shift.start) continue;
    out.push(iso);
  }
  return out;
}

function toSlot(
  start: string,
  end: string,
  staff: StaffDef,
  timezone: string,
  now: string,
): ComputedSlot {
  const local = toSalonTime(start, timezone);
  return {
    start,
    end,
    staffId: staff.id,
    staffName: staff.name,
    localDate: local.toFormat('yyyy-MM-dd'),
    localTime: local.toFormat('HH:mm'),
    label: speakableLabel(start, timezone, now),
  };
}

/**
 * Pick the staff member to assign when the caller expressed no preference.
 * Least-loaded first, then stable by name so repeated identical requests do not
 * shuffle the answer.
 */
export function chooseStaffForSlot(
  candidates: StaffDef[],
  busy: BusyBlock[],
  service: ServiceDef,
): StaffDef | null {
  const eligible = candidates.filter((s) => s.active && canStaffPerform(s, service.id));
  if (eligible.length === 0) return null;

  const load = new Map<string, number>();
  for (const b of busy) load.set(b.staffId, (load.get(b.staffId) ?? 0) + 1);

  return eligible.sort((a, b) => {
    const diff = (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0);
    return diff !== 0 ? diff : a.name.localeCompare(b.name);
  })[0]!;
}
