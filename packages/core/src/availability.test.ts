import { describe, expect, it } from 'vitest';
import { computeAvailability, findAlternatives, chooseStaffForSlot } from './availability.js';
import type { AvailabilityRequest } from './availability.js';
import type { BusyBlock, StaffDef } from './types.js';
import { colourService, cutService, makeContext, priya, sam, TZ } from './test-fixtures.js';
import { instantMs, toSalonTime } from './time/zone.js';

// Monday 7 September 2026, 09:00 local (BST). The salon has just opened.
const NOW = '2026-09-07T08:00:00Z';
const MONDAY_START = '2026-09-07T00:00:00Z';
const MONDAY_END = '2026-09-08T00:00:00Z';

function request(overrides: Partial<AvailabilityRequest> = {}): AvailabilityRequest {
  return {
    context: makeContext(),
    service: cutService,
    staff: [priya],
    busy: [],
    from: MONDAY_START,
    to: MONDAY_END,
    now: NOW,
    limit: 100,
    ...overrides,
  };
}

const times = (slots: { localTime: string }[]) => slots.map((s) => s.localTime);

describe('slot generation', () => {
  it('offers slots from opening until the service can still finish before closing', () => {
    const slots = computeAvailability(request());
    expect(slots[0]!.localTime).toBe('09:00');
    // A 60-minute cut starting at 17:00 ends at 18:00, exactly at close. 17:15
    // would overrun, so it is not offered.
    expect(slots.at(-1)!.localTime).toBe('17:00');
    expect(times(slots)).not.toContain('17:15');
  });

  it('steps at the salon configured granularity', () => {
    expect(times(computeAvailability(request())).slice(0, 4)).toEqual(['09:00', '09:15', '09:30', '09:45']);

    const halfHourly = makeContext({
      policy: { ...makeContext().policy, slotGranularityMinutes: 30 },
    });
    expect(times(computeAvailability(request({ context: halfHourly }))).slice(0, 3)).toEqual([
      '09:00', '09:30', '10:00',
    ]);
  });

  it('aligns to the wall-clock grid, not to an odd opening time', () => {
    // A salon opening at 09:20 should still offer 09:30 — the time a customer
    // expects to hear — rather than 09:20, 09:35, 09:50.
    const context = makeContext();
    context.businessHours[1] = { dayOfWeek: 1, isClosed: false, openTime: '09:20:00', closeTime: '18:00:00' };
    expect(times(computeAvailability(request({ context }))).slice(0, 2)).toEqual(['09:30', '09:45']);
  });

  it('respects a shorter closing time for a longer service', () => {
    // Saturday closes at 16:00; a two-hour colour must start by 14:00.
    const saturday = computeAvailability(
      request({
        service: colourService,
        from: '2026-09-12T00:00:00Z',
        to: '2026-09-13T00:00:00Z',
      }),
    );
    expect(saturday.at(-1)!.localTime).toBe('14:00');
  });

  it('returns nothing on a day the salon is closed', () => {
    const sunday = computeAvailability(
      request({ from: '2026-09-13T00:00:00Z', to: '2026-09-14T00:00:00Z' }),
    );
    expect(sunday).toEqual([]);
  });
});

describe('closed dates', () => {
  it('honours a full-day holiday closure', () => {
    const context = makeContext({
      closedDates: [{ date: '2026-09-07', reason: 'Staff training', openTime: null, closeTime: null }],
    });
    expect(computeAvailability(request({ context }))).toEqual([]);
  });

  it('honours special reduced hours that override the regular day', () => {
    const context = makeContext({
      closedDates: [
        { date: '2026-09-07', reason: 'Christmas Eve hours', openTime: '10:00:00', closeTime: '13:00:00' },
      ],
    });
    const slots = computeAvailability(request({ context }));
    expect(slots[0]!.localTime).toBe('10:00');
    expect(slots.at(-1)!.localTime).toBe('12:00');
  });
});

describe('conflicts and buffers', () => {
  const bookedTenToEleven: BusyBlock = {
    staffId: priya.id,
    blockStart: '2026-09-07T09:00:00Z', // 10:00 local
    blockEnd: '2026-09-07T10:15:00Z', // 11:00 local + 15m buffer
  };

  it('removes every start that would overlap an existing booking', () => {
    const slots = times(computeAvailability(request({ busy: [bookedTenToEleven] })));
    // A 60-minute cut starting 09:15 would run to 10:15, into the 10:00 booking.
    for (const blocked of ['09:15', '09:30', '09:45', '10:00', '10:30', '11:00']) {
      expect(slots).not.toContain(blocked);
    }
  });

  it('offers the first start that clears the trailing buffer', () => {
    // The 10:00 cut ends at 11:00 with a 15-minute buffer to 11:15.
    const slots = times(computeAvailability(request({ busy: [bookedTenToEleven] })));
    expect(slots).toContain('11:15');
    expect(slots).not.toContain('11:00');
  });

  it('keeps a start whose own trailing buffer would only just reach the booking', () => {
    // 09:00 cut ends 10:00, buffer to 10:15 — which collides with a 10:00 booking.
    const slots = times(computeAvailability(request({ busy: [bookedTenToEleven] })));
    expect(slots).not.toContain('09:00');
  });

  it('ignores bookings belonging to a different staff member', () => {
    const other: BusyBlock = { ...bookedTenToEleven, staffId: 'someone-else' };
    expect(times(computeAvailability(request({ busy: [other] })))).toContain('10:00');
  });
});

describe('policy limits', () => {
  it('hides slots inside the minimum lead time', () => {
    const context = makeContext({ policy: { ...makeContext().policy, minLeadMinutes: 120 } });
    const slots = computeAvailability(request({ context }));
    // Now is 09:00 local; two hours notice means nothing before 11:00.
    expect(slots[0]!.localTime).toBe('11:00');
  });

  it('hides slots beyond the maximum advance window', () => {
    const context = makeContext({ policy: { ...makeContext().policy, maxAdvanceDays: 3 } });
    const slots = computeAvailability(
      request({ context, from: '2026-09-14T00:00:00Z', to: '2026-09-15T00:00:00Z' }),
    );
    expect(slots).toEqual([]);
  });

  it('never offers a slot in the past even when asked for one', () => {
    // The window asks for a week ago; the engine must clamp to the present.
    const slots = computeAvailability(
      request({ from: '2026-09-01T00:00:00Z', to: MONDAY_END }),
    );
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.every((s) => instantMs(s.start) >= instantMs(NOW))).toBe(true);
    expect(slots[0]!.localDate).toBe('2026-09-07');
  });
});

describe('staff selection', () => {
  it('excludes staff who cannot perform the service', () => {
    // Sam is restricted to cuts; nobody else can do a colour.
    const slots = computeAvailability(request({ service: colourService, staff: [sam] }));
    expect(slots).toEqual([]);
  });

  it('excludes inactive staff', () => {
    expect(computeAvailability(request({ staff: [{ ...priya, active: false }] }))).toEqual([]);
  });

  it('honours a specific staff request', () => {
    const slots = computeAvailability(request({ staff: [priya, sam], staffId: sam.id }));
    expect(new Set(slots.map((s) => s.staffId))).toEqual(new Set([sam.id]));
  });

  it('returns one slot per start time rather than one per stylist', () => {
    const slots = computeAvailability(request({ staff: [priya, sam] }));
    expect(new Set(times(slots)).size).toBe(slots.length);
  });

  it('prefers the least-loaded stylist when several are free', () => {
    const busy: BusyBlock[] = [
      { staffId: priya.id, blockStart: '2026-09-07T14:00:00Z', blockEnd: '2026-09-07T15:00:00Z' },
      { staffId: priya.id, blockStart: '2026-09-07T15:30:00Z', blockEnd: '2026-09-07T16:00:00Z' },
    ];
    const slots = computeAvailability(request({ staff: [priya, sam], busy }));
    expect(slots[0]!.staffId).toBe(sam.id);
  });

  it('respects staff working hours narrower than the salon day', () => {
    const partTime: StaffDef = {
      ...priya,
      workingHours: [{ dayOfWeek: 1, startTime: '13:00:00', endTime: '17:00:00' }],
    };
    const slots = computeAvailability(request({ staff: [partTime] }));
    expect(slots[0]!.localTime).toBe('13:00');
    expect(slots.at(-1)!.localTime).toBe('16:00');
  });

  it('treats a staff member with no shift that day as unavailable', () => {
    const tuesdayOnly: StaffDef = {
      ...priya,
      workingHours: [{ dayOfWeek: 2, startTime: '09:00:00', endTime: '17:00:00' }],
    };
    expect(computeAvailability(request({ staff: [tuesdayOnly] }))).toEqual([]);
  });
});

describe('alternatives when the requested window is full', () => {
  /** Block out every slot on a given local date for a staff member. */
  function fullDay(date: string, staffId: string): BusyBlock {
    return {
      staffId,
      blockStart: `${date}T00:00:00Z`,
      blockEnd: `${date}T23:59:00Z`,
    };
  }

  it('offers concrete nearby times rather than a dead end', () => {
    const req = request({ busy: [fullDay('2026-09-07', priya.id)] });
    expect(computeAvailability(req)).toEqual([]);

    const alternatives = findAlternatives(req, 3);
    expect(alternatives.length).toBe(3);
    // All must be outside the day that was asked for, and genuinely bookable.
    expect(alternatives.every((s) => s.localDate !== '2026-09-07')).toBe(true);
    expect(alternatives.every((s) => s.start > NOW)).toBe(true);
  });

  it('spreads suggestions across different days', () => {
    const alternatives = findAlternatives(request({ busy: [fullDay('2026-09-07', priya.id)] }), 3);
    expect(new Set(alternatives.map((s) => s.localDate)).size).toBe(3);
  });

  it('prefers times nearest to what the caller asked for', () => {
    // Asked for Monday; Tuesday should beat next Friday.
    const alternatives = findAlternatives(request({ busy: [fullDay('2026-09-07', priya.id)] }), 3);
    expect(alternatives[0]!.localDate).toBe('2026-09-08');
  });
});

describe('slot rendering', () => {
  it('carries salon-local date, time and a speakable label', () => {
    // Produced server-side so the voice agent never formats a date itself.
    const slot = computeAvailability(request())[0]!;
    expect(slot.localDate).toBe('2026-09-07');
    expect(slot.localTime).toBe('09:00');
    expect(slot.label).toBe('today at 9 am');
    expect(toSalonTime(slot.start, TZ).toFormat('HH:mm')).toBe('09:00');
  });
});

describe('chooseStaffForSlot', () => {
  it('returns null when nobody can perform the service', () => {
    expect(chooseStaffForSlot([sam], [], colourService)).toBeNull();
  });

  it('is stable for equal load so identical requests give identical answers', () => {
    const a = chooseStaffForSlot([priya, sam], [], cutService);
    const b = chooseStaffForSlot([sam, priya], [], cutService);
    expect(a!.id).toBe(b!.id);
  });
});
