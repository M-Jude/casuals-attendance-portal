import { useCallback, useEffect, useState } from 'react';
import AttendanceDashboard from './AttendanceDashboard';
import ApprovalsPage from './ApprovalsPage';
import SchedulesPage from './SchedulesPage';
import ShiftRulesPage from './ShiftRulesPage';
import UsersPage from './UsersPage';
import NotificationsBell from './NotificationsBell';
import { ROLE_LABEL } from './api';

const ALL = ['sysadmin', 'hr', 'admin_assistant', 'finance', 'supervisor'];

// What each role sees in the navigation. The API enforces the same rules —
// this only hides what someone can't use.
const NAV = [
  { page: 'attendance', label: 'Attendance', roles: ALL },
  { page: 'approvals', label: 'Approvals', roles: ['sysadmin', 'hr', 'admin_assistant', 'supervisor'] },
  { page: 'schedules', label: 'Schedules', roles: ['sysadmin', 'hr', 'admin_assistant', 'supervisor'] },
  { page: 'rules', label: 'Shift rules', roles: ALL },
  { page: 'users', label: 'Users', roles: ['sysadmin', 'hr'] }
];

// Page and tab live in the URL (?page=approvals&tab=review) so links in
// notification emails open the right place.
function readLocation() {
  const params = new URLSearchParams(window.location.search);
  return { page: params.get('page') || 'attendance', tab: params.get('tab') || null };
}

export default function Shell({ token, user, api, onLogout }) {
  const nav = NAV.filter((n) => n.roles.includes(user.role));
  const [location, setLocation] = useState(readLocation);
  const [pendingApprovals, setPendingApprovals] = useState(0);
  const page = nav.some((n) => n.page === location.page) ? location.page : 'attendance';

  const navigate = useCallback((link) => {
    const url = new URL(link, window.location.origin);
    window.history.pushState(null, '', `${url.pathname}${url.search}`);
    setLocation(readLocation());
  }, []);

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

  return (
    <div className="shell">
      <header className="shell__bar">
        <h1 className="shell__title">UCAA-ARK GROUP CASUALS MANAGEMENT SYSTEM</h1>
        <nav className="shell__nav">
          {nav.map((n) => (
            <button key={n.page} aria-current={page === n.page ? 'page' : undefined} onClick={() => navigate(`/?page=${n.page}`)}>
              {n.label}
              {n.page === 'approvals' && pendingApprovals > 0 && <span className="shell__nav-count">{pendingApprovals}</span>}
            </button>
          ))}
        </nav>
        <div className="shell__user">
          <NotificationsBell api={api} onNavigate={navigate} />
          <span>
            <strong>{user.name || user.email}</strong> · {ROLE_LABEL[user.role]}
            {user.crewName ? ` · ${user.crewName}` : ''}
          </span>
          <button className="shell__signout" onClick={onLogout}>Sign out</button>
        </div>
      </header>

      {page === 'attendance' && <AttendanceDashboard token={token} user={user} onLogout={onLogout} />}
      {page === 'approvals' && <ApprovalsPage api={api} user={user} onChanged={refreshApprovalCount} />}
      {page === 'schedules' && <SchedulesPage api={api} user={user} tab={location.tab} onTab={(t) => navigate(`/?page=schedules&tab=${t}`)} />}
      {page === 'rules' && <ShiftRulesPage api={api} user={user} />}
      {page === 'users' && <UsersPage api={api} user={user} />}
    </div>
  );
}
