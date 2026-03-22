// type: 'super' = verified checkmark (ACTAVIS), 'admin' = shield badge
export default function AdminBadge({ type, size = 14 }) {
  if (type === 'super') {
    return (
      <span className="admin-badge admin-badge--super" title="Верифицирован" style={{ display: 'inline-flex', alignItems: 'center' }}>
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/>
          <polyline points="22 4 12 14.01 9 11.01"/>
        </svg>
      </span>
    );
  }
  if (type === 'admin') {
    return (
      <span className="admin-badge admin-badge--admin" title="Администратор" style={{ display: 'inline-flex', alignItems: 'center' }}>
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/>
        </svg>
      </span>
    );
  }
  return null;
}

export function getBadgeType(nick, adminInfo) {
  if (!nick || !adminInfo) return null;
  const key = nick.toLowerCase();
  if (key === adminInfo.superAdmin?.toLowerCase()) return 'super';
  if (adminInfo.admins?.map(n => n.toLowerCase()).includes(key)) return 'admin';
  return null;
}
