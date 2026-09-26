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

function buildResolver({ schedules = [], rotations = [], exceptions = [], workers = [] }) {
  const schedulesByWorker = groupSortedByEffective(schedules, 'casualWorkerId');
  const rotationsByCrew = groupSortedByEffective(rotations, 'crewId');
  const exceptionByKey = new Map(exceptions.map((e) => [`${e.casualWorkerId}|${dateStrOf(e.date)}`, e]));
  const inactive = new Set(workers.filter((w) => w.status !== 'active').map((w) => w.id));

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

  function expectedFor(workerId) {
    return (dateStr) => {
      if (inactive.has(workerId)) return { shifts: [], source: 'schedule' };
      const ex = exceptionByKey.get(`${workerId}|${dateStr}`);
      if (ex) return { shifts: parseExceptionShifts(ex.shifts), source: 'exception' };
      return { shifts: scheduledShiftsOn(workerId, dateStr), source: 'schedule' };
    };
  }

  function crewsOnShift(dateStr, shiftName, crewIds) {
    return crewIds.filter((id) => crewShiftsOn(id, dateStr).includes(shiftName));
  }

  return { scheduleOn, rotationOn, crewShiftsOn, scheduledShiftsOn, expectedFor, crewsOnShift };
}

// Stable signature of a schedule, used to compare a worker's current
// schedule with the profiler's suggestion (WorkerProfile.suggestionKey).
function scheduleKey(schedule) {
  if (!schedule || schedule.type === 'unassigned') return 'unassigned';
  if (schedule.type === 'crew') return `crew:${schedule.crewId}`;
  return schedule.type;
}

module.exports = { buildResolver, parseExceptionShifts, dateStrOf, scheduleKey };
