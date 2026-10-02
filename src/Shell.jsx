import { useCallback, useEffect, useRef, useState } from 'react';
import AttendanceDashboard from './AttendanceDashboard';
import ApprovalsPage from './ApprovalsPage';
import SchedulesPage from './SchedulesPage';
import ShiftRulesPage from './ShiftRulesPage';
import UsersPage from './UsersPage';
import ReportsPage from './ReportsPage';
import MyAttendancePage from './MyAttendancePage';
import AuditLogsPage from './AuditLogsPage';
import LivePage from './LivePage';
import SystemStatusPage from './SystemStatusPage';
import OverviewPage from './OverviewPage';
import NotificationsBell from './NotificationsBell';
import { ROLE_LABEL, isReadOnly } from './api';
import Icon from './icons';
import ErrorBoundary from './ErrorBoundary';
import useCardTables from './useCardTables';
import { useInstallPrompt, useOnline } from './pwa';

const ALL = ['sysadmin', 'hr', 'admin_assistant', 'finance', 'supervisor', 'auditor', 'director'];

// What each role sees in the navigation. The API enforces the same rules —
// this only hides what someone can't use. The Auditor sees every page but
// changes nothing (the pages hide their editing controls for read-only
// roles, and the API refuses any change from them).
const NAV = [
  // The month at a glance — the Director's home page.
  { page: 'overview', label: 'Overview', icon: 'reports', section: 'Workspace', roles: ['director', 'hr', 'sysadmin', 'auditor'] },
  { page: 'attendance', label: 'Attendance', icon: 'attendance', section: 'Workspace', roles: ALL },
  { page: 'live', label: 'Live', icon: 'live', section: 'Workspace', roles: ['supervisor', 'sysadmin', 'hr', 'admin_assistant', 'auditor', 'director', 'finance'] },
  // Only for accounts linked to a worker record (never the Director role).
  { page: 'mine', label: 'My attendance', short: 'My shifts', icon: 'me', section: 'Workspace', roles: ALL, needsWorker: true },
  { page: 'approvals', label: 'Approvals', icon: 'approvals', section: 'Workspace', roles: ['sysadmin', 'hr', 'admin_assistant', 'supervisor', 'auditor', 'director'] },
  { page: 'reports', label: 'Reports', icon: 'reports', section: 'Workspace', roles: ALL },
  { page: 'schedules', label: 'Schedules', icon: 'schedules', section: 'Setup', roles: ['sysadmin', 'hr', 'admin_assistant', 'supervisor', 'auditor'] },
  { page: 'rules', label: 'Shift rules', icon: 'rules', section: 'Setup', roles: ALL },
  { page: 'users', label: 'Users', icon: 'users', section: 'Setup', roles: ['sysadmin', 'hr', 'auditor'] },
  { page: 'audit', label: 'Audit logs', icon: 'audit', section: 'Setup', roles: ['sysadmin', 'auditor'] },
  { page: 'status', label: 'System status', short: 'Status', icon: 'status', section: 'Setup', roles: ['sysadmin', 'auditor'] }
];

// On phones the first few pages sit in a bottom tab bar, like a native app;
// the rest, the account and sign-out live in the More sheet.
const TAB_BAR_PAGES = 4;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// e.g. "Tuesday, 29 September 2026" in Kampala.
function todayLabel() {
  const d = new Date(Date.now() + 3 * 3600 * 1000);
  return `${WEEKDAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// Page and tab live in the URL (?page=approvals&tab=review) so links in
// notification emails open the right place.
function readLocation() {
  const params = new URLSearchParams(window.location.search);
  return { page: params.get('page') || null, tab: params.get('tab') || null };
}

export default function Shell({ token, user, api, onLogout }) {
  const nav = NAV.filter((n) => n.roles.includes(user.role) && (!n.needsWorker || user.worker));
  const [location, setLocation] = useState(readLocation);
  const [pendingApprovals, setPendingApprovals] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false); // the More sheet on phones
  // Directors land on the month overview; everyone else on Attendance.
  const homePage = user.role === 'director' ? 'overview' : 'attendance';
  const page = nav.some((n) => n.page === location.page) ? location.page : homePage;
  const mainRef = useRef(null);
  useCardTables(mainRef);
  const online = useOnline();
  const installer = useInstallPrompt();

  const navigate = useCallback((link) => {
    const url = new URL(link, window.location.origin);
    const before = readLocation().page;
    window.history.pushState(null, '', `${url.pathname}${url.search}`);
    const after = readLocation();
    setLocation(after);
    // A new page starts at the top, as it would in an app.
    if (after.page !== before) window.scrollTo(0, 0);
  }, []);

  // The More sheet closes with Escape and stops the page behind it scrolling.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('keydown', onKey);
    document.body.classList.add('no-scroll');
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('no-scroll');
    };
  }, [menuOpen]);

  useEffect(() => {
    const onPop = () => setLocation(readLocation());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Count of batches waiting on this user, shown on the Approvals tab.
  const canSeeApprovals = nav.some((n) => n.page === 'approvals');
  const refreshApprovalCount = useCallback(() => {
    if (!canSeeApprovals) return;
    api('/api/approvals?status=pending')
      .then(({ units }) => setPendingApprovals(units.filter((u) => u.canApprove).length))
      .catch(() => {});
  }, [api, canSeeApprovals]);

  useEffect(() => {
    refreshApprovalCount();
    const id = setInterval(refreshApprovalCount, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [refreshApprovalCount]);

  const current = nav.find((n) => n.page === page);
  const displayName = user.name || user.email;
  const initials = displayName.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  const sections = [...new Set(nav.map((n) => n.section))];
  const tabPages = nav.slice(0, TAB_BAR_PAGES);
  const morePages = nav.slice(TAB_BAR_PAGES);
  const onMorePage = morePages.some((n) => n.page === page);
  const approvalsBadge = (n) => n.page === 'approvals' && pendingApprovals > 0;

  // Recorded in the audit log before the token is dropped.
  function signOut() {
    setMenuOpen(false);
    api('/api/auth/logout', { method: 'POST' }).catch(() => {}).finally(onLogout);
  }

  function go(link) {
    setMenuOpen(false);
    navigate(link);
  }

  return (
    <div className="shell">
      <aside className="side" aria-label="Main navigation">
        <div className="side__brand">
          <div className="side__logo" aria-hidden="true">UA</div>
          <div>
            <div className="side__name">UCAA-Ark Group</div>
            <div className="side__sub">Casuals Management</div>
          </div>
        </div>
        <nav className="side__nav">
          {sections.map((section) => (
            <div key={section}>
              <div className="side__section">{section}</div>
              {nav.filter((n) => n.section === section).map((n) => (
                <button
                  key={n.page}
                  className="side__link"
                  aria-current={page === n.page ? 'page' : undefined}
                  onClick={() => go(`/?page=${n.page}`)}
                >
                  <Icon name={n.icon} />
                  {n.label}
                  {n.page === 'approvals' && pendingApprovals > 0 && <span className="side__count" aria-label={`${pendingApprovals} waiting`}>{pendingApprovals}</span>}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="side__user">
          <div className="avatar" aria-hidden="true">{initials}</div>
          <div className="side__user-text">
            <div className="side__user-name" title={displayName}>{displayName}</div>
            <div className="side__user-role">{ROLE_LABEL[user.role]}{isReadOnly(user) ? ' · read-only' : ''}{user.crewName ? ` · ${user.crewName}` : ''}</div>
          </div>
          <button className="icon-btn" onClick={signOut} title="Sign out" aria-label="Sign out"><Icon name="logout" /></button>
        </div>
      </aside>

      <div className="app__main">
        <header className="topbar">
          <div className="topbar__logo" aria-hidden="true">UA</div>
          <h1 className="topbar__title">{current?.label}</h1>
          <div className="topbar__crumb">{current?.section} / <strong>{current?.label}</strong></div>
          <div className="topbar__spacer" />
          <div className="topbar__date">{todayLabel()}</div>
          <NotificationsBell api={api} onNavigate={go} />
        </header>

        {!online && (
          <div className="offline-bar" role="status"><Icon name="offline" size={16} /> You&apos;re offline — showing what was already loaded.</div>
        )}

        <main className="app__content" ref={mainRef}>
        <div className="view" key={page}>
        <ErrorBoundary resetKey={page}>
      {page === 'attendance' && <AttendanceDashboard token={token} user={user} onLogout={onLogout} />}
      {page === 'approvals' && <ApprovalsPage api={api} user={user} onChanged={refreshApprovalCount} />}
      {page === 'schedules' && <SchedulesPage api={api} user={user} tab={location.tab} onTab={(t) => navigate(`/?page=schedules&tab=${t}`)} />}
      {page === 'rules' && <ShiftRulesPage api={api} user={user} />}
      {page === 'users' && <UsersPage api={api} user={user} />}
      {page === 'reports' && <ReportsPage api={api} token={token} user={user} />}
      {page === 'mine' && <MyAttendancePage api={api} token={token} user={user} />}
      {page === 'audit' && <AuditLogsPage api={api} token={token} user={user} />}
      {page === 'live' && <LivePage api={api} token={token} user={user} />}
      {page === 'status' && <SystemStatusPage api={api} user={user} />}
      {page === 'overview' && <OverviewPage api={api} user={user} />}
        </ErrorBoundary>
        </div>
        </main>
      </div>

      <nav className="tabbar" aria-label="Main navigation">
        {tabPages.map((n) => (
          <button key={n.page} className="tabbar__item" aria-current={page === n.page ? 'page' : undefined} onClick={() => go(`/?page=${n.page}`)}>
            <span className="tabbar__icon">
              <Icon name={n.icon} size={22} />
              {approvalsBadge(n) && <span className="tabbar__badge" aria-label={`${pendingApprovals} waiting`}>{pendingApprovals > 99 ? '99+' : pendingApprovals}</span>}
            </span>
            <span className="tabbar__label">{n.short || n.label}</span>
          </button>
        ))}
        <button className="tabbar__item" aria-current={onMorePage ? 'page' : undefined} aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}>
          <span className="tabbar__icon"><Icon name="more" size={22} /></span>
          <span className="tabbar__label">More</span>
        </button>
      </nav>

      {menuOpen && (
        <div className="sheet-backdrop" onClick={() => setMenuOpen(false)} role="presentation">
          <div className="sheet" role="dialog" aria-modal="true" aria-label="More" onClick={(e) => e.stopPropagation()}>
            <div className="sheet__handle" aria-hidden="true" />
            <div className="sheet__user">
              <div className="avatar avatar--lg" aria-hidden="true">{initials}</div>
              <div className="side__user-text">
                <div className="sheet__user-name">{displayName}</div>
                <div className="sheet__user-role">{ROLE_LABEL[user.role]}{isReadOnly(user) ? ' · read-only' : ''}{user.crewName ? ` · ${user.crewName}` : ''}</div>
              </div>
            </div>

            {morePages.length > 0 && (
              <div className="sheet__group">
                {morePages.map((n) => (
                  <button key={n.page} className="sheet__row" aria-current={page === n.page ? 'page' : undefined} onClick={() => go(`/?page=${n.page}`)}>
                    <span className="sheet__row-icon"><Icon name={n.icon} size={20} /></span>
                    <span className="sheet__row-label">{n.label}</span>
                    {approvalsBadge(n) && <span className="side__count">{pendingApprovals}</span>}
                    <Icon name="chevron" size={18} />
                  </button>
                ))}
              </div>
            )}

            {(installer.canInstall || installer.showIosHint) && (
              <div className="sheet__group">
                {installer.canInstall ? (
                  <button className="sheet__row" onClick={() => installer.install()}>
                    <span className="sheet__row-icon"><Icon name="install" size={20} /></span>
                    <span className="sheet__row-label">Install app on this phone</span>
                  </button>
                ) : (
                  <div className="sheet__row sheet__row--static">
                    <span className="sheet__row-icon"><Icon name="share" size={20} /></span>
                    <span className="sheet__row-label">To install: tap <strong>Share</strong> in Safari, then <strong>Add to Home Screen</strong></span>
                  </div>
                )}
              </div>
            )}

            <div className="sheet__group">
              <button className="sheet__row sheet__row--danger" onClick={signOut}>
                <span className="sheet__row-icon"><Icon name="logout" size={20} /></span>
                <span className="sheet__row-label">Sign out</span>
              </button>
            </div>
            <div className="sheet__date">{todayLabel()}</div>
          </div>
        </div>
      )}
    </div>
  );
}
