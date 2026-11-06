// The picture at the top of the gallery: the newest shot somebody liked or commented
// on, else simply the newest. Spoilers and the bundled defaults never qualify. Written
// at build time as a sharper copy than the 1600w thumbnail, plus a small one for phones.
//
// A dead gallery-api must not stop a build: without counts the newest shot wins.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const SITE = 'https://gallery.voidtales.win';
const OUT_DIR = path.resolve('public/images');
const OUT_FILE = path.resolve('src/generated/hero.json');
const MIN_WIDTH = 1600;

export function pickHero(images, stats = {}) {
  const pool = images
    .filter((i) => !i.isDefault && !/^SPOILER_/i.test(i.title ?? '') && (i.width ?? 0) >= MIN_WIDTH && i.date)
    .sort((a, b) => b.date.localeCompare(a.date));
  const liked = pool.find((i) => (stats[i.id]?.likes ?? 0) + (stats[i.id]?.comments ?? 0) > 0);
  return liked ?? pool[0] ?? null;
}

async function main() {
  const images = JSON.parse(fs.readFileSync(path.resolve('public/images.json'), 'utf8'));
  const stats = await fetch(`${SITE}/api/stats`, { signal: AbortSignal.timeout(8000) })
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}));
  const hero = pickHero(images, stats);
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  if (!hero) {
    fs.writeFileSync(OUT_FILE, 'null\n');
    console.log('hero: no candidate');
    return;
  }
  const local = path.resolve(`public${hero.imageUrl}`);
  const original = fs.existsSync(local)
    ? fs.readFileSync(local)
    : Buffer.from(await (await fetch(`${SITE}${hero.imageUrl}`)).arrayBuffer());
  const big = `hero-${hero.id}.webp`;
  const small = `hero-${hero.id}-900.webp`;
  const large = () => sharp(original).resize({ width: 2400, withoutEnlargement: true });
  const narrow = () => sharp(original).resize({ width: 900 });
  await large().webp({ quality: 82 }).toFile(path.join(OUT_DIR, big));
  await narrow().webp({ quality: 80 }).toFile(path.join(OUT_DIR, small));
  // AVIF at this quality beat these WebPs on SSIM against the original in every test
  // shot (portal heads, 06.11.2026) at a quarter to a half fewer bytes.
  await large().avif({ quality: 60, effort: 6 }).toFile(path.join(OUT_DIR, big.replace('.webp', '.avif')));
  await narrow().avif({ quality: 60, effort: 6 }).toFile(path.join(OUT_DIR, small.replace('.webp', '.avif')));
  // Shown until the real picture arrives.
  const blur = await sharp(original).resize({ width: 32 }).webp({ quality: 40, effort: 6 }).toBuffer();
  fs.writeFileSync(
    OUT_FILE,
    `${JSON.stringify({ id: hero.id, author: hero.author, src: `/images/${big}`, small: `/images/${small}`, width: hero.width, height: hero.height, blur: `data:image/webp;base64,${blur.toString('base64')}` }, null, 2)}\n`,
  );
  console.log(`hero: ${hero.id} by ${hero.author}`);
}

if (process.argv[1]?.endsWith('generate-hero.js')) await main();
