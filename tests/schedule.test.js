import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayIndex, isValidTimeZone, parseAllowedDays, weekdayIn } from '../src/schedule.js';

function days(value) {
  const parsed = parseAllowedDays(value);
  return parsed === null ? null : [...parsed].sort((a, b) => a - b);
}

test('dayIndex accepts short and full names in any case', () => {
  assert.equal(dayIndex('mon'), 1);
  assert.equal(dayIndex('Monday'), 1);
  assert.equal(dayIndex('SUN'), 0);
  assert.equal(dayIndex('sat'), 6);
  assert.equal(dayIndex('monx'), null);
  assert.equal(dayIndex('xyz'), null);
});

test('parseAllowedDays handles ranges, lists, wrap-around and all', () => {
  assert.deepEqual(days('mon-fri'), [1, 2, 3, 4, 5]);
  assert.deepEqual(days('Mon, Wed ,fri'), [1, 3, 5]);
  assert.deepEqual(days('sat-sun'), [0, 6]);
  assert.deepEqual(days('fri-mon'), [0, 1, 5, 6]);
  assert.deepEqual(days('monday-wednesday,sat'), [1, 2, 3, 6]);
  assert.deepEqual(days('tue'), [2]);
  assert.deepEqual(days('all'), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(days('*'), [0, 1, 2, 3, 4, 5, 6]);
});

test('parseAllowedDays rejects invalid values', () => {
  assert.equal(parseAllowedDays(''), null);
  assert.equal(parseAllowedDays('weekdays'), null);
  assert.equal(parseAllowedDays('mo-fr'), null);
  assert.equal(parseAllowedDays('mon-tue-wed'), null);
  assert.equal(parseAllowedDays('1-5'), null);
});

test('parseAllowedDays ignores empty list items', () => {
  assert.deepEqual(days('mon,,fri'), [1, 5]);
});

test('isValidTimeZone accepts IANA zones only', () => {
  assert.equal(isValidTimeZone('UTC'), true);
  assert.equal(isValidTimeZone('Asia/Kolkata'), true);
  assert.equal(isValidTimeZone('America/Los_Angeles'), true);
  assert.equal(isValidTimeZone('Mars/Olympus'), false);
});

test('weekdayIn uses the given time zone', () => {
  const fridayEveningUtc = new Date('2026-03-13T20:00:00Z');
  assert.equal(weekdayIn(fridayEveningUtc, 'UTC'), 5);
  assert.equal(weekdayIn(fridayEveningUtc, 'Asia/Kolkata'), 6);
  const mondayEarlyUtc = new Date('2026-03-16T02:00:00Z');
  assert.equal(weekdayIn(mondayEarlyUtc, 'UTC'), 1);
  assert.equal(weekdayIn(mondayEarlyUtc, 'America/Los_Angeles'), 0);
});
