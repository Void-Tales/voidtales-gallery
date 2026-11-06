// node --experimental-strip-types scripts/photo-text.test.mjs: what a visitor must never read, what the hero must never show.
import assert from 'node:assert/strict';
import { isSpoiler, photoAlt, photoText, realTitle } from '../src/utils/photoText.ts';
import { pickHero } from './generate-hero.js';

for (const t of ['image', 'image-24', 'default-3', '2026-02-01_18.55.16', 'SPOILER_2025-10-15_18.22.38']) assert.equal(realTitle(t), '');
assert.equal(realTitle('shin_vs_cyn_3'), 'shin vs cyn 3');

// Raw Discord tokens never reach the page, a body of nothing but a mention is no text.
assert.equal(photoText({ body: '<@1026553184677793904>', title: 'image' }), '');
assert.equal(photoText({ body: 'In the video in <#1420727394053918782> you see', title: 'image' }), 'In the video in you see');
assert.equal(photoText({ caption: 'Default Screenshot #6', isDefault: true, title: 'default-6' }), '');
assert.equal(photoText({ title: 'Beauty_ava_1', body: 'dawn atmosphere fits ava' }), 'dawn atmosphere fits ava');

assert.equal(photoAlt({ author: 'shinsnowly', title: '2026-02-01_18.55.16' }), 'Screenshot by shinsnowly');
assert.ok(isSpoiler({ title: 'SPOILER_2025-11-21_16.55.16' }));
assert.ok(!isSpoiler({ title: 'image' }));

const shot = (id, date, extra = {}) => ({ id, date, title: 'image', width: 1920, ...extra });
const images = [
  shot('spoiler', '2026-10-05', { title: 'SPOILER_2026-10-05_12.00.00' }),
  shot('default', '2026-10-04', { isDefault: true }),
  shot('small', '2026-10-03', { width: 800 }),
  shot('newest', '2026-10-02'),
  shot('liked', '2026-10-01'),
  shot('older-liked', '2026-09-01'),
];
const stats = { spoiler: { likes: 9, comments: 0 }, liked: { likes: 1, comments: 0 }, 'older-liked': { likes: 5, comments: 0 } };
assert.equal(pickHero(images, stats).id, 'liked');
assert.equal(pickHero(images, {}).id, 'newest');
assert.equal(pickHero([], {}), null);
console.log('gallery text: ok');
