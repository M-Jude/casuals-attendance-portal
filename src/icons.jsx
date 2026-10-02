// Small line icons (24×24, stroke = currentColor) for the navigation and
// top bar. Inline so the portal has no icon-font or CDN dependency.

const PATHS = {
  attendance: <><rect x="3" y="4" width="18" height="17" rx="2.5" /><path d="M8 2.5v3M16 2.5v3M3 9.5h18M8.5 15l2.3 2.3L15.5 13" /></>,
  reports: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 17v-3M12 17v-6M15 17v-4" /></>,
  approvals: <><circle cx="12" cy="12" r="9" /><path d="m8.5 12.2 2.4 2.4 4.6-4.9" /></>,
  schedules: <><path d="M4 7h11M4 12h7M4 17h9" /><circle cx="17.5" cy="15.5" r="4" /><path d="M17.5 13.6v2l1.3 1.2" /></>,
  rules: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.2 2" /></>,
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.6-3.6 3.3-5.5 6.5-5.5s5.9 1.9 6.5 5.5" /><path d="M16 4.8a3.3 3.3 0 0 1 0 6.4M18.3 14.8c1.8.7 3 2.4 3.3 5.2" /></>,
  live: <><circle cx="12" cy="12" r="2.4" /><path d="M8.2 15.8a5.4 5.4 0 0 1 0-7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6M5.1 18.9a9.8 9.8 0 0 1 0-13.8M18.9 5.1a9.8 9.8 0 0 1 0 13.8" /></>,
  me: <><circle cx="12" cy="8" r="4" /><path d="M4.5 21c.8-4 3.8-6.5 7.5-6.5s6.7 2.5 7.5 6.5" /></>,
  bell: <><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z" /><path d="M10 20.5a2.2 2.2 0 0 0 4 0" /></>,
  menu: <path d="M4 6.5h16M4 12h16M4 17.5h16" />,
  logout: <><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" /><path d="M10 16.5 5.5 12 10 7.5M5.5 12H15" /></>,
  more: <><rect x="3.5" y="3.5" width="7" height="7" rx="2" /><rect x="13.5" y="3.5" width="7" height="7" rx="2" /><rect x="3.5" y="13.5" width="7" height="7" rx="2" /><rect x="13.5" y="13.5" width="7" height="7" rx="2" /></>,
  chevron: <path d="m9.5 6 6 6-6 6" />,
  audit: <><path d="M12 2.8 4.5 5.6v5.8c0 4.6 3.1 8.3 7.5 9.8 4.4-1.5 7.5-5.2 7.5-9.8V5.6z" /><path d="M9 11.5h6M9 15h4" /></>,
  status: <path d="M3 12h4l2.5-6.5 4.5 13 2.5-6.5H21" />,
  install: <><path d="M12 3.5v11M7.5 10.5 12 15l4.5-4.5" /><path d="M4.5 16.5v2a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2" /></>,
  share: <><path d="M12 15V3.5M8 7.5l4-4 4 4" /><path d="M8 11H6.5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2H16" /></>,
  offline: <><path d="M3 3l18 18" /><path d="M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5.2-2.8M19 13a10 10 0 0 0-2.5-1.9M2 9.5a15 15 0 0 1 4.3-2.8M22 9.5A15 15 0 0 0 11 5.1" /><circle cx="12" cy="19.5" r="0.6" /></>
};

export default function Icon({ name, size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}
