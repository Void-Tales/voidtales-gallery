// gallery-api: likes and comments for gallery.voidtales.win, served under /api/ on
// the same host. No dependencies on purpose - node:http, node:sqlite, fetch.
//
// Writing needs a Discord login and membership in the Void Tales guild; reading is
// public. A timer mirrors reactions and thread replies on the original Discord
// posts into the same tables; site comments go the other way into the post's
// thread, through a channel webhook that carries the commenter's name.

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const DISCORD = "https://discord.com/api/v10";
const UA = "DiscordBot (https://gallery.voidtales.win, 1)";
const MIN = 60_000;
const DAY = 86_400_000;
const SESSION_TTL = 7 * DAY;
const RECENT = 30 * DAY;
const PURGE_DELETED = 30 * DAY;
// Site comments older than this are not sent to Discord any more (a long Discord outage,
// or comments from before the mirror existed).
const MIRROR_WINDOW = 7 * DAY;
// /api/health counts what has waited longer than this for Discord (alert GalleryMirrorBacklog).
const MIRROR_LATE = 30 * MIN;
const WEBHOOK_NAME = "Void Tales Gallery";
const VIA = " · via Gallery";
const MAX_BODY = 4096;
const MAX_COMMENT = 500;
const IMAGE_ID = /^\d{8}$/;
const SESSION_COOKIE = "__Host-vt_sess";
const OAUTH_COOKIE = "__Host-vt_oauth";
// Control characters and bidi overrides; newlines and tabs stay.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
const UNSAFE_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F‎‏‪-‮⁦-⁩]/g;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const b64url = (buf) => buf.toString("base64url");
const list = (value, fallback = "") =>
  (value ?? fallback)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const snowflakeTime = (id) => Number(BigInt(id) >> 22n) + 1420070400000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// First of the names that is left after cleaning; Discord names can be nothing but control characters.
const displayName = (...names) => names.map((n) => (n ?? "").replace(UNSAFE_CHARS, "").trim()).find(Boolean) ?? "";
// Text goes to Discord as plain text, the way the site shows it: no masked links, no fake
// "-#" footer, no headings or quotes, no <@id>.
const discordText = (s) => s.replace(/[\\*_~`|>#\-[\]()<]/g, "\\$&");
// Webhook messages: no link previews (SUPPRESS_EMBEDS).
const NO_EMBEDS = 4;

// Rate limit key: the address, IPv6 by its /64, since one connection usually owns a whole /64.
export function ipKey(address) {
  const ip = String(address ?? "").replace(/^::ffff:(?=\d+\.)/i, "");
  if (!ip.includes(":")) return ip;
  const [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return `${groups
    .slice(0, 4)
    .map((g) => g.toLowerCase().replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}
// Reactions come as "❤️" or "❤" depending on the client; compare without the variation selector.
const bareEmoji = (s) => s.replace(/️/g, "");

function avatarUrl(userId, user, member, guildId) {
  if (member?.avatar)
    return `https://cdn.discordapp.com/guilds/${guildId}/users/${userId}/avatars/${member.avatar}.png?size=64`;
  if (user?.avatar) return `https://cdn.discordapp.com/avatars/${userId}/${user.avatar}.png?size=64`;
  return `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(userId) >> 22n) % 6n)}.png`;
}

export function createApp(env, { fetch = globalThis.fetch, now = Date.now } = {}) {
  const origin = env.PUBLIC_ORIGIN || "https://gallery.voidtales.win";
  const guildId = env.DISCORD_GUILD_ID;
  const staffRoles = new Set(list(env.STAFF_ROLE_IDS));
  const channels = list(env.GALLERY_CHANNEL_IDS, "1412414075035582605,1264644697155043398");
  const summaryBot = env.SUMMARY_BOT_ID || "1404876556425494548";
  const likeEmojis = new Set(list(env.LIKE_EMOJIS, "👍,❤️").map(bareEmoji));
  const redirectUri = `${origin}/api/callback`;

  if (env.DB_PATH && env.DB_PATH !== ":memory:") mkdirSync(dirname(env.DB_PATH), { recursive: true });
  const db = new DatabaseSync(env.DB_PATH || ":memory:");
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  const q = (sql) => db.prepare(sql);
  const tx = (fn) => {
    db.exec("BEGIN");
    try {
      fn();
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  };
  const kvGet = (key) => q("SELECT value FROM kv WHERE key = ?").get(key)?.value;
  const kvSet = (key, value) => q("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)").run(key, String(value));

  // images: id -> title. webhooks: channel -> "id/token", only in memory so the token stays out of the backups.
  const state = {
    images: new Map(),
    webhooks: new Map(),
    botId: null,
    lastSync: 0,
    lastFullSync: 0,
    syncing: false,
  };

  // ponytail: in-memory sliding windows, reset on restart; one process is all there is.
  // Housekeeping drops each key once its own window has passed, so the map stays as big as
  // the users of the last minutes (a day only for the daily comment limit).
  const hits = new Map();
  function limited(key, max, windowMs) {
    const t = now();
    const times = (hits.get(key)?.times ?? []).filter((h) => t - h < windowMs);
    const over = times.length >= max;
    if (!over) times.push(t);
    hits.set(key, { windowMs, times });
    return over;
  }

  // OAuth logins in flight: state -> { verifier, img, expires }. The callback takes its entry
  // out, so a state works once and a replayed callback never reaches Discord.
  const pendingLogins = new Map();
  const MAX_PENDING = 10_000;

  // ---------- Discord ----------

  // The timeout keeps a hanging request from blocking sync or mirror for good.
  async function discord(path, init = {}, tries = 3) {
    const res = await fetch(DISCORD + path, {
      signal: AbortSignal.timeout(30_000),
      ...init,
      headers: { "User-Agent": UA, ...init.headers },
    });
    if (res.status === 429 && tries > 0) {
      const body = await res.json().catch(() => ({}));
      await sleep(Math.min(Number(body.retry_after) || 1, 60) * 1000 + 250);
      return discord(path, init, tries - 1);
    }
    return res;
  }

  async function botJson(path) {
    const res = await discord(path, { headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`discord ${res.status} on ${path.split("?")[0]}`);
    return res.json();
  }

  const botWrite = (method, path, body) =>
    discord(path, {
      method,
      headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
      body: body && JSON.stringify(body),
    });
  const errorCode = async (res) => (await res.json().catch(() => ({}))).code;

  // The n8n workflow answers every post with a summary that carries the image IDs in
  // its delete links. Backfill summaries reply to the post; live ones are plain
  // messages after it, so the post is the nearest earlier upload by the author
  // named in "(by …)". Usually seconds apart, but a re-run workflow once answered
  // 3.7 h late (63221667), hence the one-day window. The workflow itself stays
  // untouched (contract).
  async function mapSummary(channel, msg) {
    const ids = [...new Set([...(msg.content ?? "").matchAll(/imageId=(\d{8})/g)].map((m) => m[1]))];
    if (ids.length === 0) return;
    let post = null;
    const ref = msg.message_reference;
    if (ref?.message_id) post = { channel: ref.channel_id || channel, id: ref.message_id };
    else {
      const by = msg.content.match(/\(by ([^)\n]+)\)/)?.[1];
      const before = (await botJson(`/channels/${channel}/messages?limit=50&before=${msg.id}`)) ?? [];
      const hit = before.find(
        (m) =>
          !m.author?.bot &&
          m.attachments?.length > 0 &&
          snowflakeTime(msg.id) - snowflakeTime(m.id) < DAY &&
          (!by || by === m.author.username || by === m.author.global_name),
      );
      if (hit) post = { channel, id: hit.id };
    }
    if (!post) {
      console.warn(`[sync] no post found for summary ${msg.id} (${ids.join(",")})`);
      return;
    }
    const insert = q("INSERT OR REPLACE INTO image_posts (image_id, channel_id, message_id) VALUES (?, ?, ?)");
    for (const id of ids) insert.run(id, post.channel, post.id);
  }

  // Walks the channel from the newest message back to the last cursor.
  async function scanChannel(channel) {
    const cursor = BigInt(kvGet(`cursor:${channel}`) ?? "0");
    let newest = cursor;
    let before = "";
    for (;;) {
      const page = await botJson(`/channels/${channel}/messages?limit=100${before && `&before=${before}`}`);
      if (!page?.length) break;
      let done = false;
      for (const msg of page) {
        if (BigInt(msg.id) <= cursor) {
          done = true;
          break;
        }
        if (BigInt(msg.id) > newest) newest = BigInt(msg.id);
        if (msg.author?.id === summaryBot) await mapSummary(channel, msg);
      }
      if (done || page.length < 100) break;
      before = page.at(-1).id;
    }
    kvSet(`cursor:${channel}`, newest);
  }

  async function pages(path, key) {
    const out = [];
    let cursor = "";
    for (;;) {
      const page = (await botJson(`${path}${path.includes("?") ? "&" : "?"}limit=100${cursor}`)) ?? [];
      out.push(...page);
      if (page.length < 100) return out;
      cursor = `&${key}=${page.at(-1).id}`;
    }
  }

  async function syncPost(channelId, messageId) {
    const imageIds = q("SELECT image_id FROM image_posts WHERE message_id = ?")
      .all(messageId)
      .map((r) => r.image_id);
    const fetchedAt = now();
    const msg = await botJson(`/channels/${channelId}/messages/${messageId}`);
    const users = new Set();
    const replies = [];
    // IDs of everything in the thread, null when there is no thread to compare against.
    let inThread = null;
    if (msg) {
      for (const r of msg.reactions ?? []) {
        if (!likeEmojis.has(bareEmoji(r.emoji.name ?? ""))) continue;
        const emoji = encodeURIComponent(r.emoji.id ? `${r.emoji.name}:${r.emoji.id}` : r.emoji.name);
        for (const u of await pages(`/channels/${channelId}/messages/${messageId}/reactions/${emoji}`, "after"))
          if (!u.bot) users.add(u.id);
      }
      // A thread started from a message shares its ID.
      if (msg.thread) {
        inThread = new Set();
        for (const m of await pages(`/channels/${msg.thread.id}/messages`, "before")) {
          inThread.add(m.id);
          const body = (m.content ?? "").replace(UNSAFE_CHARS, "").trim().slice(0, 2000);
          // Webhook messages are our own site comments; importing them would double them.
          if (m.author?.bot || m.webhook_id || !body) continue;
          replies.push({ m, body });
        }
      }
    }
    // Deleted in Discord (msg null, or reaction/reply gone) disappears here too.
    tx(() => {
      for (const imageId of imageIds) {
        q("DELETE FROM likes WHERE image_id = ? AND source = 'discord'").run(imageId);
        // One person, one like: a site like the same person also reacted with becomes the Discord
        // one, or Discord would show it twice (reaction plus the like note).
        const like = q(
          "INSERT INTO likes (image_id, user_id, source, created) VALUES (?, ?, 'discord', ?) ON CONFLICT (image_id, user_id) DO UPDATE SET source = 'discord'",
        );
        for (const u of users) like.run(imageId, u, now());
        q("DELETE FROM comments WHERE image_id = ? AND source = 'discord'").run(imageId);
        const comment = q(
          "INSERT INTO comments (image_id, user_id, name, avatar, body, source, discord_msg_id, created) VALUES (?, ?, ?, ?, ?, 'discord', ?, ?)",
        );
        for (const { m, body } of replies)
          comment.run(
            imageId,
            m.author.id,
            displayName(m.member?.nick, m.author.global_name, m.author.username).slice(0, 64),
            avatarUrl(m.author.id, m.author, null, guildId),
            body,
            m.id,
            Date.parse(m.timestamp) || snowflakeTime(m.id),
          );
        // A mirrored site comment removed in Discord (by staff or the author's report) goes on the
        // site too. Only messages older than this fetch count: one sent meanwhile isn't in the list yet.
        if (!inThread) continue;
        const gone = q(
          "SELECT id, discord_msg_id FROM comments WHERE image_id = ? AND source = 'site' AND deleted_by IS NULL AND discord_msg_id GLOB '[0-9]*'",
        )
          .all(imageId)
          .filter((c) => !inThread.has(c.discord_msg_id) && snowflakeTime(c.discord_msg_id) < fetchedAt);
        for (const c of gone)
          q("UPDATE comments SET deleted_by = 'discord', deleted_at = ?, discord_msg_id = NULL WHERE id = ?").run(
            now(),
            c.id,
          );
      }
    });
  }

  // ---------- Site -> Discord ----------
  //
  // discord_msg_id of a site comment: NULL = not sent yet, "-" = will never be sent (post
  // gone, thread locked), digits = the webhook message. A deleted comment that still has
  // digits waits for its Discord message to be removed. Both queues are retried on every
  // sync, so a Discord outage only delays.

  // Webhooks created by the bot, one per channel, found again after a restart.
  async function webhook(channelId) {
    const cached = state.webhooks.get(channelId);
    if (cached) return cached;
    state.botId ??= (await botJson("/users/@me")).id;
    let hook = ((await botJson(`/channels/${channelId}/webhooks`)) ?? []).find(
      (w) => w.user?.id === state.botId && w.token,
    );
    if (!hook) {
      const res = await botWrite("POST", `/channels/${channelId}/webhooks`, { name: WEBHOOK_NAME });
      if (!res.ok) throw new Error(`discord ${res.status} creating webhook`);
      hook = await res.json();
    }
    state.webhooks.set(channelId, `${hook.id}/${hook.token}`);
    return state.webhooks.get(channelId);
  }

  // The post's thread, started by the bot when nobody has yet. Null when the post is gone.
  // Named after the post's text, else its author: image titles are mostly file names.
  async function thread(channelId, messageId) {
    const msg = await botJson(`/channels/${channelId}/messages/${messageId}`);
    if (!msg || msg.thread) return msg?.thread ?? null;
    const text = (msg.content ?? "").replace(/<[^>]*>|https?:\/\/\S+/g, "").split("\n")[0].trim();
    const by = displayName(msg.author?.global_name, msg.author?.username);
    const shots = (msg.attachments?.length ?? 0) > 1 ? "Screenshots" : "Screenshot";
    const res = await botWrite("POST", `/channels/${channelId}/messages/${messageId}/threads`, {
      name: (text || (by ? `${shots} by ${by}` : "Comments")).slice(0, 100),
      auto_archive_duration: 10080,
    });
    if (res.ok) return res.json();
    // 160004: someone opened a thread in Discord a moment earlier.
    if ((await errorCode(res)) === 160004)
      return (await botJson(`/channels/${channelId}/messages/${messageId}`))?.thread ?? null;
    throw new Error(`discord ${res.status} creating thread`);
  }

  // Webhook names can't contain "discord" or "clyde" and are at most 80 characters.
  // Repeated, because removing one can join the rest into a new one ("disdiscordcord").
  function webhookName(name) {
    let clean = name;
    while (/discord|clyde/i.test(clean)) clean = clean.replace(/discord|clyde/gi, "");
    return (clean.replace(/\s+/g, " ").trim() || "Someone").slice(0, 80 - VIA.length) + VIA;
  }

  const setMsg = (id, value) => q("UPDATE comments SET discord_msg_id = ? WHERE id = ?").run(value, id);

  async function deliver(c) {
    const t = await thread(c.channel_id, c.message_id);
    // Archived threads reopen on their own when the webhook posts; locked ones stay closed.
    if (!t || t.thread_metadata?.locked) return setMsg(c.id, "-");
    const hook = await webhook(c.channel_id);
    const res = await discord(`/webhooks/${hook}?wait=true&thread_id=${t.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: webhookName(c.name),
        avatar_url: c.avatar ?? undefined,
        content: `${discordText(c.body)}\n-# [View in the gallery](<${origin}/#img-${c.image_id}>)`,
        allowed_mentions: { parse: [] },
        flags: NO_EMBEDS,
      }),
    });
    if (res.ok) {
      // The comment may have been deleted on the site while this was in flight; then the
      // delete queue picks the new message up on the next run.
      setMsg(c.id, (await res.json()).id);
      return;
    }
    const code = await errorCode(res);
    // 10015: someone deleted the webhook; the next run makes a new one.
    if (code === 10015) state.webhooks.delete(c.channel_id);
    else if (res.status === 400 || res.status === 404) {
      console.warn(`[mirror] comment ${c.id} not sent: discord ${res.status}/${code}`);
      return setMsg(c.id, "-");
    }
    throw new Error(`discord ${res.status}/${code} sending comment ${c.id}`);
  }

  // The bot (Manage Messages) deletes, not the webhook: that also works after the webhook was replaced.
  async function unsend(c) {
    const res = await botWrite("DELETE", `/channels/${c.message_id}/messages/${c.discord_msg_id}`);
    // 404: the message or the whole thread is already gone.
    if (!res.ok && res.status !== 404) throw new Error(`discord ${res.status} deleting comment ${c.id}`);
    setMsg(c.id, null);
  }

  // Unliking a Discord like takes the reaction off the post, or the next sync brings it back.
  // We don't know which like emoji the user picked, so every one on the post goes.
  // Returns false when Discord refused; the like then stays.
  async function unreact(imageId, userId) {
    const post = q("SELECT channel_id, message_id FROM image_posts WHERE image_id = ?").get(imageId);
    if (!post) return true;
    const path = `/channels/${post.channel_id}/messages/${post.message_id}`;
    const msg = await botJson(path);
    for (const r of msg?.reactions ?? []) {
      if (!likeEmojis.has(bareEmoji(r.emoji.name ?? ""))) continue;
      const emoji = encodeURIComponent(r.emoji.id ? `${r.emoji.name}:${r.emoji.id}` : r.emoji.name);
      const res = await botWrite("DELETE", `${path}/reactions/${emoji}/${userId}`);
      // 404: reaction or message already gone.
      if (!res.ok && res.status !== 404) {
        console.warn(`[unlike] image ${imageId}: discord ${res.status}/${await errorCode(res)}`);
        return false;
      }
    }
    // The reaction counted for every image of the post.
    q(
      "DELETE FROM likes WHERE user_id = ? AND source = 'discord' AND image_id IN (SELECT image_id FROM image_posts WHERE message_id = ?)",
    ).run(userId, post.message_id);
    return true;
  }

  // ---------- Site likes -> the like note ----------
  //
  // A bot can't react for someone else, so the post's thread gets one bot message that counts
  // the site likes, without names (the privacy policy promises counts only). Discord reactions
  // sit on the post already and are not counted again. kv "likenote:<post>" = {id, text}; id "-"
  // means no thread to post in (post gone, thread locked), tried again once the text changes.

  const imageLink = (id) => `<${origin}/#img-${id}>`;
  function likeText(images) {
    const liked = images.filter((i) => i.n > 0);
    if (images.length === 1)
      return liked.length ? `-# ❤️ ${liked[0].n} like${liked[0].n === 1 ? "" : "s"} in the gallery · [View](${imageLink(liked[0].image_id)})` : "";
    // Numbered, not titled: titles are mostly file names, and Discord shows escapes in link text verbatim.
    return liked.map((i) => `-# [Image ${images.indexOf(i) + 1}](${imageLink(i.image_id)}) · ❤️ ${i.n}`).join("\n");
  }

  async function likeNote(p) {
    const key = `likenote:${p.message_id}`;
    const text = likeText(p.images);
    const note = JSON.parse(kvGet(key) ?? "null");
    if ((note?.text ?? "") === text) return;
    const drop = () => q("DELETE FROM kv WHERE key = ?").run(key);
    // A thread started from a message shares its ID.
    const path = note && `/channels/${p.message_id}/messages/${note.id}`;
    if (note && note.id !== "-") {
      if (!text) {
        const res = await botWrite("DELETE", path);
        // 404: the message or the whole thread is already gone.
        if (!res.ok && res.status !== 404) throw new Error(`discord ${res.status} deleting like note ${p.message_id}`);
        return drop();
      }
      let res = await botWrite("PATCH", path, { content: text });
      // 50083: archived threads take no edits; reopening needs only Send Messages in Threads.
      if (!res.ok && (await errorCode(res)) === 50083) {
        await botWrite("PATCH", `/channels/${p.message_id}`, { archived: false });
        res = await botWrite("PATCH", path, { content: text });
      }
      if (res.ok) return kvSet(key, JSON.stringify({ id: note.id, text }));
      // 404: someone deleted the note; a new one goes out below. Anything else (thread locked)
      // leaves the old note as it is.
      if (res.status !== 404) {
        console.warn(`[likes] post ${p.message_id}: discord ${res.status} editing the like note`);
        return kvSet(key, JSON.stringify({ id: "-", text }));
      }
    }
    if (!text) return drop();
    const t = await thread(p.channel_id, p.message_id);
    if (!t || t.thread_metadata?.locked) return kvSet(key, JSON.stringify({ id: "-", text }));
    // Archived threads reopen on their own when the bot posts.
    const res = await botWrite("POST", `/channels/${t.id}/messages`, {
      content: text,
      allowed_mentions: { parse: [] },
      flags: NO_EMBEDS,
    });
    if (!res.ok) throw new Error(`discord ${res.status}/${await errorCode(res)} sending like note ${p.message_id}`);
    kvSet(key, JSON.stringify({ id: (await res.json()).id, text }));
  }

  // ponytail: one SQL pass per run, Discord only where the text changed; failures are logged
  // and retried next run, no alert of their own (GalleryMirrorBacklog counts comments only).
  // rowid order is the order of the summary's delete links, which is the order of the attachments.
  async function likeNotes() {
    const posts = new Map();
    for (const r of q(
      `SELECT p.channel_id, p.message_id, p.image_id, COUNT(l.user_id) AS n FROM image_posts p
       LEFT JOIN likes l ON l.image_id = p.image_id AND l.source = 'site'
       GROUP BY p.image_id ORDER BY p.rowid`,
    ).all()) {
      if (!posts.has(r.message_id)) posts.set(r.message_id, { channel_id: r.channel_id, message_id: r.message_id, images: [] });
      posts.get(r.message_id).images.push(r);
    }
    for (const p of posts.values()) await likeNote(p).catch((err) => console.error("[likes]", err.message));
  }

  const outbox = (deleted, since = 0) =>
    q(
      `SELECT c.id, c.image_id, c.name, c.avatar, c.body, c.discord_msg_id, c.created, p.channel_id, p.message_id
       FROM comments c JOIN image_posts p USING (image_id)
       WHERE c.source = 'site' AND ${
         deleted
           ? "c.deleted_by IS NOT NULL AND c.discord_msg_id GLOB '[0-9]*'"
           : "c.deleted_by IS NULL AND c.discord_msg_id IS NULL AND c.created > ?"
       } ORDER BY c.id`,
    ).all(...(deleted ? [] : [since]));

  // One run at a time; a call during a run asks for one more pass and waits for it.
  // One comment failing doesn't hold up the others; it is retried next time.
  let running = null;
  let again = false;
  function mirror() {
    if (!env.DISCORD_BOT_TOKEN) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    // .finally() and not try/finally: a run without work finishes synchronously, and the
    // reset would then happen before the assignment and leave `running` set for good.
    running = (async () => {
      do {
        again = false;
        for (const c of outbox(false, now() - MIRROR_WINDOW))
          await deliver(c).catch((err) => console.error("[mirror]", err.message));
        for (const c of outbox(true)) await unsend(c).catch((err) => console.error("[mirror]", err.message));
        await likeNotes();
      } while (again);
    })().finally(() => {
      running = null;
    });
    return running;
  }

  // Right after a write, without waiting for it; whatever fails here the next sync retries.
  const kick = () => mirror().catch((err) => console.error("[mirror]", err.message));

  // What has waited too long for Discord, either way.
  const mirrorBacklog = () => {
    if (!env.DISCORD_BOT_TOKEN) return 0;
    const late = now() - MIRROR_LATE;
    return (
      outbox(false, now() - MIRROR_WINDOW).filter((c) => c.created < late).length +
      q(
        "SELECT COUNT(*) AS n FROM comments WHERE source = 'site' AND deleted_by IS NOT NULL AND discord_msg_id GLOB '[0-9]*' AND deleted_at < ?",
      ).get(late).n
    );
  };

  const isStaff = (member) => ((member.roles ?? []).some((r) => staffRoles.has(r)) ? 1 : 0);
  const timedOut = (member) => Date.parse(member.communication_disabled_until ?? "") > now();

  // Login checks membership, timeout and staff role once; this checks them again on every
  // sync, so leaving the guild, a timeout or a lost role ends the session within 10 minutes.
  // A Discord error keeps the session: an outage should not log everybody out.
  // ponytail: one GET per logged-in user and run, bounded by Discord's rate limit; stagger past a few hundred sessions.
  async function recheckSessions() {
    for (const { user_id: id } of q("SELECT DISTINCT user_id FROM sessions WHERE expires > ?").all(now())) {
      try {
        const member = await botJson(`/guilds/${guildId}/members/${id}`);
        if (!member || member.pending || timedOut(member)) q("DELETE FROM sessions WHERE user_id = ?").run(id);
        else q("UPDATE sessions SET is_staff = ? WHERE user_id = ?").run(isStaff(member), id);
      } catch (err) {
        console.error("[recheck]", err.message);
      }
    }
  }

  // Recent posts every run, all of them once a day.
  async function sync() {
    if (!env.DISCORD_BOT_TOKEN || state.syncing) return;
    state.syncing = true;
    try {
      const full = now() - state.lastFullSync > DAY;
      for (const channel of channels) await scanChannel(channel);
      const posts = q("SELECT DISTINCT channel_id, message_id FROM image_posts").all();
      for (const p of posts)
        if (full || now() - snowflakeTime(p.message_id) < RECENT) await syncPost(p.channel_id, p.message_id);
      await recheckSessions();
      await mirror();
      state.lastSync = now();
      if (full) state.lastFullSync = now();
    } catch (err) {
      console.error("[sync]", err.message);
    } finally {
      state.syncing = false;
    }
  }

  async function refreshImages() {
    try {
      const res = await fetch(`${env.IMAGES_URL || `${origin}/images.json`}?t=${now()}`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`images.json ${res.status}`);
      const images = (await res.json()).filter((i) => IMAGE_ID.test(String(i.id)));
      state.images = new Map(images.map((i) => [String(i.id), String(i.title ?? "")]));
    } catch (err) {
      console.error("[images]", err.message);
    }
  }

  // A consistent copy for the offsite pull; the live file is never what gets backed up.
  // Runs from a timer: a failed backup must be logged (and show up as stale), not kill the API.
  function housekeeping() {
    try {
      q("DELETE FROM sessions WHERE expires < ?").run(now());
      q("DELETE FROM comments WHERE deleted_at < ?").run(now() - PURGE_DELETED);
      for (const [key, h] of hits) if (now() - h.times.at(-1) >= h.windowMs) hits.delete(key);
      for (const [key, p] of pendingLogins) if (p.expires <= now()) pendingLogins.delete(key);
      if (!env.BACKUP_PATH) return;
      const day = new Date(now()).toISOString().slice(0, 10);
      if (kvGet("backup_day") === day) return;
      mkdirSync(dirname(env.BACKUP_PATH), { recursive: true });
      rmSync(env.BACKUP_PATH, { force: true });
      db.exec(`VACUUM INTO '${env.BACKUP_PATH.replaceAll("'", "''")}'`);
      kvSet("backup_day", day);
    } catch (err) {
      console.error("[housekeeping]", err.message);
    }
  }

  function notifyStaff(imageId, name, body) {
    if (!env.STAFF_WEBHOOK_URL) return;
    fetch(env.STAFF_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: `💬 **${discordText(name)}** commented on <${origin}/#img-${imageId}>:\n>>> ${discordText(body)}`.slice(
          0,
          1900,
        ),
        allowed_mentions: { parse: [] },
        flags: NO_EMBEDS,
      }),
    }).catch((err) => console.error("[webhook]", err.message));
  }

  // ---------- HTTP ----------

  function send(res, status, body, cache = "no-store", headers = {}) {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cache,
      "X-Content-Type-Options": "nosniff",
      ...headers,
    });
    res.end(JSON.stringify(body));
  }

  function redirect(res, location, cookies = []) {
    res.writeHead(302, { Location: location, "Cache-Control": "no-store", "Set-Cookie": cookies });
    res.end();
  }

  function cookies(req) {
    const out = {};
    for (const part of (req.headers.cookie ?? "").split(";")) {
      const i = part.indexOf("=");
      if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return out;
  }

  const cookie = (name, value, maxAge) =>
    `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

  function session(req) {
    const token = cookies(req)[SESSION_COOKIE];
    if (!token) return null;
    return q("SELECT * FROM sessions WHERE token_hash = ? AND expires > ?").get(sha256(token), now()) ?? null;
  }

  async function readJson(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw Object.assign(new Error("too large"), { status: 413 });
      chunks.push(chunk);
    }
    let value;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {}
    // "null" or "1" parse fine but are no request body.
    if (!value || typeof value !== "object") throw Object.assign(new Error("bad json"), { status: 400 });
    return value;
  }

  const clientIp = (req) => ipKey(req.headers["cf-connecting-ip"] || req.socket.remoteAddress);

  const likeCount = (imageId) => q("SELECT COUNT(*) AS n FROM likes WHERE image_id = ?").get(imageId).n;

  async function login(req, res, url) {
    if (limited(`login:${clientIp(req)}`, 10, MIN) || pendingLogins.size >= MAX_PENDING)
      return send(res, 429, { error: "rate_limited" });
    const img = url.searchParams.get("img") ?? "";
    const stateToken = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const params = new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "identify guilds.members.read",
      state: stateToken,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    pendingLogins.set(stateToken, { verifier, img: IMAGE_ID.test(img) ? img : "", expires: now() + 10 * MIN });
    // The cookie ties the state to this browser (login CSRF); everything else stays here.
    redirect(res, `https://discord.com/oauth2/authorize?${params}`, [cookie(OAUTH_COOKIE, stateToken, 600)]);
  }

  async function callback(req, res, url) {
    const stateToken = cookies(req)[OAUTH_COOKIE] ?? "";
    const pending = pendingLogins.get(stateToken);
    pendingLogins.delete(stateToken);
    const img = pending?.img ?? "";
    const clear = cookie(OAUTH_COOKIE, "", 0);
    const back = (status) => redirect(res, `/?login=${status}${img ? `#img-${img}` : ""}`, [clear]);
    const code = url.searchParams.get("code");
    if (!pending || pending.expires <= now() || !code || url.searchParams.get("state") !== stateToken)
      return back("failed");
    // Each callback costs a token exchange at Discord, and too many get the server's IP blocked there.
    if (limited(`callback:${clientIp(req)}`, 10, MIN) || limited("oauth-token", 30, MIN)) return back("failed");

    // No 429 retry (tries 0) while a person is waiting for the redirect.
    const tokenRes = await discord(
      "/oauth2/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: env.DISCORD_CLIENT_ID,
          client_secret: env.DISCORD_CLIENT_SECRET,
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          code_verifier: pending.verifier,
        }),
      },
      0,
    );
    if (!tokenRes.ok) return back("failed");
    const { access_token: accessToken } = await tokenRes.json();
    // The access token is used for this one call and never stored.
    const memberRes = await discord(
      `/users/@me/guilds/${guildId}/member`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      0,
    );
    if (memberRes.status === 404) return back("not-member");
    if (!memberRes.ok) return back("failed");
    const member = await memberRes.json();
    if (member.pending) return back("not-member");
    if (timedOut(member)) return back("timed-out");

    const user = member.user;
    const token = b64url(randomBytes(32));
    q("INSERT INTO sessions (token_hash, user_id, name, avatar, is_staff, expires) VALUES (?, ?, ?, ?, ?, ?)").run(
      sha256(token),
      user.id,
      displayName(member.nick, user.global_name, user.username).slice(0, 64),
      avatarUrl(user.id, user, member, guildId),
      isStaff(member),
      now() + SESSION_TTL,
    );
    redirect(res, img ? `/#img-${img}` : "/", [clear, cookie(SESSION_COOKIE, token, SESSION_TTL / 1000)]);
  }

  async function route(req, res) {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method;

    if (method === "GET" && path === "/api/health")
      return send(res, 200, {
        ok: true,
        images: state.images.size,
        lastSync: state.lastSync,
        mirrorBacklog: mirrorBacklog(),
      });

    if (method === "GET" && path === "/api/stats") {
      const stats = {};
      for (const r of q("SELECT image_id, COUNT(*) AS n FROM likes GROUP BY image_id").all())
        stats[r.image_id] = { likes: r.n, comments: 0 };
      for (const r of q("SELECT image_id, COUNT(*) AS n FROM comments WHERE deleted_by IS NULL GROUP BY image_id").all())
        stats[r.image_id] = { likes: stats[r.image_id]?.likes ?? 0, comments: r.n };
      return send(res, 200, stats, "public, max-age=30");
    }

    if (method === "GET" && path === "/api/login") return login(req, res, url);
    if (method === "GET" && path === "/api/callback") return callback(req, res, url);

    const sess = session(req);

    if (method === "GET" && path === "/api/me") {
      // 200, not 401: every guest asks once per page view, and a 401 lands in the
      // console as an error (Lighthouse "Best Practices").
      if (!sess) return send(res, 200, { user: null, liked: [] });
      const liked = q("SELECT image_id FROM likes WHERE user_id = ?")
        .all(sess.user_id)
        .map((r) => r.image_id);
      return send(res, 200, { user: { name: sess.name, avatar: sess.avatar, staff: !!sess.is_staff }, liked });
    }

    const commentsMatch = path.match(/^\/api\/images\/([^/]+)\/comments$/);
    if (method === "GET" && commentsMatch) {
      const imageId = commentsMatch[1];
      if (!state.images.has(imageId)) return send(res, 404, { error: "unknown_image" });
      const rows = q(
        "SELECT id, user_id, name, avatar, body, source, created FROM comments WHERE image_id = ? AND deleted_by IS NULL ORDER BY created, id",
      ).all(imageId);
      return send(
        res,
        200,
        rows.map((r) => ({
          id: r.id,
          name: r.name,
          avatar: r.avatar,
          body: r.body,
          source: r.source,
          created: r.created,
          // Discord replies are moderated in Discord; the next sync would bring them back anyway.
          canDelete: r.source === "site" && !!sess && (sess.user_id === r.user_id || !!sess.is_staff),
        })),
      );
    }

    if (method !== "POST" && method !== "DELETE") return send(res, 404, { error: "not_found" });

    // CSRF: browsers always send Origin on POST/DELETE; SameSite=Lax is the second layer.
    if (req.headers.origin !== origin) return send(res, 403, { error: "bad_origin" });

    if (method === "POST" && path === "/api/logout") {
      if (sess) q("DELETE FROM sessions WHERE token_hash = ?").run(sess.token_hash);
      return send(res, 200, { ok: true }, "no-store", { "Set-Cookie": cookie(SESSION_COOKIE, "", 0) });
    }

    if (!sess) return send(res, 401, { error: "login_required" });

    const likeMatch = path.match(/^\/api\/images\/([^/]+)\/like$/);
    if (method === "POST" && likeMatch) {
      const imageId = likeMatch[1];
      if (!state.images.has(imageId)) return send(res, 404, { error: "unknown_image" });
      if (limited(`like:${sess.user_id}`, 60, MIN)) return send(res, 429, { error: "rate_limited" });
      const had = q("SELECT source FROM likes WHERE image_id = ? AND user_id = ?").get(imageId, sess.user_id);
      if (had?.source === "discord" && !(await unreact(imageId, sess.user_id).catch(() => false)))
        return send(res, 409, { error: "discord_unlike_failed", liked: true, likes: likeCount(imageId) });
      if (had) q("DELETE FROM likes WHERE image_id = ? AND user_id = ?").run(imageId, sess.user_id);
      else
        q("INSERT INTO likes (image_id, user_id, source, created) VALUES (?, ?, 'site', ?)").run(
          imageId,
          sess.user_id,
          now(),
        );
      kick();
      return send(res, 200, { liked: !had, likes: likeCount(imageId) });
    }

    if (method === "POST" && commentsMatch) {
      const imageId = commentsMatch[1];
      if (!state.images.has(imageId)) return send(res, 404, { error: "unknown_image" });
      const input = await readJson(req);
      const body = String(input.body ?? "")
        .replace(UNSAFE_CHARS, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      if (!body) return send(res, 400, { error: "empty" });
      if ([...body].length > MAX_COMMENT) return send(res, 413, { error: "too_long" });
      if (limited(`comment-min:${sess.user_id}`, 5, MIN) || limited(`comment-day:${sess.user_id}`, 30, DAY))
        return send(res, 429, { error: "rate_limited" });
      const created = now();
      const { lastInsertRowid } = q(
        "INSERT INTO comments (image_id, user_id, name, avatar, body, source, created) VALUES (?, ?, ?, ?, ?, 'site', ?)",
      ).run(imageId, sess.user_id, sess.name, sess.avatar, body, created);
      notifyStaff(imageId, sess.name, body);
      kick();
      return send(res, 201, {
        id: Number(lastInsertRowid),
        name: sess.name,
        avatar: sess.avatar,
        body,
        source: "site",
        created,
        canDelete: true,
      });
    }

    const deleteMatch = path.match(/^\/api\/comments\/(\d+)$/);
    if (method === "DELETE" && deleteMatch) {
      const row = q("SELECT user_id, source FROM comments WHERE id = ? AND deleted_by IS NULL").get(
        Number(deleteMatch[1]),
      );
      if (!row) return send(res, 404, { error: "not_found" });
      if (row.source !== "site" || (row.user_id !== sess.user_id && !sess.is_staff))
        return send(res, 403, { error: "forbidden" });
      q("UPDATE comments SET deleted_by = ?, deleted_at = ? WHERE id = ?").run(
        sess.user_id,
        now(),
        Number(deleteMatch[1]),
      );
      kick();
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: "not_found" });
  }

  async function handle(req, res) {
    try {
      await route(req, res);
    } catch (err) {
      if (res.headersSent) return res.end();
      if (err.status) return send(res, err.status, { error: err.message });
      console.error("[http]", err);
      send(res, 500, { error: "internal" });
    }
  }

  return { db, state, hits, handle, sync, syncPost, recheckSessions, mirror, refreshImages, housekeeping };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = { DB_PATH: "/data/gallery.db", BACKUP_PATH: "/data/backup/gallery.db", ...process.env };
  for (const key of ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "DISCORD_GUILD_ID"])
    if (!env[key]) throw new Error(`${key} is not set`);
  const app = createApp(env);
  await app.refreshImages();
  setInterval(app.refreshImages, 5 * MIN);
  setInterval(app.housekeeping, 10 * MIN);
  setInterval(app.sync, 10 * MIN);
  app.housekeeping();
  app.sync();
  const port = Number(env.PORT) || 3000;
  createServer(app.handle).listen(port, () => console.log(`gallery-api on :${port}`));
}
