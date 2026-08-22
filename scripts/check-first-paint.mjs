// Prueft am gebauten dist/index.html, dass der erste Client-Render exakt das
// Markup reproduziert, das der statische Grid schon zeigt: gleiche Bilder,
// gleiche Spaltenverteilung, gleiche Reihenfolge. Genau das haelt den Uebergang
// statisch -> interaktiv pixelgleich. Laufen beide auseinander, springt der Grid
// beim Mount um oder blitzt weg - der Fehler, den Lighthouse in den Frames zeigte.
// Aufruf: node scripts/check-first-paint.mjs   (nach `pnpm run build`)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { distributeColumns } from "../src/utils/distributeColumns.ts";

const html = readFileSync("dist/index.html", "utf8");

const domIds = [
	...html.matchAll(/<a[^>]*class="photo loaded"[^>]*data-id="([^"]+)"/g),
].map((m) => m[1]);
assert.ok(
	domIds.length > 0,
	"kein statischer Grid im HTML - Crawler saehen eine leere Seite",
);

const island = html.match(
	/<astro-island[^>]*PhotoGridClient[^>]*props="([^"]*)"/,
);
assert.ok(island, "PhotoGridClient-Insel nicht gefunden");
// Astro serialisiert als [typ, wert]: Arrays als [1, [...]], Werte als [0, x].
const props = JSON.parse(
	island[1].replaceAll("&quot;", '"').replaceAll("&#38;", "&"),
);
assert.ok(
	props.initialPhotos,
	"initialPhotos fehlt - der Client wuerde wieder per fetch laden",
);
const photos = props.initialPhotos[1].map((e) => ({
	id: e[1].id[1],
	ratio: e[1].ratio[1],
}));

// 3 Spalten: derselbe Wert, den beide Seiten am Desktop verwenden.
const clientIds = distributeColumns(photos, 3)
	.flat()
	.map((p) => p.id);
assert.deepEqual(
	clientIds,
	domIds,
	"erster Client-Render weicht vom statischen Grid ab",
);
console.log(
	`ok: ${domIds.length} Bilder, statischer Grid und erster Client-Render deckungsgleich`,
);
