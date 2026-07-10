// Site configuration file: Defines global settings for the VoidTales Gallery site.
// Used across the application for metadata, SEO, and UI elements like hero and footer.

/**
 * Configuration object for the VoidTales Gallery website.
 *
 * @typedef {Object} SiteConfig
 * @property {string} name - Site name, displayed in browser title and meta tags.
 * @property {string} description - Site description for SEO and social media previews.
 * @property {string} url - Base URL of the site, used for canonical links and sitemaps.
 * @property {string} ogImage - Path to the Open Graph image for social media previews.
 * @property {string} author - Name of the site creator or maintainer.
 * @property {string} manifest - Path to the web app manifest file.
 * @property {string} favicon - Path to the site favicon.
 * @property {Object} hero - Configuration for the homepage hero section.
 * @property {string} hero.eyebrow - Small caps label above the headline.
 * @property {string} hero.title - Main headline for the hero section.
 * @property {string} hero.titleAccent - Substring of the title rendered with the accent glow.
 * @property {string} hero.subtitle - Subtitle text for the hero section.
 * @property {string} hero.cta - Call-to-action button text in the hero section.
 * @property {string} hero.ctaLink - URL for the call-to-action button (external link).
 * @property {Object} footer - Configuration for the site footer.
 * @property {string} footer.copyright - Copyright text displayed in the footer.
 * @property {string} defaultSort - Default Sorting Order.
 */
export const siteConfig = {
  // Site name: Displayed in the browser title and meta tags
  name: 'Void Tales Gallery',
  
  // Site description: Used for SEO meta description and social media previews
  description: 'A sleek, high-performance photo gallery built with Astro, TypeScript, and vanilla CSS/JS. Showcase your photos with modern design, automatic sorting, and seamless dark mode.',
  
  // Site URL: Base URL for the site, used for canonical links and sitemaps
  url: 'https://gallery.voidtales.win',
  
  // Open Graph image: Path to image used for social media previews (place in public/images/)
  ogImage: '/images/og-image.webp',
  
  // Site author: Name of the site creator or maintainer
  author: 'inventory69',

  // Paths to manifest and favicon files in the public directory
  manifest: '/manifest.json',
  favicon: '/favicon.ico',
  
  // Hero section configuration: Defines content for the main hero area on the homepage
  hero: {
    eyebrow: 'Community Screenshots',  // Small caps label above the headline
    title: 'Void Tales Gallery',  // Main headline for the hero section
    titleAccent: 'Gallery',  // Part of the title that gets the accent glow
    subtitle: 'The latest images from the world of VoidTales – sorted by date.',  // Subtitle text
    cta: 'To the Portal',  // Call-to-action button text
    ctaLink: 'https://portal.voidtales.win', // 🌐 External link for the button
  },
  
  // Footer configuration: Defines content for the site footer
  footer: {
    copyright: 'VoidTales',  // Copyright text displayed in the footer
  },

  // Default sort order for images: 'date-asc' or 'date-desc'
  defaultSort: 'date-desc',

  // Staff authors: Array of staff member names for attribution or collaboration
  staffAuthors: [
    "shinsnowly",
    ".inventory",
    "hyphonical",
    "razorbl8de",
  ],
};