// Answers "what was this worker expected to work on this date?" from the
// effective-dated WorkerSchedule and CrewRotation rows plus per-date
// ShiftException overrides. Pure — callers load the rows and pass them in.

const { rotationShiftsFor } = require('./shiftEngine');

function dateStrOf(d) {
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

function groupSortedByEffective(rows, keyField) {
  const map = new Map();
  for (const r of rows) {
    const k = r[keyField];
    if (!map.has(k)) map.set(k, []);
    map.get(k).push({ ...r, effectiveFromStr: dateStrOf(r.effectiveFrom) });
  }
  for (const list of map.values()) list.sort((a, b) => a.effectiveFromStr.localeCompare(b.effectiveFromStr));
  return map;
}

function latestEffective(list, dateStr) {
  let found = null;
  for (const r of list || []) {
    if (r.effectiveFromStr <= dateStr) found = r;
    else break;
  }
  return found;
}

function parseExceptionShifts(value) {
  return String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

// profiles (optional) — WorkerProfile rows. A worker with no confirmed
// schedule is expected on their profiled pattern (source 'suggested') until
// HR confirms or changes it, instead of having their punches guessed from
// clock time alone.
function buildResolver({ schedules = [], rotations = [], exceptions = [], workers = [], profiles = [] }) {
  const schedulesByWorker = groupSortedByEffective(schedules, 'casualWorkerId');
  const rotationsByCrew = groupSortedByEffective(rotations, 'crewId');
  const exceptionByKey = new Map(exceptions.map((e) => [`${e.casualWorkerId}|${dateStrOf(e.date)}`, e]));
  const inactive = new Set(workers.filter((w) => w.status !== 'active').map((w) => w.id));
  const profileByWorker = new Map(profiles.filter((p) => p.suggestedType).map((p) => [p.casualWorkerId, p]));

  function scheduleOn(workerId, dateStr) {
    return latestEffective(schedulesByWorker.get(workerId), dateStr);
  }

  function rotationOn(crewId, dateStr) {
    return latestEffective(rotationsByCrew.get(crewId), dateStr);
  }

  function crewShiftsOn(crewId, dateStr) {
    const rot = rotationOn(crewId, dateStr);
    return rot ? rotationShiftsFor(rot.pattern, dateStrOf(rot.anchorDate), dateStr) : [];
  }

  function scheduledShiftsOn(workerId, dateStr) {
    const s = scheduleOn(workerId, dateStr);
    if (!s) return [];
    if (s.type === 'fixed-day') return ['Day'];
    if (s.type === 'fixed-night') return ['Night'];
    if (s.type === 'crew' && s.crewId) return crewShiftsOn(s.crewId, dateStr);
    return [];
  }

  // The profiler's suggestion, as a schedule, for a worker whose confirmed
  // schedule is missing or "unassigned" on dateStr — null otherwise.
  function suggestedScheduleOn(workerId, dateStr) {
    const confirmed = scheduleOn(workerId, dateStr);
    if (confirmed && confirmed.type !== 'unassigned') return null;
    const p = profileByWorker.get(workerId);
    if (!p) return null;
    if (p.suggestedType === 'rotation') {
      return { type: 'rotation', pattern: p.suggestedPattern, anchorDate: dateStrOf(p.suggestedAnchor) };
    }
    return { type: p.suggestedType, crewId: p.suggestedCrewId };
  }

  // Confirmed schedule, or the suggestion when there isn't one.
  function effectiveScheduleOn(workerId, dateStr) {
    const confirmed = scheduleOn(workerId, dateStr);
    if (confirmed && confirmed.type !== 'unassigned') return confirmed;
    return suggestedScheduleOn(workerId, dateStr) || confirmed;
  }

  function shiftsForSchedule(s, dateStr) {
    if (!s) return [];
    if (s.type === 'fixed-day') return ['Day'];
    if (s.type === 'fixed-night') return ['Night'];
    if (s.type === 'crew' && s.crewId) return crewShiftsOn(s.crewId, dateStr);
    if (s.type === 'rotation') return rotationShiftsFor(s.pattern, s.anchorDate, dateStr);
    return [];
  }

  function expectedFor(workerId) {
    return (dateStr) => {
      if (inactive.has(workerId)) return { shifts: [], source: 'schedule' };
      const ex = exceptionByKey.get(`${workerId}|${dateStr}`);
      if (ex) return { shifts: parseExceptionShifts(ex.shifts), source: 'exception' };
      const suggested = suggestedScheduleOn(workerId, dateStr);
      if (suggested) return { shifts: shiftsForSchedule(suggested, dateStr), source: 'suggested' };
      return { shifts: scheduledShiftsOn(workerId, dateStr), source: 'schedule' };
    };
  }

  function crewsOnShift(dateStr, shiftName, crewIds) {
    return crewIds.filter((id) => crewShiftsOn(id, dateStr).includes(shiftName));
  }

  return { scheduleOn, effectiveScheduleOn, rotationOn, crewShiftsOn, scheduledShiftsOn, expectedFor, crewsOnShift };
}

// Stable signature of a schedule, used to compare a worker's current
// schedule with the profiler's suggestion (WorkerProfile.suggestionKey).
function scheduleKey(schedule) {
  if (!schedule || schedule.type === 'unassigned') return 'unassigned';
  if (schedule.type === 'crew') return `crew:${schedule.crewId}`;
  return schedule.type;
}

module.exports = { buildResolver, parseExceptionShifts, dateStrOf, scheduleKey };
