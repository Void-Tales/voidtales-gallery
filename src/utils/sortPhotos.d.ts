/** Sorts by date/title/random - it only touches `date` and `title`. */
export function sortPhotos<T extends { title?: string; date?: string }>(
  photos: T[],
  option: string
): T[];
