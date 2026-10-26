/** Sorts by date/title/likes/random - it only touches `id`, `date` and `title`. */
export function sortPhotos<T extends { id?: string; title?: string; date?: string }>(
  photos: T[],
  option: string,
  stats?: Record<string, { likes: number }>
): T[];
