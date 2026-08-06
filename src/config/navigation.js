// Header navigation. Mirrors the portal's list (voidtales-portal
// src/config/navigation.js) minus "Gallery" — that's this site. News and Devlog
// live on the portal now and replaced the old Blog/Forum links.
export const navigationLinks = [
  { label: 'Portal', href: 'https://portal.voidtales.win' },
  { label: 'Wiki', href: 'https://wiki.voidtales.win' },
  { label: 'News', href: 'https://portal.voidtales.win/news' },
  { label: 'Devlog', href: 'https://portal.voidtales.win/devlog' },
  // ponytail: the raw invite, not discord.voidtales.win — that vanity host 404s.
  { label: 'Discord', href: 'https://discord.gg/QEMQsFect6' },
  { label: 'World Map', href: 'https://dynmap.voidtales.win' },
];
