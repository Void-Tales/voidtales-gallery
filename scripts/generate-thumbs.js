import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

// Source and output directories
const srcDirs = [
  path.resolve('public/images/original'),
  path.resolve('public/images/original/default')
];
const outDir = path.resolve('public/images/thumbs');
const marker = path.resolve('.thumbs_generated');

// Thumbnail sizes (px)
const sizes = [200, 400, 800, 1600]; // 800px for high-res (2x) grid tiles, 1600px for the lightbox

// Skip generation if marker file exists
if (fs.existsSync(marker)) {
  console.log('Thumbnails already generated. Skipping.');
  process.exit(0);
}

// Ensure output directory exists
fs.mkdirSync(outDir, { recursive: true });

// Get all supported image files from both source directories
let files = [];
for (const dir of srcDirs) {
  if (fs.existsSync(dir)) {
    const dirFiles = fs.readdirSync(dir)
      .filter(f => /\.(jpe?g|png|webp)$/i.test(f))
      .map(f => ({ file: f, dir }));
    files = files.concat(dirFiles);
  }
}
if (!files.length) {
  console.log('No source images found in', srcDirs.join(', '));
  process.exit(0);
}

(async () => {
  for (const { file, dir } of files) {
    const name = path.parse(file).name;
    const input = path.join(dir, file);
    for (const w of sizes) {
      // Generate WebP thumbnail if it doesn't exist
      const outWebp = path.join(outDir, `${name}-${w}.webp`);
      if (fs.existsSync(outWebp)) {
        console.log('skip', outWebp, '(already exists)');
        continue;
      }
      await sharp(input).resize({ width: w, withoutEnlargement: true }).webp({ quality: 80 }).toFile(outWebp);
      console.log('wrote', outWebp);
    }
  }
  // Write marker file after successful generation
  fs.writeFileSync(marker, 'Thumbnails generated');
  console.log('All thumbnails (WebP only) generated. Marker file written.');
})();