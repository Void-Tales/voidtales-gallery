const config = require('../src/config/externaldownload.cjs');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const destDir = './src/content/photos/';
const defaultDir = path.join(destDir, 'default');

const internalUrl = config.mdSourceUrlInternal ? config.mdSourceUrlInternal.replace(/'/g, '') : null;
const externalUrl = config.mdSourceUrlExternal ? config.mdSourceUrlExternal.replace(/'/g, '') : null;

/**
 * Fetches the HTML directory listing from the given URL.
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
    // Ignore errors, fallback will be handled
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
    if (html) usedUrl = internalUrl;
  }

  // Fallback to external URL if internal failed
  if (!html && externalUrl) {
    html = await fetchDirectoryListing(externalUrl);
    if (html) usedUrl = externalUrl;
  }

  // Abort if no reachable source
  if (!html) {
    console.warn('No reachable markdown source found. Skipping download.');
    process.exit(0);
  }

  // Extract .md files from directory listing
  const $ = cheerio.load(html);
  const files = [];
  $('a').each((_, el) => {
    const href = $(el).attr('href');
    if (href && href.endsWith('.md')) {
      files.push(href);
    }
  });

  // Remove duplicate file names
  const uniqueFiles = [...new Set(files)];

  // Download missing files only
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

  // List all local .md files in destDir (exclude marker file and default subdir)
  const localFiles = fs.readdirSync(destDir)
    .filter(f =>
      f.endsWith('.md') &&
      f !== '.downloads_synced' &&
      (!fs.statSync(path.join(destDir, f)).isDirectory())
    );

  // List all files in default subdir (never delete)
  let defaultFiles = [];
  if (fs.existsSync(defaultDir)) {
    defaultFiles = fs.readdirSync(defaultDir)
      .filter(f => f.endsWith('.md'));
  }

  // Exclude default files from deletion
  const excludeFiles = [
    ...defaultFiles.map(f => `default/${f}`),
    "31736163-default.md",
    "44215106-default.md",
    "64517921-default.md",
    "72382172-default.md",
    "96103542-default.md",
    "99323854-default.md",
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

  // Write marker file if all files are present
  const allPresent = uniqueFiles.every(file => fs.existsSync(path.join(destDir, file)));
  if (allPresent) {
    fs.writeFileSync(marker, 'Downloads synced');
    console.log('All markdown files synced. Marker file written.');
  } else {
    if (!downloaded) {
      console.log('No new markdown files downloaded. Some files may be missing.');
    }
  }
})();