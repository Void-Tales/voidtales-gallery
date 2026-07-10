# Self-Hosting Guide

VoidTales Gallery is a static site generator. There is **no** upload UI, admin panel, database, or backend. You add images and metadata as files, generate thumbnails, and build.

## Prerequisites

- Node.js ≥ 22.12
- pnpm (enforced via `only-allow` - npm/yarn will refuse)

## Setup

```bash
pnpm install
pnpm run dev        # http://localhost:4321
```

The dev server regenerates `images.json` on start and watches `public/images/original/` and `src/content/photos/` for changes.

## Adding Images

**1. Original image** → `public/images/original/photo.webp`

**2. Metadata file** → `src/content/photos/{id}.md` with this frontmatter:

```markdown
---
id: "unique-image-id"
title: "My Photo"
slug: "my-photo"
author: "username"
date: "2023-10-01T12:34:56"
fullsizePath: "/images/original/photo.webp"
thumbPath: "/images/thumbs/photo-400.webp"
width: 1600
height: 900
caption: "A beautiful moment"
---
```

- `id` must be unique - it drives direct links and lightbox sharing.
- `date` (ISO format) drives the default sort.
- `author` matching an entry in `staffAuthors` (see `src/config/site.js`) gets a staff badge.

**3. Thumbnails:**

```bash
pnpm run gen:thumbs
```

Generates 200/400/800px WebP thumbnails into `public/images/thumbs/`. The script writes a `.thumbs_generated` marker and skips on subsequent runs - delete the marker to force regeneration.

**Local test data:** `pnpm run gen:testdata` creates 44 dummy images + metadata; `pnpm run cleanup:testdata` removes them.

## Configuration

Everything user-facing is config-driven - edit these instead of components:

| File | Controls |
|---|---|
| `src/config/site.js` | Site name, description, SEO/OG meta, hero (eyebrow, title, accent, CTA), footer, `defaultSort`, `staffAuthors` |
| `src/config/navigation.js` | Header nav links |
| `src/config/externaldownload.cjs` | External content downloads (below) |

Types for `site.js` live in `src/config/site.d.ts` - keep them in sync.

Fonts (Unbounded + Instrument Sans) are self-hosted via the Astro Fonts API (`fonts:` block in `astro.config.mjs`) - no runtime Google Fonts requests.

## External Downloads (optional)

The build can fetch metadata and images from remote servers instead of the repo. Set env vars (`.env` or CI secrets):

```
EXT_DL_URL_MARKDOWN=http://internal-server/markdown/
EXT_DL_URL_ORIGINAL=http://internal-server/original/
EXT_DL_URL_MARKDOWN_EXTERNAL=http://fallback-server/markdown/
EXT_DL_URL_ORIGINAL_EXTERNAL=http://fallback-server/original/
```

Enable/disable in `src/config/externaldownload.cjs`. The scripts (`pnpm run copy:md-files` / `copy:original-images`) try internal URLs first, fall back to external, and skip silently if nothing is configured. A `.downloads_synced` marker in the target folders prevents re-downloading.

## How It Works at Runtime

The site is a single page (`src/pages/index.astro`). The Preact grid (`PhotoGridClient.tsx`, `client:only`) fetches `public/images.json` at runtime with cache-busting - so new images appear without rebuilding the HTML, as long as `images.json` and the image files are updated on the server. Sorting, masonry column distribution, infinite scroll, and the GLightbox lightbox all run client-side.

## Automation Ideas

Nothing below ships with this repo - build what fits your infrastructure:

- **GitHub Action**: trigger on pushes to `public/images/original/`, run `gen:thumbs` + `gen:imagejson`, commit and deploy.
- **Upload script**: extract EXIF via Sharp, write the frontmatter file, commit programmatically.
- **Headless CMS**: fetch content during the build via the external-downloads feature.
- **Chat integration**: the production instance uses an n8n workflow that takes Discord posts, uploads originals + metadata to a fileserver via SFTP, and triggers the build.
