// gallery-api: likes and comments for gallery.voidtales.win, served under /api/ on
// the same host. No dependencies on purpose - node:http, node:sqlite, fetch.
//
// Writing needs a Discord login and membership in the Void Tales guild; reading is
// public. A timer mirrors reactions and thread replies on the original Discord
// posts into the same tables (one way: Discord -> site).

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

  const state = { images: new Set(), lastSync: 0, lastFullSync: 0, syncing: false };

  // ponytail: in-memory sliding windows, reset on restart; one process is all there is.
  const hits = new Map();
  function limited(key, max, windowMs) {
    const t = now();
    const recent = (hits.get(key) ?? []).filter((h) => t - h < windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      return true;
    }
    recent.push(t);
    hits.set(key, recent);
    return false;
  }

  // ---------- Discord ----------

  async function discord(path, init = {}, tries = 3) {
    const res = await fetch(DISCORD + path, { ...init, headers: { "User-Agent": UA, ...init.headers } });
    if (res.status === 429 && tries > 0) {
      const body = await res.json().catch(() => ({}));
      await sleep((Number(body.retry_after) || 1) * 1000 + 250);
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
    const msg = await botJson(`/channels/${channelId}/messages/${messageId}`);
    const users = new Set();
    const replies = [];
    if (msg) {
      for (const r of msg.reactions ?? []) {
        if (!likeEmojis.has(bareEmoji(r.emoji.name ?? ""))) continue;
        const emoji = encodeURIComponent(r.emoji.id ? `${r.emoji.name}:${r.emoji.id}` : r.emoji.name);
        for (const u of await pages(`/channels/${channelId}/messages/${messageId}/reactions/${emoji}`, "after"))
          if (!u.bot) users.add(u.id);
      }
      // A thread started from a message shares its ID.
      if (msg.thread) {
        for (const m of await pages(`/channels/${msg.thread.id}/messages`, "before")) {
          const body = (m.content ?? "").replace(UNSAFE_CHARS, "").trim().slice(0, 2000);
          if (m.author?.bot || !body) continue;
          replies.push({ m, body });
        }
      }
    }
    // Deleted in Discord (msg null, or reaction/reply gone) disappears here too.
    tx(() => {
      for (const imageId of imageIds) {
        q("DELETE FROM likes WHERE image_id = ? AND source = 'discord'").run(imageId);
        const like = q("INSERT OR IGNORE INTO likes (image_id, user_id, source, created) VALUES (?, ?, 'discord', ?)");
        for (const u of users) like.run(imageId, u, now());
        q("DELETE FROM comments WHERE image_id = ? AND source = 'discord'").run(imageId);
        const comment = q(
          "INSERT INTO comments (image_id, user_id, name, avatar, body, source, discord_msg_id, created) VALUES (?, ?, ?, ?, ?, 'discord', ?, ?)",
        );
        for (const { m, body } of replies)
          comment.run(
            imageId,
            m.author.id,
            m.member?.nick || m.author.global_name || m.author.username,
            avatarUrl(m.author.id, m.author, null, guildId),
            body,
            m.id,
            Date.parse(m.timestamp) || snowflakeTime(m.id),
          );
      }
    });
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
      const res = await fetch(`${env.IMAGES_URL || `${origin}/images.json`}?t=${now()}`);
      if (!res.ok) throw new Error(`images.json ${res.status}`);
      const ids = (await res.json()).map((i) => String(i.id)).filter((id) => IMAGE_ID.test(id));
      state.images = new Set(ids);
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
        content: `💬 **${name}** commented on <${origin}/#img-${imageId}>:\n>>> ${body}`.slice(0, 1900),
        allowed_mentions: { parse: [] },
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
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      throw Object.assign(new Error("bad json"), { status: 400 });
    }
  }

  const clientIp = (req) => req.headers["cf-connecting-ip"] || req.socket.remoteAddress;

  const likeCount = (imageId) => q("SELECT COUNT(*) AS n FROM likes WHERE image_id = ?").get(imageId).n;

  async function login(req, res, url) {
    if (limited(`login:${clientIp(req)}`, 10, MIN)) return send(res, 429, { error: "rate_limited" });
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
    const back = IMAGE_ID.test(img) ? img : "";
    redirect(res, `https://discord.com/oauth2/authorize?${params}`, [
      cookie(OAUTH_COOKIE, `${stateToken}.${verifier}.${back}`, 600),
    ]);
  }

  async function callback(req, res, url) {
    const [stateToken, verifier, img] = (cookies(req)[OAUTH_COOKIE] ?? "").split(".");
    const clear = cookie(OAUTH_COOKIE, "", 0);
    const back = (status) => redirect(res, `/?login=${status}${img ? `#img-${img}` : ""}`, [clear]);
    const code = url.searchParams.get("code");
    if (!stateToken || !code || url.searchParams.get("state") !== stateToken) return back("failed");

    const tokenRes = await discord("/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID,
        client_secret: env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    });
    if (!tokenRes.ok) return back("failed");
    const { access_token: accessToken } = await tokenRes.json();
    // The access token is used for this one call and never stored.
    const memberRes = await discord(`/users/@me/guilds/${guildId}/member`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (memberRes.status === 404) return back("not-member");
    if (!memberRes.ok) return back("failed");
    const member = await memberRes.json();
    if (member.pending) return back("not-member");

    const user = member.user;
    const token = b64url(randomBytes(32));
    q("INSERT INTO sessions (token_hash, user_id, name, avatar, is_staff, expires) VALUES (?, ?, ?, ?, ?, ?)").run(
      sha256(token),
      user.id,
      (member.nick || user.global_name || user.username).slice(0, 64),
      avatarUrl(user.id, user, member, guildId),
      (member.roles ?? []).some((r) => staffRoles.has(r)) ? 1 : 0,
      now() + SESSION_TTL,
    );
    redirect(res, img ? `/#img-${img}` : "/", [clear, cookie(SESSION_COOKIE, token, SESSION_TTL / 1000)]);
  }

  async function route(req, res) {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method;

    if (method === "GET" && path === "/api/health")
      return send(res, 200, { ok: true, images: state.images.size, lastSync: state.lastSync });

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
      if (!sess) return send(res, 401, { user: null });
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
      const removed = q("DELETE FROM likes WHERE image_id = ? AND user_id = ?").run(imageId, sess.user_id);
      if (removed.changes === 0)
        q("INSERT INTO likes (image_id, user_id, source, created) VALUES (?, ?, 'site', ?)").run(
          imageId,
          sess.user_id,
          now(),
        );
      return send(res, 200, { liked: removed.changes === 0, likes: likeCount(imageId) });
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

  return { db, state, handle, sync, syncPost, refreshImages, housekeeping };
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
