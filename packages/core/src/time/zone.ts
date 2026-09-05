/**
 * The single place where salon-local wall clock and absolute instants meet.
 *
 * Opening hours, staff shifts and closed dates are stored as local `time` /
 * `date` values because that is what they mean: "we open at nine" is true in
 * January and in July, even though the UTC instant differs. Every conversion
 * between that representation and a `timestamptz` goes through this module, so
 * DST correctness is a property of one file rather than of every query.
 */
import { DateTime, Interval as LuxonInterval } from 'luxon';

export class TimeZoneError extends Error {}

export function assertValidTimezone(timezone: string): void {
  if (!DateTime.local().setZone(timezone).isValid) {
    throw new TimeZoneError(`"${timezone}" is not a valid IANA timezone`);
  }
}

/** Parse an ISO instant into a DateTime rendered in the salon's zone. */
export function toSalonTime(iso: string, timezone: string): DateTime {
  const dt = DateTime.fromISO(iso, { zone: timezone });
  if (!dt.isValid) throw new TimeZoneError(`invalid ISO instant: ${iso}`);
  return dt;
}

/**
 * Combine a salon-local date and wall-clock time into an absolute instant.
 *
 * DST edge cases are explicit rather than accidental:
 *  - Spring forward: 01:30 on a day where 01:00–02:00 does not exist. Luxon
 *    resolves this forward to 02:30; we accept that, because a salon that
 *    "opens at 01:30" on that day opens when the clocks say it can.
 *  - Fall back: 01:30 occurs twice. Luxon picks the first (pre-transition)
 *    occurrence, which is the earlier real instant — the correct choice for an
 *    opening time.
 */
export function localToInstant(localDate: string, localTime: string, timezone: string): DateTime {
  const normalized = localTime.length === 5 ? `${localTime}:00` : localTime;
  const dt = DateTime.fromISO(`${localDate}T${normalized}`, { zone: timezone });
  if (!dt.isValid) {
    throw new TimeZoneError(`invalid local datetime: ${localDate} ${localTime} in ${timezone}`);
  }
  return dt;
}

export function localDateOf(iso: string, timezone: string): string {
  return toSalonTime(iso, timezone).toFormat('yyyy-MM-dd');
}

export function localTimeOf(iso: string, timezone: string): string {
  return toSalonTime(iso, timezone).toFormat('HH:mm');
}

/** 0 = Sunday … 6 = Saturday, matching JavaScript's Date#getDay. */
export function dayOfWeekOf(dt: DateTime): number {
  return dt.weekday % 7;
}

/** Inclusive list of salon-local dates ("YYYY-MM-DD") touched by an instant range. */
export function localDatesBetween(fromIso: string, toIso: string, timezone: string): string[] {
  const from = toSalonTime(fromIso, timezone).startOf('day');
  const to = toSalonTime(toIso, timezone).startOf('day');
  if (to < from) return [];
  const dates: string[] = [];
  for (let d = from; d <= to; d = d.plus({ days: 1 })) {
    dates.push(d.toFormat('yyyy-MM-dd'));
    // Guard against a pathological range producing an unbounded loop.
    if (dates.length > 800) break;
  }
  return dates;
}

/**
 * Canonical UTC rendering of an instant: always `YYYY-MM-DDTHH:mm:ss.SSSZ`.
 *
 * Instants reach this system in several shapes — Postgres returns
 * "2026-09-07 10:15:00+00", a caller may send "2026-09-07T10:15:00Z", Luxon
 * emits milliseconds. Those are the same moment but *different strings*, and
 * comparing them lexicographically silently gets the wrong answer ('.' sorts
 * before 'Z', so "10:15:00.000Z" < "10:15:00Z"). Every instant entering the
 * engine is canonicalised here so string ordering and instant ordering agree.
 */
export function canonicalInstant(iso: string): string {
  const dt = DateTime.fromISO(iso, { zone: 'utc' });
  if (!dt.isValid) throw new TimeZoneError(`invalid ISO instant: ${iso}`);
  return dt.toUTC().toISO({ suppressMilliseconds: false })!;
}

export function instantMs(iso: string): number {
  const dt = DateTime.fromISO(iso, { zone: 'utc' });
  if (!dt.isValid) throw new TimeZoneError(`invalid ISO instant: ${iso}`);
  return dt.toMillis();
}

/**
 * Do two instant ranges overlap? Half-open [start, end), matching the
 * `tstzrange(..., '[)')` in the database exclusion constraint.
 *
 * Compares by epoch milliseconds rather than by string, so a mix of ISO
 * renderings cannot produce a false conflict.
 */
export function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return instantMs(aStart) < instantMs(bEnd) && instantMs(bStart) < instantMs(aEnd);
}

export function intervalMinutes(startIso: string, endIso: string): number {
  const i = LuxonInterval.fromDateTimes(DateTime.fromISO(startIso), DateTime.fromISO(endIso));
  return i.isValid ? i.length('minutes') : 0;
}

export function hoursBetween(fromIso: string, toIso: string): number {
  return (DateTime.fromISO(toIso).toMillis() - DateTime.fromISO(fromIso).toMillis()) / 3_600_000;
}

/**
 * A speakable rendering of an instant: "Friday 3 October at 2:30pm".
 *
 * Produced server-side so the voice agent never formats a date itself — an LLM
 * rendering "2026-10-03T14:30:00Z" as "half two" in the wrong timezone is a
 * failure mode worth designing out entirely.
 */
export function speakableLabel(iso: string, timezone: string, now?: string): string {
  const dt = toSalonTime(iso, timezone);
  const time = dt.toFormat(dt.minute === 0 ? 'h a' : 'h:mm a').replace('AM', 'am').replace('PM', 'pm');

  if (now) {
    const today = toSalonTime(now, timezone).startOf('day');
    const days = dt.startOf('day').diff(today, 'days').days;
    if (days === 0) return `today at ${time}`;
    if (days === 1) return `tomorrow at ${time}`;
    if (days > 1 && days < 7) return `${dt.toFormat('cccc')} at ${time}`;
  }
  return `${dt.toFormat('cccc d LLLL')} at ${time}`;
}

export { DateTime };
