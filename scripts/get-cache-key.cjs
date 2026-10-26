// Cache key for the download cache in deploy.yml: a hash of both remote listings.
const config = require('../src/config/externaldownload.cjs');
const crypto = require('crypto');
const fs = require('fs');
const { fail, fetchListing } = require('./lib/listing.cjs');

async function names(url, pattern, label) {
  if (!url) fail(`No external ${label} URL configured.`);
  // No silent fallback key: it would be constant, restore the old cache and deploy
  // an incomplete gallery green. An empty listing is an error page, not "no photos".
  const files = await fetchListing(url.replace(/'/g, ''), pattern).catch((err) => fail(`${label} listing failed: ${err.message}`));
  if (files.length === 0) fail(`${label} listing is empty - error page?`);
  return files.join('|');
}

(async () => {
  const md = await names(config.mdSourceUrlExternal, /\.md$/, 'markdown');
  const originals = await names(config.originalSourceUrlExternal, /\.(png|jpe?g|webp|bmp)$/i, 'original image');
  const hash = crypto.createHash('sha256').update(`${md}|${originals}`).digest('hex');
  console.log(`Generated cache key: ${hash}`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `cache-key=${hash}\n`);
})();
