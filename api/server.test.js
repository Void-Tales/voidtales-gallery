import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { createApp } from "./server.js";

const ORIGIN = "https://gallery.voidtales.win";
const GUILD = "1264616683671388252";
const STAFF_ROLE = "1264629488130723872";
const IMG = "12345678";
const IMG2 = "87654321";
const GALLERY = "1264644697155043398";
const N8N = "1404876556425494548";

// Snowflakes with a real timestamp, so the "posted within 10 minutes" check works.
const snow = (ms) => String((BigInt(ms - 1420070400000) << 22n) + 1n);
const T = Date.parse("2026-10-20T12:00:00Z");

// Fake Discord: path -> JSON (or a status number).
const discord = new Map();
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
async function fakeFetch(url, init = {}) {
  const u = new URL(url);
  if (u.pathname === "/images.json") return json([{ id: IMG }, { id: IMG2 }, { id: "default-1" }]);
  if (u.pathname === "/api/v10/oauth2/token") {
    const code = new URLSearchParams(init.body).get("code");
    return code === "bad" ? json({}, 400) : json({ access_token: `at-${code}` });
  }
  if (u.pathname === `/api/v10/users/@me/guilds/${GUILD}/member`) {
    const who = init.headers.Authorization.slice("Bearer at-".length);
    const members = {
      member: { user: { id: "100", username: "alice", avatar: null }, roles: [] },
      staff: { user: { id: "200", username: "mod", global_name: "Mod" }, roles: [STAFF_ROLE] },
      pending: { user: { id: "300", username: "new" }, roles: [], pending: true },
    };
    return members[who] ? json(members[who]) : json({ message: "Unknown Guild" }, 404);
  }
  const key = u.pathname.replace("/api/v10", "") + u.search;
  const hit = discord.get(key) ?? discord.get(u.pathname.replace("/api/v10", ""));
  if (typeof hit === "number") return json({}, hit);
  return hit ? json(hit) : json([], 200);
}

let app;
let server;
let base;

before(async () => {
  app = createApp(
    {
      PUBLIC_ORIGIN: ORIGIN,
      IMAGES_URL: "https://gallery.voidtales.win/images.json",
      DISCORD_CLIENT_ID: "test-client",
      DISCORD_CLIENT_SECRET: "secret",
      DISCORD_GUILD_ID: GUILD,
      STAFF_ROLE_IDS: STAFF_ROLE,
      DISCORD_BOT_TOKEN: "bot",
      GALLERY_CHANNEL_IDS: GALLERY,
    },
    { fetch: fakeFetch, now: () => T + 86_400_000 },
  );
  await app.refreshImages();
  server = createServer(app.handle).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function req(path, { method = "GET", cookie, origin = ORIGIN, body } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (origin && method !== "GET") headers.origin = origin;
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
}

// Full OAuth round trip against the fake Discord; returns the session cookie or the redirect.
async function login(code, img = IMG) {
  const start = await req(`/api/login?img=${img}`);
  assert.equal(start.status, 302);
  const authorize = new URL(start.headers.get("location"));
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  const oauthCookie = start.headers.getSetCookie()[0].split(";")[0];
  const cb = await req(`/api/callback?code=${code}&state=${authorize.searchParams.get("state")}`, {
    cookie: oauthCookie,
  });
  assert.equal(cb.status, 302);
  const sess = cb.headers.getSetCookie().find((c) => c.startsWith("__Host-vt_sess=") && !c.includes("Max-Age=0"));
  return { location: cb.headers.get("location"), cookie: sess?.split(";")[0] };
}

test("login: member gets a hashed session, non-members and bad state get none", async () => {
  const ok = await login("member");
  assert.equal(ok.location, `/#img-${IMG}`);
  assert.match(ok.cookie, /^__Host-vt_sess=/);
  const token = ok.cookie.split("=")[1];
  const hash = createHash("sha256").update(token).digest("hex");
  assert.ok(app.db.prepare("SELECT 1 FROM sessions WHERE token_hash = ?").get(hash));
  assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?").get(token).n, 0);

  const outsider = await login("stranger");
  assert.equal(outsider.cookie, undefined);
  assert.match(outsider.location, /login=not-member/);
  assert.equal((await login("pending")).cookie, undefined);
  assert.match((await login("bad")).location, /login=failed/);

  const forged = await req("/api/callback?code=member&state=nope", { cookie: "__Host-vt_oauth=real.v." });
  assert.match(forged.headers.get("location"), /login=failed/);
});

test("writes need Origin, then a session", async () => {
  const { cookie } = await login("member");
  assert.equal((await req(`/api/images/${IMG}/like`, { method: "POST", cookie, origin: null })).status, 403);
  assert.equal(
    (await req(`/api/images/${IMG}/like`, { method: "POST", cookie, origin: "https://evil.example" })).status,
    403,
  );
  assert.equal((await req(`/api/images/${IMG}/like`, { method: "POST" })).status, 401);
  assert.equal((await req("/api/me")).status, 401);
  assert.equal((await req("/api/x")).status, 404);
});

test("like toggles and unknown images are 404", async () => {
  const { cookie } = await login("member");
  let r = await (await req(`/api/images/${IMG2}/like`, { method: "POST", cookie })).json();
  assert.deepEqual(r, { liked: true, likes: 1 });
  r = await (await req(`/api/images/${IMG2}/like`, { method: "POST", cookie })).json();
  assert.deepEqual(r, { liked: false, likes: 0 });
  assert.equal((await req("/api/images/99999999/like", { method: "POST", cookie })).status, 404);
  assert.equal((await req("/api/images/default-1/comments")).status, 404);
});

test("comments: validation, sanitising, ownership, staff", async () => {
  const alice = (await login("member")).cookie;
  const mod = (await login("staff")).cookie;
  const post = (cookie, body) => req(`/api/images/${IMG}/comments`, { method: "POST", cookie, body: { body } });

  assert.equal((await post(alice, "   ")).status, 400);
  assert.equal((await post(alice, "x".repeat(501))).status, 413);
  assert.equal((await post(alice, "ü".repeat(500))).status, 201);
  const big = await req(`/api/images/${IMG}/comments`, { method: "POST", cookie: alice, body: { body: "x".repeat(5000) } });
  assert.equal(big.status, 413);

  const created = await (await post(alice, "hi‮there\u0000 <b>")).json();
  assert.equal(created.body, "hithere <b>");

  const modComment = await (await post(mod, "staff note")).json();
  // Alice can't delete the mod's comment, the mod can delete Alice's.
  assert.equal((await req(`/api/comments/${modComment.id}`, { method: "DELETE", cookie: alice })).status, 403);
  assert.equal((await req(`/api/comments/${created.id}`, { method: "DELETE", cookie: mod })).status, 200);
  assert.equal(app.db.prepare("SELECT deleted_by FROM comments WHERE id = ?").get(created.id).deleted_by, "200");

  // Kept for staff traceability, gone for good 30 days after deletion.
  app.housekeeping();
  assert.ok(app.db.prepare("SELECT 1 FROM comments WHERE id = ?").get(created.id));
  app.db.prepare("UPDATE comments SET deleted_at = deleted_at - ? WHERE id = ?").run(31 * 86_400_000, created.id);
  app.housekeeping();
  assert.equal(app.db.prepare("SELECT 1 FROM comments WHERE id = ?").get(created.id), undefined);

  const list = await (await req(`/api/images/${IMG}/comments`, { cookie: alice })).json();
  assert.ok(!list.some((c) => c.id === created.id));
  assert.equal(list.find((c) => c.id === modComment.id).canDelete, false);
});

test("comment rate limit: 5 per minute", async () => {
  // Fresh user so the earlier tests don't count.
  const token = "ratelimit";
  app.db
    .prepare("INSERT INTO sessions (token_hash, user_id, name, avatar, is_staff, expires) VALUES (?, '999', 'rl', NULL, 0, ?)")
    .run(createHash("sha256").update(token).digest("hex"), Date.now() * 2);
  const cookie = `__Host-vt_sess=${token}`;
  const codes = [];
  for (let i = 0; i < 6; i++)
    codes.push((await req(`/api/images/${IMG2}/comments`, { method: "POST", cookie, body: { body: `c${i}` } })).status);
  assert.deepEqual(codes, [201, 201, 201, 201, 201, 429]);
});

test("discord sync: maps summaries to posts and dedupes likes with the site", async () => {
  const post = snow(T);
  const other = snow(T - 60_000);
  const summary = snow(T + 30_000);
  const backfill = snow(T + 90_000);
  const oldPost = snow(T - 100 * 86_400_000);
  discord.set(`/channels/${GALLERY}/messages?limit=100`, [
    { id: backfill, author: { id: N8N, bot: true }, content: `📦 Backfill (<https://x/delete-image?imageId=${IMG2}>)`, message_reference: { message_id: oldPost } },
    { id: summary, author: { id: N8N, bot: true }, content: `✅ • a (by alice) — x\n [Delete](<https://n8n/webhook/delete-image?imageId=${IMG}>)` },
    { id: post, author: { id: "100", username: "alice" }, attachments: [{}] },
    { id: other, author: { id: "555", username: "bob" }, attachments: [{}] },
  ]);
  // Bob posted later than Alice here, so only the "(by alice)" check picks the right one.
  discord.set(`/channels/${GALLERY}/messages?limit=50&before=${summary}`, [
    { id: snow(T + 10_000), author: { id: "555", username: "bob" }, attachments: [{}] },
    { id: post, author: { id: "100", username: "alice" }, attachments: [{}] },
  ]);
  discord.set(`/channels/${GALLERY}/messages/${post}`, {
    id: post,
    reactions: [{ emoji: { name: "❤️" } }, { emoji: { name: "🔥" } }],
    thread: { id: post },
  });
  discord.set(`/channels/${GALLERY}/messages/${post}/reactions/${encodeURIComponent("❤️")}?limit=100`, [
    { id: "100" },
    { id: "777" },
    { id: "888", bot: true },
  ]);
  discord.set(`/channels/${post}/messages?limit=100`, [
    { id: snow(T + 5000), author: { id: "777", username: "carol" }, content: "nice!", timestamp: new Date(T + 5000).toISOString() },
    { id: snow(T + 6000), author: { id: "888", bot: true }, content: "bot noise" },
  ]);
  discord.set(`/channels/${GALLERY}/messages/${oldPost}`, 404);

  // Alice already liked IMG on the site.
  const { cookie } = await login("member");
  const me = await (await req("/api/me", { cookie })).json();
  if (!me.liked.includes(IMG)) await req(`/api/images/${IMG}/like`, { method: "POST", cookie });

  await app.sync();
  const posts = app.db.prepare("SELECT image_id, message_id FROM image_posts ORDER BY image_id").all();
  assert.deepEqual(
    posts.map((p) => ({ ...p })),
    [
      { image_id: IMG, message_id: post },
      { image_id: IMG2, message_id: oldPost },
    ],
  );

  const stats = await (await req("/api/stats")).json();
  assert.equal(stats[IMG].likes, 2, "alice (site + ❤️) once, carol once, bot not at all");
  const comments = await (await req(`/api/images/${IMG}/comments`)).json();
  const fromDiscord = comments.filter((c) => c.source === "discord");
  assert.deepEqual(fromDiscord.map((c) => [c.name, c.body, c.canDelete]), [["carol", "nice!", false]]);

  // Second run: same result, nothing duplicated; a removed reaction disappears.
  discord.set(`/channels/${GALLERY}/messages/${post}/reactions/${encodeURIComponent("❤️")}?limit=100`, [{ id: "100" }]);
  await app.syncPost(GALLERY, post);
  assert.equal((await (await req("/api/stats")).json())[IMG].likes, 1);
  assert.equal(
    app.db.prepare("SELECT COUNT(*) AS n FROM comments WHERE source = 'discord'").get().n,
    1,
  );
  // The cursor stops the next scan before already seen messages.
  assert.equal(app.db.prepare("SELECT value FROM kv WHERE key = ?").get(`cursor:${GALLERY}`).value, backfill);
});
