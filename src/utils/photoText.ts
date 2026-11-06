// Everything images.json says about a photo comes straight from Discord: filenames as
// titles, raw mention tokens in the message text, "Default Screenshot #6" on the
// bundled images. This is what a visitor should read instead.

type PhotoLike = {
  title?: string;
  caption?: string;
  body?: string;
  author?: string;
  isDefault?: boolean;
};

const clean = (text = "") =>
  text
    .replace(/<@[!&]?\d+>|<#\d+>/g, "")
    .replace(/<a?:\w+:\d+>/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

/** Discord marks a spoiler by the filename. */
export const isSpoiler = (photo: PhotoLike) => /^SPOILER_/i.test(photo.title ?? "");

/** "image", timestamps and the like are not titles. Underscores read as spaces. */
export function realTitle(title = ""): string {
  const t = title.replace(/^SPOILER_/i, "").trim();
  if (!t || /^image(-\d+)?$/i.test(t) || /^default-\d+$/i.test(t) || /^\d{4}-\d{2}-\d{2}/.test(t)) return "";
  return t.replace(/[_-]+/g, " ").trim();
}

/** What the author wrote, else a title somebody chose, else nothing. */
export function photoText(photo: PhotoLike): string {
  if (photo.isDefault) return "";
  return clean(photo.caption) || clean(photo.body) || realTitle(photo.title);
}

export function photoAlt(photo: PhotoLike): string {
  const by = photo.author ? `Screenshot by ${photo.author}` : "Screenshot from Void Tales";
  const text = photoText(photo);
  return text ? `${by}: ${text.slice(0, 120)}` : by;
}
