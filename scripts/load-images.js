/**
 * Loads the latest images.json, in file order (sorting happens in the grid).
 * Throws on any failure, so callers never mistake an error for an empty gallery.
 */
async function loadImages() {
  const response = await fetch(`/images.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`images.json: HTTP ${response.status}`);
  const images = await response.json();
  if (!Array.isArray(images)) throw new Error('images.json: not a list');
  return images;
}

export default loadImages;
