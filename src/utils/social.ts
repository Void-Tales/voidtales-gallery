// Likes and comments from gallery-api (same origin, /api/). Every island imports
// this module, and Vite bundles it once, so the state below is shared on the page.
// If the API is down, `available` stays false and the gallery works without it.

import { useEffect, useState } from "preact/hooks";

export type Stat = { likes: number; comments: number };
export type Me = { name: string; avatar: string; staff: boolean };
export type Comment = {
  id: number;
  name: string;
  avatar: string | null;
  body: string;
  source: "site" | "discord";
  created: number;
  canDelete: boolean;
};

const state = {
  available: false,
  stats: {} as Record<string, Stat>,
  me: null as Me | null,
  liked: new Set<string>(),
};
export type SocialState = typeof state;

const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

export function useSocial(): SocialState {
  const [, setTick] = useState(0);
  useEffect(() => {
    const listener = () => setTick((t) => t + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return state;
}

export const getStats = () => state.stats;

export const loginUrl = (imageId?: string) => `/api/login${imageId ? `?img=${imageId}` : ""}`;

let started: Promise<void> | null = null;
export function loadSocial() {
  started ??= (async () => {
    try {
      const [statsRes, meRes] = await Promise.all([
        fetch("/api/stats", { signal: AbortSignal.timeout(5000) }),
        fetch("/api/me", { signal: AbortSignal.timeout(5000) }),
      ]);
      if (!statsRes.ok) return;
      state.stats = await statsRes.json();
      state.available = true;
      if (meRes.ok) {
        const me = await meRes.json();
        state.me = me.user;
        state.liked = new Set(me.liked);
      }
    } catch {
      // API unreachable: the gallery simply shows no numbers.
    }
    emit();
  })();
  return started;
}

function bump(imageId: string, field: keyof Stat, by: number) {
  const current = state.stats[imageId] ?? { likes: 0, comments: 0 };
  state.stats = { ...state.stats, [imageId]: { ...current, [field]: Math.max(0, current[field] + by) } };
}

const ERRORS: Record<number, string> = {
  401: "Your login expired, please log in again.",
  403: "Not allowed.",
  413: "That comment is too long (500 characters max).",
  429: "Slow down a little and try again in a minute.",
  409: "This like is a reaction in Discord and Discord didn't let us remove it. Remove it there.",
};

async function send(method: string, path: string, body?: unknown) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) state.me = null;
  if (!res.ok) throw new Error(ERRORS[res.status] ?? "Something went wrong, please try again.");
  return res.json();
}

export async function toggleLike(imageId: string) {
  const { liked, likes } = await send("POST", `/api/images/${imageId}/like`);
  if (liked) state.liked.add(imageId);
  else state.liked.delete(imageId);
  state.stats = { ...state.stats, [imageId]: { comments: state.stats[imageId]?.comments ?? 0, likes } };
  emit();
}

export async function fetchComments(imageId: string): Promise<Comment[]> {
  const res = await fetch(`/api/images/${imageId}/comments`);
  return res.ok ? res.json() : [];
}

export async function postComment(imageId: string, body: string): Promise<Comment> {
  const comment = await send("POST", `/api/images/${imageId}/comments`, { body });
  bump(imageId, "comments", 1);
  emit();
  return comment;
}

export async function deleteComment(imageId: string, commentId: number) {
  await send("DELETE", `/api/comments/${commentId}`);
  bump(imageId, "comments", -1);
  emit();
}

export async function logout() {
  await fetch("/api/logout", { method: "POST" }).catch(() => {});
  state.me = null;
  state.liked = new Set();
  emit();
}
