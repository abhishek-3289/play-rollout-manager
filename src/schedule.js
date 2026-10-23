export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const SHORT_TO_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

export function dayIndex(name) {
  const key = name.trim().toLowerCase().slice(0, 3);
  const index = SHORT_TO_INDEX[key];
  if (index === undefined || !DAY_NAMES[index].toLowerCase().startsWith(name.trim().toLowerCase())) return null;
  return index;
}

export function parseAllowedDays(value) {
  const text = value.trim().toLowerCase();
  if (text === 'all' || text === 'any' || text === '*') return new Set([0, 1, 2, 3, 4, 5, 6]);
  const parts = text.split(',').map((part) => part.trim()).filter((part) => part !== '');
  if (parts.length === 0) return null;
  const days = new Set();
  for (const part of parts) {
    const range = part.split('-').map((piece) => piece.trim());
    if (range.length > 2 || range.some((piece) => piece.length < 3)) return null;
    const start = dayIndex(range[0]);
    const end = range.length === 2 ? dayIndex(range[1]) : start;
    if (start === null || end === null) return null;
    for (let day = start; ; day = (day + 1) % 7) {
      days.add(day);
      if (day === end) break;
    }
  }
  return days;
}

export function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function weekdayIn(date, timeZone) {
  const name = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone }).format(date);
  return DAY_NAMES.indexOf(name);
}
