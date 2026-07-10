import fs from 'fs';
import path from 'path';

const imagesDir = path.join(process.cwd(), 'public/images/original');
const defaultImagesDir = path.join(imagesDir, 'default');
const mdDir = path.join(process.cwd(), 'src/content/photos');
const defaultMdDir = path.join(mdDir, 'default');
const outPath = path.join(process.cwd(), 'public/images.json');

// Cleanup: Lösche gecachte Default-Dateien im Hauptordner
fs.readdirSync(imagesDir)
  .filter(f => f.endsWith('-default.webp') && !fs.statSync(path.join(imagesDir, f)).isDirectory())
  .forEach(f => {
    fs.unlinkSync(path.join(imagesDir, f));
    console.log(`🗑️ Deleted: ${f} from images/original`);
  });

fs.readdirSync(mdDir)
  .filter(f => f.endsWith('-default.md') && !fs.statSync(path.join(mdDir, f)).isDirectory())
  .forEach(f => {
    fs.unlinkSync(path.join(mdDir, f));
    console.log(`🗑️ Deleted: ${f} from content/photos`);
  });

// Helper: Extract frontmatter from markdown file
function extractFrontmatter(fullPath) {
  if (!fs.existsSync(fullPath)) return {};
  const content = fs.readFileSync(fullPath, 'utf-8');
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) return {};

  const frontmatter = {};
  const lines = frontmatterMatch[1].split('\n');
  for (const line of lines) {
    const [key, ...valueParts] = line.split(':');
    if (key && valueParts.length) {
      const value = valueParts.join(':').trim().replace(/^["']|["']$/g, '');
      frontmatter[key.trim()] = value;
    }
  }
  return frontmatter;
}

// 1. Externe Bilder + Markdown
const externalImages = fs.readdirSync(imagesDir)
  .filter(f => /\.(webp|jpg|png|jpeg|bmp)$/i.test(f) && !fs.statSync(path.join(imagesDir, f)).isDirectory() && !f.endsWith('-default.webp'));

const externalEntries = externalImages.map(file => {
  const id = path.parse(file).name;
  const imageUrl = `/images/original/${file}`;
  const mdFile = path.join(mdDir, `${id}.md`);
  const mdPath = fs.existsSync(mdFile) ? `/src/content/photos/${id}.md` : null;
  const frontmatter = extractFrontmatter(mdFile);

  return {
    id,
    imageUrl,
    mdPath,
    isDefault: false,
    date: frontmatter.date || null,
    title: frontmatter.title || id,
    caption: frontmatter.caption || '',
    author: frontmatter.author || '',
    body: frontmatter.body || '',
    width: Number(frontmatter.width) || null,
    height: Number(frontmatter.height) || null,
  };
});

// 2. Default Bilder + Markdown
const defaultImages = fs.existsSync(defaultImagesDir)
  ? fs.readdirSync(defaultImagesDir).filter(f => /\.(webp|jpg|png|jpeg|bmp)$/i.test(f))
  : [];

const defaultEntries = defaultImages.map(file => {
  const id = path.parse(file).name.replace(/-default$/, '');
  const imageUrl = `/images/original/default/${file}`;
  const mdFile = path.join(defaultMdDir, `${id}-default.md`);
  const mdPath = fs.existsSync(mdFile) ? `/src/content/photos/default/${id}-default.md` : null;
  const frontmatter = extractFrontmatter(mdFile);

  return {
    id,
    imageUrl,
    mdPath,
    isDefault: true,
    date: frontmatter.date || null,
    title: frontmatter.title || id,
    caption: frontmatter.caption || '',
    author: frontmatter.author || '',
    body: frontmatter.body || '',
    width: Number(frontmatter.width) || null,
    height: Number(frontmatter.height) || null,
  };
});

// 3. Combine and write
const images = [...externalEntries, ...defaultEntries];
fs.writeFileSync(outPath, JSON.stringify(images, null, 2), 'utf-8');
console.log(`✅ Wrote ${images.length} entries to public/images.json`);

// Bild-Sitemap generieren
const baseUrl = 'https://gallery.voidtales.win';
let sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n`;

images.forEach(img => {
  sitemap += `  <url>\n`;
  sitemap += `    <loc>${baseUrl}/#img-${img.id}</loc>\n`;
  sitemap += `    <image:image>\n`;
  sitemap += `      <image:loc>${baseUrl}${img.imageUrl}</image:loc>\n`;
  if (img.caption) sitemap += `      <image:title>${img.caption}</image:title>\n`;
  sitemap += `    </image:image>\n`;
  sitemap += `  </url>\n`;
});

sitemap += `</urlset>\n`;

fs.writeFileSync(path.join(process.cwd(), 'public/sitemap.xml'), sitemap, 'utf-8');
console.log('✅ Image sitemap generated!');