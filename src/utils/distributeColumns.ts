/**
 * Greedy masonry: put each item into the currently shortest column.
 * Column height is tracked in units of column-width (1 / aspectRatio),
 * so it stays independent of the actual pixel width.
 *
 * Append-stable: adding items never changes the placement of the prefix.
 *
 * Zwilling: das Inline-Script in `PhotoGrid.astro` verteilt den statischen Grid
 * auf schmalen Fenstern nach derselben Regel. Aendert sich hier etwas, muss es
 * dort mit - sonst springt der Grid bei der Uebergabe an den Client um.
 */
export function distributeColumns<T extends { ratio: number }>(items: T[], cols: number): T[][] {
  const columns: T[][] = Array.from({ length: cols }, () => []);
  const heights = new Array(cols).fill(0);

  for (const item of items) {
    let shortest = 0;
    for (let c = 1; c < cols; c++) {
      if (heights[c] < heights[shortest]) shortest = c;
    }
    columns[shortest].push(item);
    heights[shortest] += 1 / item.ratio;
  }

  return columns;
}
