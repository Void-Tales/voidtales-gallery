const config = require('../src/config/externaldownload.cjs');
const cheerio = require('cheerio');
const crypto = require('crypto');
const fs = require('fs');

const externalUrlmd = config.mdSourceUrlExternal ? config.mdSourceUrlExternal.replace(/'/g, '') : null;
const externalUrlog = config.originalSourceUrlExternal ? config.originalSourceUrlExternal.replace(/'/g, '') : null;

async function getFileNames(url, regex) {
  try {
    console.log(`Debug: Attempting to fetch from URL: '${url}'`);

    if (!url) {
      throw new Error('URL is undefined or empty.');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    const html = await res.text();
    const $ = cheerio.load(html);
    const files = [];
    $('a').each((_, el) => {
      const href = $(el).attr('href');
      if (href && regex.test(href)) {
        files.push(href);
      }
    });
    return files.sort().join('|');
  } catch (error) {
    console.error(`Error fetching files from ${url}:`, error.message);
    return '';
  }
}

(async () => {
  console.log(`Debug: Using externalUrlmd: '${externalUrlmd}'`);
  console.log(`Debug: Using externalUrlog: '${externalUrlog}'`);

  const mdFiles = await getFileNames(externalUrlmd, /\.md$/);
  const originalFiles = await getFileNames(externalUrlog, /\.(png|jpe?g|webp|bmp)$/i);

  const combinedString = mdFiles + '|' + originalFiles;
  const hash = crypto.createHash('sha256').update(combinedString).digest('hex');

  console.log(`Generated cache key: ${hash}`);

  fs.writeFileSync(process.env.GITHUB_OUTPUT, `cache-key=${hash}`);
})();