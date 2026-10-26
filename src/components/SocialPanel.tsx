// Like button and comments for one image, mounted into the GLightbox slide
// description by PhotoGridClient. Everything user-written is rendered as JSX
// text, never as HTML.

import { useEffect, useRef, useState } from "preact/hooks";
import {
  type Comment,
  deleteComment,
  fetchComments,
  loginUrl,
  postComment,
  toggleLike,
  useSocial,
} from "../utils/social.js";

const MAX_LENGTH = 500;

// Same breakpoint as the side panel in lightbox.css. Below it the comments live
// in a bottom sheet that the comment button opens.
const SIDE_PANEL = "(width >= 900px)";

const dateFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

export function HeartIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 21s-7.5-4.6-9.5-9.2C1.2 8.6 3.3 5 6.8 5c2 0 3.4 1.1 4.2 2.4h2C13.8 6.1 15.2 5 17.2 5c3.5 0 5.6 3.6 4.3 6.8C19.5 16.4 12 21 12 21z" />
    </svg>
  );
}

export function CommentIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 5h16v11H9l-5 4z" />
    </svg>
  );
}

function DiscordMark() {
  return (
    <svg class="comment-discord" viewBox="0 0 24 24" role="img" aria-label="from Discord">
      <title>Posted in the Discord thread</title>
      <path d="M19.3 5.3A16.7 16.7 0 0 0 15.1 4l-.5 1.1a15.5 15.5 0 0 0-5.2 0L8.9 4a16.7 16.7 0 0 0-4.2 1.3C2 9.3 1.3 13.2 1.7 17a16.9 16.9 0 0 0 5.1 2.6l1.1-1.8a10.9 10.9 0 0 1-1.7-.8l.4-.3a12 12 0 0 0 10.8 0l.4.3c-.5.3-1.1.6-1.7.8l1.1 1.8a16.8 16.8 0 0 0 5.1-2.6c.5-4.4-.8-8.3-3-11.7zM8.7 14.7c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2zm6.6 0c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2z" />
    </svg>
  );
}

export default function SocialPanel({ imageId }: { imageId: string }) {
  const social = useSocial();
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (social.available) fetchComments(imageId).then(setComments, () => setComments([]));
  }, [imageId, social.available]);

  if (!social.available) return null;

  const stat = social.stats[imageId] ?? { likes: 0, comments: 0 };
  const liked = social.liked.has(imageId);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  }

  function onLike() {
    if (!social.me) {
      window.location.href = loginUrl(imageId);
      return;
    }
    run(() => toggleLike(imageId));
  }

  function onSubmit(event: Event) {
    event.preventDefault();
    const body = draft.trim();
    if (!body) return;
    run(async () => {
      const comment = await postComment(imageId, body);
      setComments((prev) => [...(prev ?? []), comment]);
      setDraft("");
      // After the re-render, so the new comment is in the list: show it.
      setTimeout(() => list.current?.scrollTo({ top: list.current.scrollHeight }));
    });
  }

  // Side panel: comments are always visible, the button jumps to the input.
  // Bottom sheet: the button opens and closes it.
  function onCommentsButton() {
    if (window.matchMedia(SIDE_PANEL).matches) textarea.current?.focus();
    else setOpen((o) => !o);
  }

  function onDelete(id: number) {
    run(async () => {
      await deleteComment(imageId, id);
      setComments((prev) => (prev ?? []).filter((c) => c.id !== id));
    });
  }

  return (
    <section class="social-panel nodrag" aria-label="Likes and comments">
      <div class="social-actions">
        <button
          type="button"
          class={`like-btn${liked ? " liked" : ""}`}
          aria-pressed={liked}
          disabled={busy}
          onClick={onLike}
          title={social.me ? (liked ? "Remove like" : "Like") : "Log in with Discord to like"}
        >
          <HeartIcon />
          <span>{stat.likes}</span>
        </button>
        <button
          type="button"
          class="social-count"
          aria-expanded={open}
          title="Comments"
          onClick={onCommentsButton}
        >
          <CommentIcon />
          <span>{stat.comments}</span>
        </button>
      </div>

      <div class={`social-thread${open ? " open" : ""}`}>
        <div class="social-thread-head">
          <h5>Comments</h5>
          <button type="button" class="social-thread-close" aria-label="Close comments" onClick={() => setOpen(false)}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        {comments && comments.length === 0 && <p class="comment-empty">No comments yet.</p>}
        {comments && comments.length > 0 && (
          <ul class="comment-list" ref={list}>
            {comments.map((c) => (
              <li key={c.id} class="comment">
                {c.avatar ? (
                  <img class="comment-avatar" src={c.avatar} alt="" width={28} height={28} loading="lazy" />
                ) : (
                  <span class="comment-avatar" />
                )}
                <div class="comment-main">
                  <div class="comment-meta">
                    <span class="comment-name">{c.name}</span>
                    {c.source === "discord" && <DiscordMark />}
                    <time dateTime={new Date(c.created).toISOString()}>{dateFormat.format(c.created)}</time>
                    {c.canDelete && (
                      <button type="button" class="comment-delete" disabled={busy} onClick={() => onDelete(c.id)}>
                        Delete
                      </button>
                    )}
                  </div>
                  <p class="comment-body">{c.body}</p>
                </div>
              </li>
            ))}
          </ul>
        )}

        {social.me ? (
          <form class="comment-form" onSubmit={onSubmit}>
            <textarea
              ref={textarea}
              value={draft}
              maxLength={MAX_LENGTH}
              rows={2}
              placeholder="Write a comment…"
              aria-label="Comment"
              onInput={(e) => setDraft(e.currentTarget.value)}
              // GLightbox listens on window and only spares Tab: without this the
              // arrow keys switch slides while typing. Escape still closes.
              onKeyDown={(e) => {
                if (e.key !== "Escape") e.stopPropagation();
              }}
            />
            <div class="comment-form-row">
              <span class="comment-counter">
                {draft.length}/{MAX_LENGTH} · also posted in the Discord thread
              </span>
              <button type="submit" class="comment-submit" disabled={busy || !draft.trim()}>
                Post
              </button>
            </div>
          </form>
        ) : (
          <a class="social-login" href={loginUrl(imageId)}>
            Log in with Discord to like and comment
          </a>
        )}
      </div>

      {error && (
        <p class="social-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
