const config = require('../src/config/externaldownload.cjs');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const destDir = './public/images/original/';
const defaultDir = path.join(destDir, 'default');

const internalUrl = config.originalSourceUrlInternal ? config.originalSourceUrlInternal.replace(/'/g, '') : null;
const externalUrl = config.originalSourceUrlExternal ? config.originalSourceUrlExternal.replace(/'/g, '') : null;

/**
 * Fetches the HTML directory listing from a given URL.
 * @param {string} url - The URL to fetch.
 * @returns {Promise<string|null>} - The HTML content or null if failed.
 */
async function fetchDirectoryListing(url) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    return await res.text();
  } catch (err) {
    return null;
  }
}

(async () => {
  const marker = path.join(destDir, '.downloads_synced');

  let html = null;
  let usedUrl = null;

  // Try internal URL first
  if (internalUrl) {
    html = await fetchDirectoryListing(internalUrl);
    if (html) {
      usedUrl = internalUrl;
    }
  }

  // Fallback to external URL
  if (!html && externalUrl) {
    html = await fetchDirectoryListing(externalUrl);
    if (html) {
      usedUrl = externalUrl;
    }
  }

  // Keine erreichbare Quelle = Abbruch. Weiterbauen hiesse eine Galerie ohne
  // die neuen Bilder zu deployen, und zwar mit gruenem Haekchen.
  if (!html) {
    console.error('No reachable image source found - aborting instead of deploying a stale gallery.');
    process.exit(1);
  }

  // Extract image files from HTML
  const $ = cheerio.load(html);
  const files = [];
  $('a').each((_, el) => {
    const href = $(el).attr('href');
    if (href && /\.(png|jpe?g|webp|bmp)$/i.test(href)) {
      files.push(href);
    }
  });

  // Remove duplicate file names
  const uniqueFiles = [...new Set(files)];

  // Download only missing files
  let downloaded = false;
  uniqueFiles.forEach(file => {
    const destPath = path.join(destDir, file);
    if (fs.existsSync(destPath)) {
      console.log(`Skipping ${file} (already exists)`);
    } else {
      const url = `${usedUrl}${file}`;
      console.log(`Downloading ${file}`);
      try {
        execSync(`wget -q -O "${destPath}" "${url}"`, { timeout: 3000 });
        downloaded = true;
      } catch (e) {
        console.warn(`Failed to download ${file}, skipping.`);
      }
    }
  });

  // List all local image files in destDir (exclude marker file and default subdir)
  const localFiles = fs.readdirSync(destDir)
    .filter(f =>
      /\.(png|jpe?g|webp|bmp)$/i.test(f) &&
      f !== '.downloads_synced' &&
      (!fs.statSync(path.join(destDir, f)).isDirectory())
    );

  // List all files in default subdir (never delete)
  let defaultFiles = [];
  if (fs.existsSync(defaultDir)) {
    defaultFiles = fs.readdirSync(defaultDir)
      .filter(f => /\.(png|jpe?g|webp|bmp)$/i.test(f));
  }

  // Exclude default files from deletion
  const excludeFiles = [
    ...defaultFiles.map(f => `default/${f}`),
    "31736163-default.webp",
    "44215106-default.webp",
    "64517921-default.webp",
    "72382172-default.webp",
    "96103542-default.webp",
    "99323854-default.webp",
  ];

  // Find files that are local but not on remote, but keep excluded files
  const filesToDelete = localFiles.filter(f =>
    !uniqueFiles.includes(f) && !excludeFiles.includes(f)
  );

  // Delete those files
  filesToDelete.forEach(f => {
    const filePath = path.join(destDir, f);
    try {
      fs.unlinkSync(filePath);
      console.log(`Deleted ${f} (no longer on remote)`);
    } catch (e) {
      console.warn(`Failed to delete ${f}:`, e.message);
    }
  });

  // Write marker if all files are present
  const allPresent = uniqueFiles.every(file => fs.existsSync(path.join(destDir, file)));
  if (allPresent) {
    fs.writeFileSync(marker, 'Downloads synced');
    console.log('All original images synced. Marker file written.');
  } else {
    if (!downloaded) {
      console.log('No new images downloaded. Some files may be missing.');
    }
  }
})();