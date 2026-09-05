/**
 * Deterministic resolution of fuzzy time expressions.
 *
 * "next friday afternoon", "a week from tuesday", "sometime after 3" — these
 * arrive as raw phrases from a caller. The LLM's job is to *extract the
 * phrase*; the arithmetic happens here, in tested code, because a model
 * quietly getting "next Friday" wrong during a DST week is a class of bug that
 * never shows up in review and books someone into the wrong month.
 *
 * Every result carries an `interpretation` string that the agent reads back
 * ("that's Friday the 10th of October, in the afternoon"), so a genuinely
 * ambiguous phrase is resolved by the caller rather than guessed at silently.
 */
import { DateTime } from 'luxon';
import { dayOfWeekOf } from './zone.js';

export interface ResolveOptions {
  /** Reference instant (ISO). Injected rather than read from the clock so the resolver is testable. */
  now: string;
  timezone: string;
}

export interface ResolvedWindow {
  from: string;
  to: string;
  interpretation: string;
  /** True when the phrase named a span rather than a time ("next week"). */
  isBroad: boolean;
}

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, weds: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11,
  december: 12, dec: 12,
};

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, a: 1, an: 1, next: 1,
};

/** Named parts of the day, in salon-local wall clock. */
const DAY_PARTS: Record<string, { start: string; end: string; label: string }> = {
  morning: { start: '06:00', end: '12:00', label: 'in the morning' },
  'first thing': { start: '06:00', end: '10:00', label: 'first thing' },
  early: { start: '06:00', end: '10:00', label: 'early' },
  lunchtime: { start: '11:30', end: '14:00', label: 'around lunchtime' },
  lunch: { start: '11:30', end: '14:00', label: 'around lunchtime' },
  noon: { start: '11:30', end: '13:00', label: 'around midday' },
  midday: { start: '11:30', end: '13:00', label: 'around midday' },
  afternoon: { start: '12:00', end: '17:00', label: 'in the afternoon' },
  evening: { start: '17:00', end: '22:00', label: 'in the evening' },
  tonight: { start: '17:00', end: '22:00', label: 'this evening' },
  night: { start: '17:00', end: '22:00', label: 'in the evening' },
  late: { start: '16:00', end: '22:00', label: 'late in the day' },
};

const FULL_DAY = { start: '00:00', end: '23:59' };

interface DateAnchor {
  startDate: string;
  endDate: string;
  label: string;
  /** A span of days rather than a single day. */
  spansDays: boolean;
}

interface TimeAnchor {
  start: string;
  end: string;
  label: string;
  /** Set when the caller named a specific time rather than a part of the day. */
  precise: boolean;
}

function normalize(expression: string): string {
  return expression
    .toLowerCase()
    .replace(/[.,!?]/g, ' ')
    .replace(/\bo'?clock\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Turn a bare hour into a 24h hour.
 *
 * A salon caller saying "three" means 3pm, not 3am. Hours 1–6 are read as
 * afternoon, 7–11 as morning, which is how a human receptionist hears it.
 * An explicit am/pm always wins.
 */
function to24Hour(hour: number, meridiem: string | null): number {
  if (meridiem === 'am') return hour === 12 ? 0 : hour;
  if (meridiem === 'pm') return hour === 12 ? 12 : hour + 12;
  if (hour >= 1 && hour <= 6) return hour + 12;
  return hour;
}

const pad = (n: number) => String(n).padStart(2, '0');

function speakTime(hour: number, minute: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const suffix = hour < 12 ? 'am' : 'pm';
  return minute === 0 ? `${h12}${suffix}` : `${h12}:${pad(minute)}${suffix}`;
}

/** Extract the first clock time mentioned, e.g. "3", "3pm", "3:30", "half past two". */
function parseClock(text: string): { hour: number; minute: number; consumed: string } | null {
  let m = /\bhalf past (\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/.exec(text);
  if (m) {
    const raw = NUMBER_WORDS[m[1]!] ?? Number(m[1]);
    return { hour: to24Hour(raw, null), minute: 30, consumed: m[0] };
  }
  m = /\b(quarter past|quarter to) (\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/.exec(text);
  if (m) {
    const raw = NUMBER_WORDS[m[2]!] ?? Number(m[2]);
    const h = to24Hour(raw, null);
    return m[1] === 'quarter past'
      ? { hour: h, minute: 15, consumed: m[0] }
      : { hour: (h + 23) % 24, minute: 45, consumed: m[0] };
  }
  // 15:30 / 3:30pm / 3.30pm
  m = /\b(\d{1,2})[:.](\d{2})\s*(am|pm)?\b/.exec(text);
  if (m) {
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (minute > 59) return null;
    return {
      hour: hour > 12 ? hour : to24Hour(hour, (m[3] as string | undefined) ?? null),
      minute,
      consumed: m[0],
    };
  }
  // 3pm / 3 pm
  m = /\b(\d{1,2})\s*(am|pm)\b/.exec(text);
  if (m) return { hour: to24Hour(Number(m[1]), m[2]!), minute: 0, consumed: m[0] };
  // bare hour, only where a preposition makes it unambiguous ("after 3", "at 3")
  m = /\b(?:at|after|from|before|until|till|around|about|by)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/.exec(text);
  if (m) {
    const raw = NUMBER_WORDS[m[1]!] ?? Number(m[1]);
    if (raw >= 0 && raw <= 23) return { hour: to24Hour(raw, null), minute: 0, consumed: m[1]! };
  }
  return null;
}

function parseTimeAnchor(text: string): TimeAnchor | null {
  const clock = parseClock(text);

  if (clock) {
    const { hour, minute } = clock;
    const at = `${pad(hour)}:${pad(minute)}`;
    const spoken = speakTime(hour, minute);

    if (/\b(after|from|any time after|sometime after|later than)\b/.test(text)) {
      return { start: at, end: '23:59', label: `after ${spoken}`, precise: false };
    }
    if (/\b(before|until|till|by|earlier than)\b/.test(text)) {
      return { start: '00:00', end: at, label: `before ${spoken}`, precise: false };
    }
    if (/\b(around|about|ish|roughly|approximately|near)\b/.test(text)) {
      const from = DateTime.fromObject({ hour, minute }).minus({ minutes: 60 });
      const to = DateTime.fromObject({ hour, minute }).plus({ minutes: 60 });
      return { start: from.toFormat('HH:mm'), end: to.toFormat('HH:mm'), label: `around ${spoken}`, precise: false };
    }
    // A named time: offer from that time onward, nearest-first.
    const to = DateTime.fromObject({ hour, minute }).plus({ minutes: 90 });
    return { start: at, end: to.toFormat('HH:mm'), label: `at ${spoken}`, precise: true };
  }

  // Longest day-part label first so "first thing" beats "thing".
  for (const key of Object.keys(DAY_PARTS).sort((a, b) => b.length - a.length)) {
    if (new RegExp(`\\b${key}\\b`).test(text)) {
      const part = DAY_PARTS[key]!;
      return { start: part.start, end: part.end, label: part.label, precise: false };
    }
  }
  return null;
}

function parseDateAnchor(text: string, now: DateTime): DateAnchor | null {
  const today = now.startOf('day');
  const iso = (d: DateTime) => d.toFormat('yyyy-MM-dd');
  const spoken = (d: DateTime) => d.toFormat('cccc d LLLL');

  if (/\b(today|this (morning|afternoon|evening)|tonight|later on)\b/.test(text)) {
    return { startDate: iso(today), endDate: iso(today), label: 'today', spansDays: false };
  }
  if (/\bday after tomorrow\b/.test(text)) {
    const d = today.plus({ days: 2 });
    return { startDate: iso(d), endDate: iso(d), label: spoken(d), spansDays: false };
  }
  if (/\btomorrow\b/.test(text)) {
    const d = today.plus({ days: 1 });
    return { startDate: iso(d), endDate: iso(d), label: `tomorrow, ${spoken(d)}`, spansDays: false };
  }

  // "a week from tuesday", "tuesday week" — the named weekday, seven days on
  // from its next occurrence.
  let m = /\b(?:a |one )?week (?:from|after) (\w+)\b/.exec(text) ?? /\b(\w+) week\b/.exec(text);
  if (m && WEEKDAYS[m[1]!] !== undefined) {
    const d = nextWeekday(today, WEEKDAYS[m[1]!]!, false).plus({ weeks: 1 });
    return { startDate: iso(d), endDate: iso(d), label: `${spoken(d)}, a week on from the coming ${m[1]}`, spansDays: false };
  }

  // "in 3 days", "in a fortnight", "in two weeks"
  m = /\bin (\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten) (day|days|week|weeks|month|months)\b/.exec(text);
  if (m) {
    const n = NUMBER_WORDS[m[1]!] ?? Number(m[1]);
    const unit = m[2]!.replace(/s$/, '') as 'day' | 'week' | 'month';
    const d = today.plus({ [`${unit}s`]: n });
    if (unit === 'day') return { startDate: iso(d), endDate: iso(d), label: spoken(d), spansDays: false };
    return { startDate: iso(d.startOf('day')), endDate: iso(d.plus({ days: unit === 'week' ? 2 : 6 })), label: `around ${spoken(d)}`, spansDays: true };
  }
  if (/\bfortnight\b/.test(text)) {
    const d = today.plus({ weeks: 2 });
    return { startDate: iso(d), endDate: iso(d.plus({ days: 2 })), label: `around ${spoken(d)}`, spansDays: true };
  }

  if (/\b(this |the |coming )?weekend\b/.test(text)) {
    const saturday = nextWeekday(today, 6, true);
    return { startDate: iso(saturday), endDate: iso(saturday.plus({ days: 1 })), label: `the weekend of ${spoken(saturday)}`, spansDays: true };
  }
  if (/\bnext week\b/.test(text)) {
    const monday = today.plus({ weeks: 1 }).startOf('week');
    return { startDate: iso(monday), endDate: iso(monday.plus({ days: 6 })), label: `next week, from ${spoken(monday)}`, spansDays: true };
  }
  if (/\bthis week\b/.test(text)) {
    return { startDate: iso(today), endDate: iso(today.endOf('week')), label: 'later this week', spansDays: true };
  }
  if (/\bnext month\b/.test(text)) {
    const start = today.plus({ months: 1 }).startOf('month');
    return { startDate: iso(start), endDate: iso(start.endOf('month')), label: `next month (${start.toFormat('LLLL')})`, spansDays: true };
  }

  // Explicit calendar date: "3 October", "October 3rd", "the 3rd of October"
  m = /\b(\d{1,2})(?:st|nd|rd|th)? (?:of )?(\w+)\b/.exec(text);
  if (m && MONTHS[m[2]!] !== undefined) {
    const d = resolveMonthDay(now, MONTHS[m[2]!]!, Number(m[1]));
    if (d) return { startDate: iso(d), endDate: iso(d), label: spoken(d), spansDays: false };
  }
  m = /\b(\w+) (\d{1,2})(?:st|nd|rd|th)?\b/.exec(text);
  if (m && MONTHS[m[1]!] !== undefined) {
    const d = resolveMonthDay(now, MONTHS[m[1]!]!, Number(m[2]));
    if (d) return { startDate: iso(d), endDate: iso(d), label: spoken(d), spansDays: false };
  }
  // "the 3rd" — next occurrence of that day-of-month
  m = /\bthe (\d{1,2})(?:st|nd|rd|th)\b/.exec(text);
  if (m) {
    const day = Number(m[1]);
    let d = today.set({ day });
    if (!d.isValid || d < today) d = today.plus({ months: 1 }).set({ day });
    if (d.isValid) return { startDate: iso(d), endDate: iso(d), label: spoken(d), spansDays: false };
  }

  // Weekday, with or without a "next"/"this" qualifier.
  //
  // "next Friday" is read as the Friday of the following week; a bare or
  // "this" Friday is the coming one. English genuinely disagrees about this,
  // which is exactly why the resolved date is read back to the caller for
  // confirmation rather than acted on silently.
  m = /\b(next|this|coming|on|upcoming)?\s*(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|weds|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)\b/.exec(text);
  if (m) {
    const target = WEEKDAYS[m[2]!]!;
    const isNext = m[1] === 'next';
    let d = nextWeekday(today, target, false);
    if (isNext) {
      // Advance to the occurrence in the following calendar week.
      const nextWeekStart = today.plus({ weeks: 1 }).startOf('week');
      if (d < nextWeekStart) d = d.plus({ weeks: 1 });
    }
    return {
      startDate: iso(d),
      endDate: iso(d),
      label: spoken(d),
      spansDays: false,
    };
  }

  return null;
}

/** Next occurrence of `target` day-of-week strictly after today (or including today). */
function nextWeekday(from: DateTime, target: number, includeToday: boolean): DateTime {
  let d = from;
  if (!includeToday) d = d.plus({ days: 1 });
  for (let i = 0; i < 8; i += 1) {
    if (dayOfWeekOf(d) === target) return d;
    d = d.plus({ days: 1 });
  }
  return from;
}

/** The next occurrence of month/day, rolling into next year if already past. */
function resolveMonthDay(now: DateTime, month: number, day: number): DateTime | null {
  let d = now.set({ month, day }).startOf('day');
  if (!d.isValid) return null;
  if (d < now.startOf('day')) d = d.plus({ years: 1 });
  return d.isValid ? d : null;
}

/**
 * Resolve a natural-language time expression into a concrete instant window.
 * Returns null when nothing recognisable is found — the caller should then ask
 * the customer to be more specific rather than guess.
 */
export function resolveTimeExpression(
  expression: string,
  options: ResolveOptions,
): ResolvedWindow | null {
  const text = normalize(expression);
  if (!text) return null;

  const now = DateTime.fromISO(options.now, { zone: options.timezone });
  if (!now.isValid) return null;

  const date = parseDateAnchor(text, now);
  const time = parseTimeAnchor(text);

  // A phrase with neither a date nor a time ("whenever", "soon") is not
  // resolvable; asking beats guessing.
  if (!date && !time) return null;

  // A time with no date means the soonest day that time can still happen.
  let anchor = date;
  if (!anchor) {
    const todayStr = now.toFormat('yyyy-MM-dd');
    const endToday = DateTime.fromISO(`${todayStr}T${time!.end}`, { zone: options.timezone });
    const useTomorrow = endToday <= now;
    const d = useTomorrow ? now.plus({ days: 1 }) : now;
    anchor = {
      startDate: d.toFormat('yyyy-MM-dd'),
      endDate: d.toFormat('yyyy-MM-dd'),
      label: useTomorrow ? `tomorrow, ${d.toFormat('cccc d LLLL')}` : 'today',
      spansDays: false,
    };
  }

  const window = time ?? FULL_DAY;
  let from = DateTime.fromISO(`${anchor.startDate}T${window.start}`, { zone: options.timezone });
  const to = DateTime.fromISO(`${anchor.endDate}T${window.end}`, { zone: options.timezone });
  if (!from.isValid || !to.isValid) return null;

  // Never offer a window that has already elapsed.
  if (from < now) from = now;
  if (to <= from) return null;

  // "today" + "this evening" would read back as "today this evening"; the
  // day-part label already carries the day in that case.
  const interpretation = time
    ? (anchor.label === 'today' && time.label.startsWith('this ')
        ? time.label
        : `${anchor.label} ${time.label}`
      ).replace(/\s+/g, ' ').trim()
    : anchor.label;

  return {
    from: from.toUTC().toISO()!,
    to: to.toUTC().toISO()!,
    interpretation,
    isBroad: anchor.spansDays || !time || !time.precise,
  };
}
