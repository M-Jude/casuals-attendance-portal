// Unit tests for the report catalog and renderers — pure, no database.
//   node test/reportsTest.js

const { resolvePeriod, buildReport, REPORT_TYPES, catalogFor } = require('../reports/reportCatalog');
const { renderCsv } = require('../reports/renderCsv');
const { renderXlsx } = require('../reports/renderXlsx');
const { renderPdf } = require('../reports/renderPdf');

const checks = [];
function check(label, passed) { checks.push([label, !!passed]); }

const DAY = { id: 1, name: 'Day', startTime: '08:00', endTime: '17:00', graceMinutes: 30 };
const NIGHT = { id: 2, name: 'Night', startTime: '17:00', endTime: '08:00', graceMinutes: 30 };
const CREW_A = { id: 7, name: 'Crew A' };
const ctx = { shifts: [DAY, NIGHT], crewsById: new Map([[7, CREW_A]]) };
const W1 = { id: 1, name: 'Achieng Mary', biostarUserId: 'C0012026' };
const W2 = { id: 2, name: 'Byaruhanga Tom', biostarUserId: 'C0022026' };
const eat = (date, hhmm) => new Date(`${date}T${hhmm}:00+03:00`);

let nextId = 1;
function row(worker, date, shift, o = {}) {
  return {
    id: nextId++, worker, shift: { id: shift.id, name: shift.name }, date: new Date(`${date}T00:00:00Z`),
    source: 'schedule', checkIn: null, checkOut: null, checkInImplied: false, checkOutImplied: false,
    hoursWorked: null, status: 'no-show', lateIn: false, earlyCheckOut: false, hasMultiplePunches: false,
    approvalCrewId: 7, approvedAt: null, changedAfterApproval: false, ...o
  };
}
const rows = [
  row(W1, '2026-09-21', DAY, { checkIn: eat('2026-09-21', '07:55'), checkOut: eat('2026-09-21', '17:05'), hoursWorked: 9.17, status: 'on-time', approvedAt: new Date() }),
  row(W1, '2026-09-21', NIGHT, { checkIn: eat('2026-09-21', '17:00'), checkOut: eat('2026-09-22', '08:00'), hoursWorked: 15, status: 'on-time', checkInImplied: true }),
  row(W1, '2026-09-23', NIGHT, { checkIn: eat('2026-09-23', '17:50'), checkOut: eat('2026-09-24', '08:02'), hoursWorked: 14.2, status: 'late', lateIn: true }),
  row(W2, '2026-09-21', DAY),
  row(W2, '2026-09-22', DAY, { checkIn: eat('2026-09-22', '08:10'), checkOut: eat('2026-09-22', '15:00'), hoursWorked: 6.83, status: 'on-time', earlyCheckOut: true, approvalCrewId: null }),
  row(W2, '2026-09-24', DAY, { checkIn: eat('2026-09-24', '08:05'), status: 'no-checkout', hasMultiplePunches: true, source: 'unscheduled' })
];

// --- Periods ---
{
  const w = resolvePeriod({ period: 'week', date: '2026-09-24' });
  check('Week runs Monday to Sunday', w.from === '2026-09-21' && w.to === '2026-09-27');
  const m = resolvePeriod({ period: 'month', month: '2026-02' });
  check('Month ends on its last day', m.from === '2026-02-01' && m.to === '2026-02-28');
  check('Range rejects from > to', resolvePeriod({ period: 'range', from: '2026-09-10', to: '2026-09-01' }).error);
  const a = resolvePeriod({ period: 'all' }, { min: '2026-09-09', max: '2026-09-28' });
  check('All time spans the data', a.from === '2026-09-09' && a.to === '2026-09-28');
  check('All time with no data is an error', resolvePeriod({ period: 'all' }, null).error);
  check('Bad date rejected', resolvePeriod({ period: 'day', date: '2026-9-1' }).error);
}

// --- Catalog ---
check('Finance cannot run the approval status report', !catalogFor('finance').some((t) => t.id === 'approvals'));
check('Supervisor can run it', catalogFor('supervisor').some((t) => t.id === 'approvals'));

const week = resolvePeriod({ period: 'week', date: '2026-09-21' });

// --- Builders ---
{
  const r = buildReport('summary', ctx, rows, week);
  const s = r.sections[0];
  const a = s.rows.find((x) => x.id === 'C0012026');
  const b = s.rows.find((x) => x.id === 'C0022026');
  check('Summary: Day + Night on one date counts as two shifts', a.worked === 3 && a.day === 1 && a.night === 2);
  check('Summary: hours summed', a.hours === 38.37);
  check('Summary: no-show and missing punch tallied', b.noShow === 1 && b.missing === 1 && b.worked === 2);
  check('Summary: attendance rate = worked / (worked + no-show)', b.rate === 66.7);
  check('Summary: totals add up', s.totals.worked === 5 && s.totals.noShow === 1);
  check('Summary: weekly title', r.title === 'Weekly attendance summary');
}
{
  const r = buildReport('daily', ctx, rows.filter((x) => x.date.toISOString().startsWith('2026-09-21')), resolvePeriod({ period: 'day', date: '2026-09-21' }));
  check('Daily: one section per shift worked', r.sections.length === 2 && r.sections[0].title.startsWith('Day shift'));
  check('Daily: Day section holds both workers', r.sections[0].rows.length === 2);
}
{
  const r = buildReport('individual', { ...ctx, worker: W1 }, rows.filter((x) => x.worker.id === 1), resolvePeriod({ period: 'month', month: '2026-09' }));
  check('Individual: subtitle names the worker', r.subtitle.includes('Achieng Mary') && r.subtitle.includes('Crew A'));
  check('Individual: week-by-week section for a month', r.sections.length === 2 && r.sections[1].rows.length === 1);
}
{
  const r = buildReport('register', ctx, rows, week);
  const a = r.sections[0].rows.find((x) => x.id === 'C0012026');
  const b = r.sections[0].rows.find((x) => x.id === 'C0022026');
  check('Register: double shift is DN', a['d2026-09-21'] === 'DN');
  check('Register: night only is N, off is blank', a['d2026-09-23'] === 'N' && a['d2026-09-22'] === '');
  check('Register: no-show is A', b['d2026-09-21'] === 'A' && b.absent === 1);
  check('Register: date totals count people present', r.sections[0].totals['d2026-09-21'] === '1');
  check('Register: longer than 31 days refused', buildReport('register', ctx, rows, resolvePeriod({ period: 'range', from: '2026-08-01', to: '2026-09-30' })).error);
  check('Register: landscape', r.landscape === true);
}
{
  const r = buildReport('hours', ctx, rows, week);
  const a = r.sections[0].rows.find((x) => x.id === 'C0012026');
  check('Hours: approved vs pending split', a.approvedShifts === 1 && a.approvedHours === 9.17 && a.pendingShifts === 2);
}
{
  const r = buildReport('exceptions', ctx, rows, week);
  const late = r.sections.find((s) => s.title === 'Late arrivals');
  check('Exceptions: minutes late from shift start', late.rows[0].minutes === 50);
  const early = r.sections.find((s) => s.title === 'Early check-outs');
  check('Exceptions: minutes early from shift end', early.rows[0].minutes === 120);
  check('Exceptions: no-show, missing, multi and unscheduled sections', ['No-shows', 'Missing punches', 'Multiple punches', 'Unscheduled shifts'].every((t) => r.sections.some((s) => s.title === t)));
  check('Exceptions: worst offenders first', r.sections[0].title === 'Workers with the most exceptions');
}
{
  const r = buildReport('daily-totals', ctx, rows, week);
  const d21 = r.sections[0].rows.find((x) => x.date === '2026-09-21');
  check('Daily totals: Day/Night headcount', d21.day === 1 && d21.night === 1 && d21.noShow === 1);
}
{
  const r = buildReport('crew', ctx, rows, week);
  check('Crew: overview + one section per crew incl. non-crew', r.sections.length === 3 && r.sections[2].title === 'Not in a crew');
}
{
  const units = [
    { kind: 'crew-shift', label: 'Crew A · Day · 2026-09-21', rows: 2, dueAt: new Date('2026-09-21T14:00:00Z'), status: 'approved', approvedAt: new Date('2026-09-22T14:00:00Z'), approvedByName: 'Sup A' },
    { kind: 'crew-shift', label: 'Crew A · Night · 2026-09-21', rows: 1, dueAt: new Date('2026-09-22T05:00:00Z'), status: 'pending', escalatedAt: new Date('2026-09-24T05:00:00Z') }
  ];
  const r = buildReport('approvals', { ...ctx, now: Date.parse('2026-09-28T00:00:00Z') }, units, week);
  check('Approvals: states and wait time', r.sections[0].rows[0].state === 'Approved' && r.sections[0].rows[0].waitHours === 24 && r.sections[0].rows[1].state === 'Escalated');
}

{
  const punchTimes = new Map([[rows[2].id, [eat('2026-09-23', '17:50'), eat('2026-09-23', '17:52'), eat('2026-09-24', '08:02')]]]);
  const r = buildReport('timesheet', { ...ctx, punchTimes }, rows, week);
  const s = r.sections[0];
  const groups = s.rows.filter((x) => x._group);
  check('Timesheet: one group header per worker, workers A-Z', groups.length === 2 && groups[0]._group === 'Achieng Mary (C0012026)');
  check('Timesheet: group note sums the worker', groups[0]._groupNote.includes('3 shifts worked') && groups[0]._groupNote.includes('38.37 h') && groups[0]._groupNote.includes('1 late'));
  const lateRow = s.rows.find((x) => x.date === '2026-09-23');
  check('Timesheet: clock in/out kept as times, late by minutes', lateRow.checkIn && lateRow.checkOut && lateRow.lateBy === 50);
  check('Timesheet: every badge listed in EAT', lateRow.badges === '17:50, 17:52, 08:02');
  const early = s.rows.find((x) => x.date === '2026-09-22');
  check('Timesheet: left early by minutes', early.earlyBy === 120);
  check('Timesheet: absent shift still listed, with a blank status', s.rows.some((x) => x.date === '2026-09-21' && x.worker === 'Byaruhanga Tom' && x.status === '' && !x.checkIn));
  check('Timesheet: late shift shows Late in only', lateRow.status === 'late-in');
  check('Timesheet: early check-out shows Early out', early.status === 'early-out');
  const csv = renderCsv(r, { orgName: 'X', subcontractorName: 'S', generatedAt: new Date(), generatedBy: 'T', filters: [] });
  check('Timesheet CSV: worker header lines and clock times', csv.includes('Achieng Mary (C0012026),') && csv.includes('17:50') && csv.includes('Clock in,Clock out'));
}

// --- Crew column = the worker's own crew, not the approving crew ---
{
  const own = { ...ctx, crewOf: (workerId) => (workerId === W1.id ? 7 : null) };
  const r = buildReport('detailed', own, rows, week);
  const crewOfRow = (id) => r.sections[0].rows.filter((x) => x.id === id).map((x) => x.crew);
  check('Crew column: a crew member shows their own crew', crewOfRow('C0012026').every((c) => c === 'Crew A'));
  check('Crew column: someone not on a crew shows "Not in a crew" even when a crew supervisor approves them',
    rows.some((x) => x.worker.id === W2.id && x.approvalCrewId === 7) && crewOfRow('C0022026').every((c) => c === 'Not in a crew'));
}

// --- Column choice ---
{
  const { REPORT_COLUMNS, applyColumnChoice, choiceKey } = require('../reports/reportCatalog');
  const units = [{ kind: 'crew-shift', label: 'x', rows: 1, dueAt: new Date(), status: 'pending' }];
  for (const t of REPORT_TYPES) {
    const period = t.id === 'daily' ? resolvePeriod({ period: 'day', date: '2026-09-21' }) : week;
    const model = buildReport(t.id, { ...ctx, worker: W1, punchTimes: new Map() }, t.id === 'approvals' ? units : rows, period);
    const used = new Set(model.sections.flatMap((s) => s.columns.map(choiceKey)));
    const missing = [...used].filter((k) => !REPORT_COLUMNS[t.id].includes(k));
    check(`${t.id}: every column can be chosen${missing.length ? ` (missing ${missing})` : ''}`, missing.length === 0);
  }
  const model = buildReport('summary', ctx, rows, week);
  const trimmed = applyColumnChoice(model, new Set(['crew', 'avg', 'earlyOut']));
  const keys = trimmed.sections[0].columns.map((c) => c.key);
  check('Column choice: hidden columns are dropped, the rest keep their order', !keys.includes('crew') && !keys.includes('avg') && keys[0] === 'id' && keys.includes('rate'));
  const reg = applyColumnChoice(buildReport('register', ctx, rows, week), new Set(['dates']));
  check('Column choice: "dates" hides every register date column', !reg.sections[0].columns.some((c) => c.type === 'code'));
  const all = applyColumnChoice(model, new Set(REPORT_COLUMNS.summary));
  check('Column choice: a section never ends up with no columns', all.sections[0].columns.length === model.sections[0].columns.length);
  const csv = renderCsv(trimmed, { orgName: 'X', subcontractorName: 'S', generatedAt: new Date(), generatedBy: 'T', filters: [] });
  check('Column choice: CSV header follows it', csv.includes('Employee ID,Worker,Shifts worked,') && !csv.includes('Avg h/shift'));
}

// --- Renderers ---
const meta = { orgName: 'UCAA-ARK Group Casuals Management System', subcontractorName: 'Subcontractor A', generatedAt: new Date('2026-09-28T07:00:00Z'), generatedBy: 'Test (HR)', scopeNote: null, filters: [] };

(async () => {
  for (const t of REPORT_TYPES) {
    const period = t.id === 'daily' ? resolvePeriod({ period: 'day', date: '2026-09-21' }) : week;
    const data = t.id === 'approvals' ? [] : rows;
    const model = buildReport(t.id, { ...ctx, worker: W1 }, data, period);
    const csv = renderCsv(model, meta);
    check(`${t.id}: CSV has BOM, title and CRLF`, csv.startsWith('﻿') && csv.includes(model.title.toUpperCase()) && csv.includes('\r\n'));
    const xlsx = await renderXlsx(model, meta);
    check(`${t.id}: Excel is a zip`, Buffer.from(xlsx).slice(0, 2).toString() === 'PK');
    const pdf = await new Promise((resolve, reject) => {
      const doc = renderPdf(model, meta);
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });
    check(`${t.id}: PDF renders`, pdf.slice(0, 5).toString() === '%PDF-');
  }
  {
    const csv = renderCsv(buildReport('summary', ctx, rows, week), meta);
    check('CSV: TOTAL row and readable status/times', csv.includes('TOTAL,') && csv.includes('38.37'));
    const daily = renderCsv(buildReport('daily', ctx, rows.slice(0, 1), resolvePeriod({ period: 'day', date: '2026-09-21' })), meta);
    check('CSV: times printed in EAT, on-time status left blank', daily.includes('07:55') && !daily.includes('On time'));
    const { statusTags } = require('../reports/reportCatalog');
    check('Status: late check-in → Late in', statusTags({ status: 'late' }) === 'late-in');
    check('Status: late check-in on a no-checkout shift → Late in', statusTags({ status: 'no-checkout', lateIn: true }) === 'late-in');
    check('Status: late and left early → both', statusTags({ status: 'late', earlyCheckOut: true }) === 'late-in,early-out');
    check('Status: on time, early arrival, no-show, missing punch, in progress → blank',
      ['on-time', 'early', 'no-show', 'no-checkout', 'no-checkin', 'in-progress'].every((st) => statusTags({ status: st }) === ''));
    const both = renderCsv(buildReport('detailed', ctx, [row(W1, '2026-09-25', DAY, { checkIn: eat('2026-09-25', '08:45'), checkOut: eat('2026-09-25', '15:00'), hoursWorked: 6.25, status: 'late', lateIn: true, earlyCheckOut: true })], week), meta);
    check('CSV: both tags printed, flags no longer repeat them', both.includes('Late in · Early out') && !both.includes('Early check-out'));
  }

  const failed = checks.filter(([, ok]) => !ok);
  for (const [label, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
