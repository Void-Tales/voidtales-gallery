// The fileserver's directory listing is the source of truth for photos and markdown.
// Shared by get-cache-key.cjs and the two copy scripts, so a broken listing (502, a
// login page with 200) fails the build everywhere instead of looking like "no files".
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

// Plain file names only: no paths, no "../", no absolute URLs out of the listing.
const SAFE_NAME = /^[\w.-]+$/;

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

async function fetchListing(url, pattern) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const files = new Set();
  $('a').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    if (SAFE_NAME.test(href) && pattern.test(href)) files.add(href);
  });
  return [...files].sort();
}

// Written next to the target as .part and renamed at the end: an aborted download
// leaves nothing that the next run would skip as "already there".
async function download(url, dest) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (res.headers.get('content-type')?.startsWith('text/html')) throw new Error('got an HTML page');
  const part = `${dest}.part`;
  try {
    fs.writeFileSync(part, Buffer.from(await res.arrayBuffer()));
    fs.renameSync(part, dest);
  } catch (err) {
    fs.rmSync(part, { force: true });
    throw err;
  }
}

/**
 * Mirrors the listing into destDir: downloads what is missing, deletes what is gone
 * remotely (except `keep`). URLs are tried in order. No URL configured = local dev,
 * skipped; configured but unreachable, empty while files are here, or a failed
 * download = exit 1, so a stale or emptied gallery never deploys green.
 */
async function syncDir({ label, destDir, urls, pattern, keep = [] }) {
  const sources = urls.filter(Boolean).map((u) => u.replace(/'/g, ''));
  if (sources.length === 0) return console.log(`No ${label} source configured, skipping.`);

  let files = null;
  let base = null;
  for (const url of sources) {
    try {
      files = await fetchListing(url, pattern);
      base = url;
      break;
    } catch (err) {
      console.warn(`${label} listing failed: ${err.message}`);
    }
  }
  if (!files) fail(`No reachable ${label} source - aborting instead of deploying a stale gallery.`);

  fs.mkdirSync(destDir, { recursive: true });
  const removable = fs
    .readdirSync(destDir)
    .filter((f) => pattern.test(f) && !files.includes(f) && !keep.includes(f) && fs.statSync(path.join(destDir, f)).isFile());
  if (files.length === 0 && removable.length > 0)
    fail(`${label} listing is empty but ${removable.length} files are here - not deleting anything.`);

  let failed = 0;
  for (const file of files) {
    const dest = path.join(destDir, file);
    if (fs.existsSync(dest)) continue;
    try {
      await download(`${base}${file}`, dest);
      console.log(`Downloaded ${file}`);
    } catch (err) {
      failed++;
      console.error(`Failed to download ${file}: ${err.message}`);
    }
  }
  for (const f of removable) {
    fs.unlinkSync(path.join(destDir, f));
    console.log(`Deleted ${f} (no longer on remote)`);
  }
  if (failed) fail(`${failed} ${label} download(s) failed.`);
  fs.writeFileSync(path.join(destDir, '.downloads_synced'), 'Downloads synced');
  console.log(`${label}: ${files.length} files in sync.`);
}

module.exports = { fail, fetchListing, syncDir };
