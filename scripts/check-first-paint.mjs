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
// Zweitens: das Inline-Script, das den statischen Grid auf schmalen Fenstern
// umraeumt, verteilt nach derselben Greedy-Regel wie distributeColumns. Hier
// laeuft der ausgelieferte Code selbst gegen das Original, damit die beiden
// Implementierungen nicht auseinanderlaufen.
const inline = html.match(
	/<script id="static-grid-columns">([\s\S]*?)<\/script>/,
);
assert.ok(inline, "Inline-Script fuer die Spaltenverteilung nicht gefunden");

const sortIndex = new Map(photos.map((p, i) => [p.id, i]));
const ratio = new Map(photos.map((p) => [p.id, p.ratio]));

function laufInline(spalten) {
	// items in DOM-Reihenfolge des statischen Grids, so wie querySelectorAll liefert.
	const items = domIds.map((id) => ({
		id,
		dataset: { i: String(sortIndex.get(id)), r: String(ratio.get(id)) },
	}));
	const grid = {
		querySelectorAll: () => items,
		replaceChildren: (...spaltenDivs) => {
			grid.ergebnis = spaltenDivs.flatMap((d) => d.kinder.map((n) => n.id));
		},
	};
	const doc = {
		querySelector: () => grid,
		createElement: () => ({
			className: "",
			kinder: [],
			appendChild(n) {
				this.kinder.push(n);
			},
		}),
	};
	const mm = (q) => ({
		matches: q.includes("1000") ? spalten === 3 : spalten >= 2,
	});
	new Function("matchMedia", "document", inline[1])(mm, doc);
	return grid.ergebnis;
}

for (const spalten of [1, 2]) {
	assert.deepEqual(
		laufInline(spalten),
		distributeColumns(photos, spalten)
			.flat()
			.map((p) => p.id),
		`Inline-Script und distributeColumns weichen bei ${spalten} Spalte(n) ab`,
	);
}
assert.equal(
	laufInline(3),
	undefined,
	"Inline-Script muss bei 3 Spalten aussteigen",
);

console.log(
	`ok: ${domIds.length} Bilder, statischer Grid und erster Client-Render deckungsgleich; ` +
		"Inline-Umverteilung stimmt bei 1 und 2 Spalten mit distributeColumns ueberein",
);
