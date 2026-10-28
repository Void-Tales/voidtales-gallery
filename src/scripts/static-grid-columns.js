// Der statische Grid steht in drei Spalten, weil zur Bauzeit niemand die
// Viewport-Breite kennt. Auf schmalen Fenstern waere das der falsche erste
// Frame: der Client raeumt ihn beim Mount auf 1 bzw. 2 Spalten um, und genau
// dieses Umspringen sieht man. Also hier, synchron direkt hinter dem Markup
// und damit vor dem ersten Paint. Auf Desktop steigt es sofort wieder aus,
// dort stimmt die Aufteilung schon.
// Greedy wie `src/utils/distributeColumns.ts` - beide muessen dasselbe
// Ergebnis liefern, sonst springt der Grid bei der Uebergabe doch noch um.
(function () {
	var want = matchMedia('(min-width: 1000px)').matches
		? 3
		: matchMedia('(min-width: 640px)').matches
			? 2
			: 1;
	if (want === 3) return;
	var grid = document.querySelector('[data-static-grid] .masonry');
	if (!grid) return;
	var items = [].slice.call(grid.querySelectorAll('.photo')).sort(function (a, b) {
		return a.dataset.i - b.dataset.i;
	});
	var cols = [];
	var heights = [];
	for (var c = 0; c < want; c++) {
		var col = document.createElement('div');
		col.className = 'masonry-col';
		cols.push(col);
		heights.push(0);
	}
	for (var i = 0; i < items.length; i++) {
		var shortest = 0;
		for (var c = 1; c < want; c++) if (heights[c] < heights[shortest]) shortest = c;
		cols[shortest].appendChild(items[i]);
		heights[shortest] += 1 / parseFloat(items[i].dataset.r);
	}
	grid.replaceChildren.apply(grid, cols);
})();
