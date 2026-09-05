import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { resolveTimeExpression } from './resolveExpression.js';

const TZ = 'Europe/London';
// Monday 7 September 2026, 10:00 local (BST, UTC+1).
const NOW = '2026-09-07T09:00:00Z';
const opts = { now: NOW, timezone: TZ };

/** Render a resolved window in salon-local time for readable assertions. */
function local(iso: string): string {
  return DateTime.fromISO(iso, { zone: TZ }).toFormat('ccc yyyy-MM-dd HH:mm');
}

describe('relative day expressions', () => {
  it.each([
    ['tomorrow', 'Tue 2026-09-08'],
    ['day after tomorrow', 'Wed 2026-09-09'],
    ['in 3 days', 'Thu 2026-09-10'],
    ['today', 'Mon 2026-09-07'],
  ])('resolves %s to %s', (expression, expectedDay) => {
    const r = resolveTimeExpression(expression, opts);
    expect(r).not.toBeNull();
    expect(local(r!.from)).toContain(expectedDay);
  });
});

describe('weekday expressions', () => {
  it('reads a bare weekday as the coming one', () => {
    const r = resolveTimeExpression('friday', opts)!;
    expect(local(r.from)).toContain('Fri 2026-09-11');
  });

  it('reads "next friday" as the Friday of the following week', () => {
    // English genuinely disagrees about this phrase, which is why the resolved
    // date is read back to the caller for confirmation rather than acted on
    // silently. The convention is documented in ARCHITECTURE.md §8.
    const r = resolveTimeExpression('next friday', opts)!;
    expect(local(r.from)).toContain('Fri 2026-09-18');
    expect(r.interpretation).toContain('Friday 18 September');
  });

  it('resolves "a week from tuesday" to seven days past the coming Tuesday', () => {
    const r = resolveTimeExpression('a week from tuesday', opts)!;
    expect(local(r.from)).toContain('Tue 2026-09-15');
  });

  it('treats "tuesday week" as the same thing', () => {
    const a = resolveTimeExpression('a week from tuesday', opts)!;
    const b = resolveTimeExpression('tuesday week', opts)!;
    expect(b.from).toBe(a.from);
  });
});

describe('parts of the day', () => {
  it('bounds "next friday afternoon" to the afternoon of that day', () => {
    const r = resolveTimeExpression('next friday afternoon', opts)!;
    expect(local(r.from)).toBe('Fri 2026-09-18 12:00');
    expect(local(r.to)).toBe('Fri 2026-09-18 17:00');
    expect(r.interpretation).toBe('Friday 18 September in the afternoon');
  });

  it('bounds "tomorrow morning" to the morning', () => {
    const r = resolveTimeExpression('tomorrow morning', opts)!;
    expect(local(r.from)).toBe('Tue 2026-09-08 06:00');
    expect(local(r.to)).toBe('Tue 2026-09-08 12:00');
  });
});

describe('open-ended and approximate times', () => {
  it('treats "sometime after 3" as 3pm onwards today', () => {
    // A salon caller saying "3" means the afternoon, not 3am.
    const r = resolveTimeExpression('sometime after 3', opts)!;
    expect(local(r.from)).toBe('Mon 2026-09-07 15:00');
    expect(r.interpretation).toBe('today after 3pm');
  });

  it('treats "before 11 on friday" as an upper bound', () => {
    const r = resolveTimeExpression('before 11 on friday', opts)!;
    expect(local(r.to)).toBe('Fri 2026-09-11 11:00');
  });

  it('gives "around 4pm tomorrow" an hour either side', () => {
    const r = resolveTimeExpression('around 4pm tomorrow', opts)!;
    expect(local(r.from)).toBe('Tue 2026-09-08 15:00');
    expect(local(r.to)).toBe('Tue 2026-09-08 17:00');
  });

  it('understands spoken times', () => {
    const r = resolveTimeExpression('wednesday at half past two', opts)!;
    expect(local(r.from)).toBe('Wed 2026-09-09 14:30');
    expect(r.isBroad).toBe(false);
  });
});

describe('spans', () => {
  it('marks multi-day expressions as broad', () => {
    expect(resolveTimeExpression('next week', opts)!.isBroad).toBe(true);
    expect(resolveTimeExpression('this weekend', opts)!.isBroad).toBe(true);
    expect(resolveTimeExpression('wednesday at 2:30', opts)!.isBroad).toBe(false);
  });

  it('resolves "this weekend" to the coming Saturday and Sunday', () => {
    const r = resolveTimeExpression('this weekend', opts)!;
    expect(local(r.from)).toContain('Sat 2026-09-12');
    expect(local(r.to)).toContain('Sun 2026-09-13');
  });
});

describe('explicit dates', () => {
  it.each(['october 3rd', '3rd of october', '3 october'])('resolves %s', (expression) => {
    const r = resolveTimeExpression(expression, opts)!;
    expect(local(r.from)).toContain('Sat 2026-10-03');
  });

  it('rolls a past month-day into next year', () => {
    const r = resolveTimeExpression('3rd of march', opts)!;
    expect(local(r.from)).toContain('2027-03-03');
  });
});

describe('guard rails', () => {
  it('returns null rather than guessing at an unparseable phrase', () => {
    // Asking the caller to be specific beats booking them into a date the
    // system invented.
    expect(resolveTimeExpression('whenever suits you', opts)).toBeNull();
    expect(resolveTimeExpression('', opts)).toBeNull();
    expect(resolveTimeExpression('soon', opts)).toBeNull();
  });

  it('never returns a window that has already elapsed', () => {
    // 10:00 local; "this morning" would otherwise start at 06:00.
    const r = resolveTimeExpression('this morning', opts)!;
    expect(r.from).toBe(DateTime.fromISO(NOW).toUTC().toISO());
  });

  it('rolls a time that has already passed today into tomorrow', () => {
    const r = resolveTimeExpression('at 8am', opts)!;
    expect(local(r.from)).toContain('Tue 2026-09-08');
  });

  it('never returns an inverted window', () => {
    for (const expression of ['next friday afternoon', 'tomorrow', 'in 2 weeks', 'this weekend']) {
      const r = resolveTimeExpression(expression, opts)!;
      expect(r.from < r.to).toBe(true);
    }
  });
});

describe('daylight saving', () => {
  it('keeps wall-clock meaning across the autumn transition', () => {
    // UK clocks go back on Sunday 25 October 2026. An appointment window asked
    // for as "2pm" must be 2pm local on both sides of it, not 13:00 or 15:00.
    const before = resolveTimeExpression('at 2pm on the 24th', { now: '2026-10-20T09:00:00Z', timezone: TZ })!;
    const after = resolveTimeExpression('at 2pm on the 26th', { now: '2026-10-20T09:00:00Z', timezone: TZ })!;
    expect(local(before.from)).toBe('Sat 2026-10-24 14:00');
    expect(local(after.from)).toBe('Mon 2026-10-26 14:00');
    // ...and the underlying UTC instants differ by the hour the clocks moved.
    expect(before.from).toContain('13:00');
    expect(after.from).toContain('14:00');
  });
});
