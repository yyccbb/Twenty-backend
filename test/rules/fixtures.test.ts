import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GRID_RULES,
  DEFAULT_REWARD_RULE,
  computeTokens,
  isSupportedTimezone,
  planExtension,
  recordFinish,
  recordStart,
  snap,
  validateEventBlock,
} from '../../src/rules/index.js';
import { fixtures, gridRules, normalize, rewardRule, toCalendar, toDate } from './load-fixtures.js';

const runners: Record<string, (input: any) => unknown> = {
  snap: (i) => ({ snapped: snap(new Date(i.tapped_at), gridRules) }),
  start: (i) =>
    recordStart(
      {
        plannedStart: new Date(i.planned_start),
        plannedEnd: new Date(i.planned_end),
        tappedAt: new Date(i.tapped_at),
        eventId: i.event_id,
        calendar: i.calendar ? toCalendar(i.calendar) : undefined,
      },
      gridRules,
    ),
  finish: (i) =>
    recordFinish(
      { recordedStart: new Date(i.recorded_start), plannedEnd: new Date(i.planned_end), tappedAt: toDate(i.tapped_at) },
      gridRules,
    ),
  tokens: (i) =>
    computeTokens(
      {
        originalStart: new Date(i.original_start),
        originalEnd: new Date(i.original_end),
        recordedStart: toDate(i.recorded_start),
        recordedEnd: toDate(i.recorded_end),
        finishKind: i.finish_kind,
      },
      rewardRule,
      gridRules,
    ),
  extend: (i) =>
    planExtension(
      {
        calendar: toCalendar(i.calendar),
        eventId: i.event_id,
        slots: i.slots,
        now: new Date(i.now),
        timezone: i.timezone,
        dayEndLocalTime: i.day_end_local_time,
      },
      gridRules,
    ),
  create: (i) =>
    validateEventBlock({ calendar: toCalendar(i.calendar), start: new Date(i.start), end: new Date(i.end) }, gridRules),
  timezone: (i) => ({ supported: isSupportedTimezone(i.timezone) }),
};

describe('rules fixtures', () => {
  it('server defaults are the fixture constants', () => {
    expect(DEFAULT_GRID_RULES).toStrictEqual(gridRules);
    expect(DEFAULT_REWARD_RULE).toStrictEqual(rewardRule);
  });

  it('covers every fixture group', () => {
    expect(Object.keys(fixtures.groups).sort()).toEqual(Object.keys(runners).sort());
  });

  for (const [group, cases] of Object.entries(fixtures.groups)) {
    describe(group, () => {
      for (const c of cases) {
        it(`${c.id}: ${c.desc}`, () => {
          const run = runners[group];
          if (!run) throw new Error(`no runner for group ${group}`);
          expect(normalize(run(c.input))).toStrictEqual(normalize(c.expected));
        });
      }
    });
  }
});
