/**
 * Sorts an array of photo objects by the given option.
 * @param {Array} photos - Array of photo objects
 * @param {string} option - Sort option (e.g., 'date-desc', 'name-asc')
 * @param {Object} [stats] - Like counts by photo id, only used by 'popular'
 * @returns {Array} Sorted array
 */
export function sortPhotos(photos, option, stats = {}) {
  const likes = (photo) => stats[photo.id]?.likes ?? 0;
  switch (option) {
    case 'popular':
      // Ties (and every photo while the API is down) fall back to newest first.
      return [...photos].sort((a, b) => likes(b) - likes(a) || new Date(b.date || 0) - new Date(a.date || 0));
    case 'date-desc':
      return [...photos].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    case 'date-asc':
      return [...photos].sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
    case 'name-asc':
      return [...photos].sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    case 'name-desc':
      return [...photos].sort((a, b) => (b.title || '').localeCompare(a.title || ''));
    case 'random': {
      // Fisher-Yates Shuffle
      const arr = [...photos];
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    }
    default:
      return photos;
  }
}