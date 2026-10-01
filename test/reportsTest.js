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
  row(W1, '2026-09-21', DAY, { checkIn: eat('2026-09-21', '07:55'), checkOut: eat('2026-09-21', '17:00'), hoursWorked: 9.08, status: 'on-time', approvedAt: new Date(), checkOutImplied: true }),
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
  check('Summary: hours summed', a.hours === 38.28);
  check('Summary: no-show and missing punch tallied', b.noShow === 1 && b.missing === 1 && b.worked === 2);
  check('Summary: attendance rate = worked / (worked + no-show)', b.rate === 66.7);
  check('Summary: totals add up', s.totals.worked === 5 && s.totals.noShow === 1);
  check('Summary: weekly title', r.title === 'Weekly attendance summary');
}
{
  const r = buildReport('daily', ctx, rows.filter((x) => x.date.toISOString().startsWith('2026-09-21')), resolvePeriod({ period: 'day', date: '2026-09-21' }));
  check('Daily: one section per shift worked', r.sections.length === 2 && r.sections[0].title.startsWith('Day shift'));
  check('Daily: Day section holds the Day-only worker, the double shift its own section', r.sections[0].rows.length === 1
    && r.sections[1].title === 'Double shift (Day + Night)' && r.sections[1].rows[0].shift === 'Day + Night' && r.sections[1].rows[0].hours === 24.08);
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
  check('Hours: approved vs pending split', a.approvedShifts === 1 && a.approvedHours === 9.08 && a.pendingShifts === 2);
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
  check('Timesheet: group note sums the worker', groups[0]._groupNote.includes('3 shifts worked') && groups[0]._groupNote.includes('38.28 h') && groups[0]._groupNote.includes('1 late'));
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

// --- Double shifts (W1: Day + Night on 2026-09-21, no changeover badge) ---
{
  const one = (type, c = ctx, data = rows) => buildReport(type, c, data, week);
  const w1 = (r) => r.sections[0].rows.find((x) => x.id === 'C0012026');
  const s = one('summary');
  check('Double: summary counts one double shift, still three shifts worked', w1(s).double === 1 && w1(s).worked === 3 && s.sections[0].totals.double === 1);
  check('Double: register Double column', w1(one('register')).double === 1);
  const h = one('hours');
  check('Double: hours report counts the date and its hours', w1(h).double === 1 && w1(h).doubleHours === 24.08);
  check('Double: hours KPI', h.kpis.find((k) => k.label === 'Double shifts').value === '1');
  const ex = one('exceptions').sections.find((x) => x.title === 'Double shifts');
  check('Double: exceptions lists it once, Day + Night, total hours, implied changeover',
    ex && ex.rows.length === 1 && ex.rows[0].shift === 'Day + Night' && ex.rows[0].hours === 24.08 && ex.rows[0].changeover.startsWith('No badge'));
  check('Double: daily headcount', one('daily-totals').sections[0].rows.find((x) => x.date === '2026-09-21').double === 1);
  check('Double: crew overview', one('crew').sections[0].rows.find((x) => x.crew === 'Crew A').double === 1);
  const det = one('detailed').sections[0].rows;
  const d21 = det.filter((x) => x.id === 'C0012026' && x.date === '2026-09-21');
  check('Double: Day + Night is one line, Day clock-in to Night clock-out, flagged as 2 shifts',
    d21.length === 1 && d21[0].shift === 'Day + Night' && d21[0].hours === 24.08 && d21[0].flags.includes('Double shift - 2 shifts')
    && d21[0].checkIn.getTime() === eat('2026-09-21', '07:55').getTime() && d21[0].checkOut.getTime() === eat('2026-09-22', '08:00').getTime());
  check('Double: other shifts not flagged', !det.find((x) => x.date === '2026-09-23').flags.includes('Double shift'));
  check('Double: next-day clock-out marked (+1), other lines not', d21[0]._dayOffset?.checkOut === 1 && det.filter((x) => x._dayOffset).length === 1);
  const detCsv = renderCsv(one('detailed'), { orgName: 'UCAA', subcontractorName: 'S', generatedAt: new Date(), generatedBy: 't' });
  check('Double: CSV shows the clock-out as "08:00 (+1)"', detCsv.includes('08:00 (+1)'));
  check('Double: approval shown per shift when they differ', d21[0].approval === 'Day: Approved · Night: Pending');
  check('Double: detailed total still counts shifts', det.length === 5 && one('detailed').sections[0].totals.date === '5 shifts worked');
  check('Double: timesheet group note', one('timesheet').sections[0].rows[0]._groupNote.includes('1 double shift'));
  check('Double: shifts-worked KPI mentions it', one('summary').kpis.find((k) => k.label === 'Shifts worked').sub.includes('1 double'));
  const ind = buildReport('individual', { ...ctx, worker: W1 }, rows.filter((x) => x.worker.id === 1), resolvePeriod({ period: 'month', month: '2026-09' }));
  check('Double: individual week-by-week', ind.sections[1].rows[0].double === 1);
  // A scheduled double where one half was a no-show is not a double.
  const withNoShow = [...rows, row(W2, '2026-09-22', NIGHT)];
  const b = one('summary', ctx, withNoShow).sections[0].rows.find((x) => x.id === 'C0022026');
  check('Double: a no-show half is not a double', b.double === 0);
}

// --- Day + Night where the changeover badge went to the Day (the 30 Sep case) ---
{
  const W4 = { id: 4, name: 'Ssemuyaba Francis', biostarUserId: 'C01622026' };
  const day = row(W4, '2026-09-30', DAY, { checkIn: eat('2026-09-30', '07:40'), checkOut: eat('2026-09-30', '17:32'), hoursWorked: 9.87, status: 'on-time', source: 'unscheduled', approvalCrewId: 7 });
  const night = row(W4, '2026-09-30', NIGHT, { checkOut: eat('2026-10-01', '07:41'), hoursWorked: null, status: 'no-checkin', source: 'unscheduled', approvalCrewId: null });
  const sep30 = resolvePeriod({ period: 'day', date: '2026-09-30' });
  const det = buildReport('detailed', ctx, [day, night], sep30).sections[0].rows;
  check('30 Sep: one line, 07:40 to 1 Oct 07:41, 24.02 h', det.length === 1 && det[0].hours === 24.02
    && det[0].checkIn.getTime() === eat('2026-09-30', '07:40').getTime() && det[0].checkOut.getTime() === eat('2026-10-01', '07:41').getTime()
    && det[0]._dayOffset?.checkOut === 1);
  const s = buildReport('summary', ctx, [day, night], sep30).sections[0].rows[0];
  check('30 Sep: 2 shifts, 1 double, 24.02 h, no missing punch', s.worked === 2 && s.double === 1 && s.hours === 24.02 && s.missing === 0);
  const h = buildReport('hours', ctx, [day, night], sep30).sections[0].rows[0];
  check('30 Sep: each shift approved on its own share of the hours', h.pendingHours === 24.02 && h.doubleHours === 24.02);
  const crew = buildReport('crew', ctx, [day, night], sep30).sections;
  check('30 Sep: the Night\'s share goes to its own crew line', crew.find((x) => x.title === 'Not in a crew').rows[0].hours === 14.15
    && crew.find((x) => x.title === 'Crew A').rows[0].hours === 9.87);
  check('30 Sep: nothing on 1 Oct', buildReport('detailed', { ...ctx, doubleRows: [day, night] }, [], resolvePeriod({ period: 'day', date: '2026-10-01' })).sections[0].rows.length === 0);
}

// --- Double shifts across midnight: Night then the next morning's Day ---
{
  const W3 = { id: 3, name: 'Cheptoo Ann', biostarUserId: 'C0032026' };
  const worked = (date, shift, hours) => row(W3, date, shift, { status: 'on-time', hoursWorked: hours, checkIn: eat(date, shift === DAY ? '08:00' : '17:00') });
  const before = worked('2026-09-20', NIGHT, 15);  // previous week
  const mon = worked('2026-09-21', DAY, 9);        // continues Sunday night's double
  const tue = worked('2026-09-22', NIGHT, 15);
  const wed = worked('2026-09-23', DAY, 9);        // Night 22 + Day 23
  const sun = worked('2026-09-27', NIGHT, 15);
  const after = worked('2026-09-28', DAY, 9);      // next week
  const inWeek = [mon, tue, wed, sun];
  const wide = [before, ...inWeek, after];
  const c = { ...ctx, doubleRows: wide };
  const s = buildReport('summary', c, inWeek, week).sections[0].rows[0];
  check('Across midnight: Night + next Day counts, as does one running past the period end; one started before does not', s.double === 2 && s.worked === 4);
  const det = buildReport('detailed', c, inWeek, week).sections[0].rows;
  const flags = (d) => det.find((x) => x.date === d).flags;
  check('Across midnight: both shifts flagged with the pair', flags('2026-09-22').includes('Double shift (Night + next Day)') && flags('2026-09-23').includes('Double shift (Night + next Day)'));
  check('Across midnight: a shift continuing from before the period is still flagged', flags('2026-09-21').includes('Double shift'));
  const reg = buildReport('register', c, inWeek, week).sections[0].rows[0];
  check('Across midnight: register marks N+ then +D', reg['d2026-09-22'] === 'N+' && reg['d2026-09-23'] === '+D' && reg['d2026-09-21'] === '+D' && reg['d2026-09-27'] === 'N+' && reg.double === 2);
  const h = buildReport('hours', c, inWeek, week).sections[0].rows[0];
  check('Across midnight: double-shift hours are the period\'s own shifts in doubles', h.doubleHours === 48);
  const ex = buildReport('exceptions', c, inWeek, week).sections.find((x) => x.title === 'Double shifts');
  check('Across midnight: exceptions list doubles starting in the period, with the next day\'s shift', ex.rows.length === 2 && ex.rows[0].shift === 'Night + next Day' && ex.rows[0].date === '2026-09-22' && ex.rows[1].hours === 24);
  const totals = buildReport('daily-totals', c, inWeek, week).sections[0].rows;
  check('Across midnight: daily headcount counts it on the start date', totals.find((x) => x.date === '2026-09-22').double === 1 && totals.find((x) => x.date === '2026-09-23').double === 0);
  const nightOnly = buildReport('summary', c, [tue, sun], week).sections[0].rows[0];
  check('Across midnight: still found with a Night-only filter', nightOnly.double === 2);
  const chain = [worked('2026-09-24', DAY, 9), worked('2026-09-24', NIGHT, 15), worked('2026-09-25', DAY, 9)];
  const ch = buildReport('exceptions', ctx, chain, week).sections.find((x) => x.title === 'Double shifts');
  check('Across midnight: Day + Night + next Day is one double shift', ch.rows.length === 1 && ch.rows[0].shift === 'Day + Night + next Day' && ch.rows[0].hours === 33);
  const gap = buildReport('summary', ctx, [worked('2026-09-24', NIGHT, 15), worked('2026-09-26', DAY, 9)], week).sections[0].rows[0];
  check('Across midnight: a Night and a Day two days later is not a double', gap.double === 0);
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
    check('CSV: TOTAL row and readable status/times', csv.includes('TOTAL,') && csv.includes('38.28'));
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
