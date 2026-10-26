// Header and footer links. A copy of the portal's lists (voidtales-portal
// src/config/navigation.js) with absolute URLs: to the visitor portal and
// gallery are one site, so both must show the same header and footer.
import { siteConfig } from './site.js';

const PORTAL = siteConfig.network.url;

export const navigationLinks = [
  { label: 'Home', href: `${PORTAL}/` },
  { label: 'Wiki', href: `${PORTAL}/wiki` },
  { label: 'Items', href: `${PORTAL}/items` },
  // This site: always the highlighted entry in the header.
  { label: 'Gallery', href: '/', current: true },
  { label: 'News', href: `${PORTAL}/news` },
  { label: 'Devlog', href: `${PORTAL}/devlog` },
  // ponytail: the raw invite, not discord.voidtales.win — that vanity host 404s.
  { label: 'Discord', href: 'https://discord.gg/QEMQsFect6' },
  { label: 'World Map', href: 'https://dynmap.voidtales.win' },
];

export const searchUrl = `${PORTAL}/search`;
export const joinUrl = `${PORTAL}/#join`;

// In nav order, whatever order the labels come in.
const pick = (...labels) => navigationLinks.filter((n) => labels.includes(n.label));

export const footerColumns = [
  { title: 'Explore', links: pick('Home', 'Wiki', 'Items', 'Gallery', 'World Map') },
  {
    title: 'Community',
    links: [
      ...pick('News', 'Devlog', 'Discord'),
      { label: 'Modrinth', href: 'https://modrinth.com/modpack/void-tales' },
    ],
  },
  {
    title: 'Legal',
    links: [
      { label: 'Impressum', href: `${PORTAL}/impressum` },
      { label: 'Datenschutz', href: `${PORTAL}/datenschutz` },
    ],
  },
];

// Portal and gallery share a tab; Discord, the map and Modrinth open a new one.
export const isExternal = (href) =>
  !href.startsWith('/') && !/^https:\/\/(portal|gallery)\.voidtales\.win/.test(href);
