import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defineConfig, fontProviders } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import preact from '@astrojs/preact';
// Import site config for global settings
import { siteConfig } from './src/config/site.js';

// PhotoGrid.astro inlines this file (is:inline, it must run before first paint), and
// Astro doesn't hash is:inline scripts. Without the hash the browser blocked it in
// production until 10/2026: phones got three columns, and every lazy image loaded at once.
// Astro.csp.insertScriptHash() from the component is too late, the <meta> is already out.
const gridScriptHash = createHash('sha256')
  .update(readFileSync(new URL('./src/scripts/static-grid-columns.js', import.meta.url)))
  .digest('base64');

export default defineConfig({
  // Base URL for the site, used for sitemaps and canonical links
  site: siteConfig.url,

  // Captions, comments and names come from Discord, so the page gets the same strict
  // CSP as the portal: Astro hashes every inline script and style at build time.
  // `frame-ancestors` is absent on purpose (ignored in a <meta> CSP); the edge sends
  // X-Frame-Options.
  security: {
    csp: {
      directives: [
        "default-src 'self'",
        // cdn.discordapp.com: comment avatars (SocialPanel)
        "img-src 'self' data: https://cdn.discordapp.com",
        // stats.hzwd.xyz = Umami: script-src loads it, connect-src lets the beacon out.
        // gallery-api is same origin (/api/).
        "connect-src 'self' https://stats.hzwd.xyz",
        "base-uri 'self'",
        "form-action 'self'",
        "object-src 'none'",
      ],
      scriptDirective: {
        resources: ["'self'", 'https://stats.hzwd.xyz'],
        hashes: [`sha256-${gridScriptHash}`],
      },
      // The static grid sets style="aspect-ratio: …" per card; attribute styles can't be
      // hashed and can't run anything, so 'unsafe-inline' stays scoped to style-src-attr.
      // Expected violation: GLightbox injects a <style> with its scrollbar compensation
      // when it opens. Blocked on purpose, lightbox.css zeroes that margin anyway.
      styleDirective: { resources: ["'self'", { resource: "'unsafe-inline'", kind: 'attribute' }] },
    },
  },

  // Integrations for Astro project
  integrations: [
    preact(),   // Enables Preact for client-side interactivity
    sitemap()   // Generates sitemap.xml for SEO
  ],

  // Self-hosted, build-time fetched Google Fonts (no runtime fonts.googleapis.com request)
  fonts: [
    {
      provider: fontProviders.google(),
      name: 'Unbounded',
      cssVariable: '--font-unbounded',
      weights: [400, 600, 800],
    },
    {
      provider: fontProviders.google(),
      name: 'Instrument Sans',
      cssVariable: '--font-instrument-sans',
      weights: [400, 500, 600],
    },
  ],

  // `pnpm run dev` only: likes/comments come from gallery-api (api/), run it on :3000.
  vite: {
    server: { proxy: { '/api': 'http://localhost:3000' } },
  },
});