const P: Record<string, string> = {
  dashboard: 'M3 13h8V3H3v10Zm10 8h8V3h-8v18ZM3 21h8v-6H3v6Z',
  inbox: 'M4 4h16v10h-5l-2 3h-2l-2-3H4V4Z',
  users: 'M16 19c0-2.8-2.7-4-6-4s-6 1.2-6 4M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm8 8c0-2.2-1.3-3.4-3-3.8M16 4.5a3 3 0 0 1 0 6',
  kanban: 'M4 4h4v16H4V4Zm6 0h4v10h-4V4Zm6 0h4v13h-4V4Z',
  flow: 'M6 4h5v4H6V4Zm7 12h5v4h-5v-4ZM4 16h5v4H4v-4ZM8.5 8v4m0 0h7m0 0v4',
  bot: 'M12 3v2m-5 2h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Zm2 5h.01M15 12h.01M9 16h6',
  send: 'M4 12 20 4l-6 16-2.5-6.5L4 12Z',
  plug: 'M9 3v6m6-6v6M7 9h10v3a5 5 0 0 1-10 0V9Zm5 8v4',
  webhook: 'M12 8a3 3 0 1 0-2.6 4.5L7 17m5-9 2.5 4.5A3 3 0 1 1 12 18m-6-1h4m8 0h-4',
  meta: 'M3 16c2-8 5-8 7 0s5 8 7 0M3 12a9 5 0 0 1 18 0',
  card: 'M3 7h18v10H3V7Zm0 4h18M7 15h3',
  gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm8 3-2 .4-.5 1.3 1 1.7-1.4 1.4-1.7-1-1.3.5L14 20h-2l-.4-2-1.3-.5-1.7 1-1.4-1.4 1-1.7-.5-1.3L6 12l.4-2.4-1-1.7L6.8 6.5l1.7 1 1.3-.5L12 4h2l.4 2 1.3.5 1.7-1 1.4 1.4-1 1.7.5 1.3L20 12Z',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm6 12 4 4',
  bell: 'M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6Zm4 10a2 2 0 0 0 4 0',
  sun: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0-5v2m0 16v2M4 12H2m20 0h-2M5.6 5.6 4.2 4.2m15.6 15.6-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z',
  plus: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6 6 18',
  check: 'M5 12l5 5 9-11',
  dots: 'M5 12h.01M12 12h.01M19 12h.01',
  copy: 'M9 9h10v10H9V9Zm-4 6H4V4h11v1',
  phone: 'M6 3h3l2 5-2 1a12 12 0 0 0 5 5l1-2 5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 4 5a2 2 0 0 1 2-2Z',
  mic: 'M12 4a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V7a3 3 0 0 0-3-3Zm-6 8a6 6 0 0 0 12 0M12 18v3',
  paperclip: 'M8 12l6-6a3 3 0 0 1 4 4l-7 7a5 5 0 0 1-7-7l7-7',
  smile: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm-3 8h.01M15 11h.01M8.5 14.5a5 5 0 0 0 7 0',
  filter: 'M4 5h16l-6 7v5l-4 2v-7L4 5Z',
  bolt: 'M13 3 4 14h6l-1 7 9-11h-6l1-7Z',
  tag: 'M3 12 12 3h8v8l-9 9-8-8Zm13-4h.01',
  logout: 'M15 12H4m0 0 4-4m-4 4 4 4m3-11h6v14h-6',
  trend: 'M3 17l6-6 4 4 8-8m0 0h-5m5 0v5',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 0c-3 3-3 15 0 18m0-18c3 3 3 15 0 18M3 12h18',
  play: 'M7 5l12 7-12 7V5Z',
  pause: 'M8 5h3v14H8V5Zm5 0h3v14h-3V5Z',
  chevron: 'M6 9l6 6 6-6',
};

export function Icon({ name, size = 18, stroke = 1.9 }: { name: string; size?: number; stroke?: number }) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={P[name]} />
    </svg>
  );
}
