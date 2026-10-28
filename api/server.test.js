import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { createApp, ipKey } from "./server.js";

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
const MIN = 60_000;
const DAY = 86_400_000;
// The API's clock; tests that move it put it back.
let clock = T + DAY;

// Fake Discord: path -> JSON (or a status number). Writes are recorded and answered by onWrite.
const discord = new Map();
const writes = [];
let onWrite = () => json({}, 404);
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
let tokenRequests = 0;
const staffPosts = [];
async function fakeFetch(url, init = {}) {
  const u = new URL(url);
  if (u.pathname === "/images.json") return json([{ id: IMG }, { id: IMG2 }, { id: "default-1" }]);
  if (u.hostname === "staff.example") {
    staffPosts.push(JSON.parse(init.body));
    return new Response(null, { status: 204 });
  }
  if (u.pathname === "/api/v10/oauth2/token") {
    tokenRequests++;
    const code = new URLSearchParams(init.body).get("code");
    return code === "bad" ? json({}, 400) : json({ access_token: `at-${code}` });
  }
  if (u.pathname === `/api/v10/users/@me/guilds/${GUILD}/member`) {
    const who = init.headers.Authorization.slice("Bearer at-".length);
    const members = {
      member: { user: { id: "100", username: "alice", avatar: null }, roles: [] },
      staff: { user: { id: "200", username: "mod", global_name: "Mod" }, roles: [STAFF_ROLE] },
      pending: { user: { id: "300", username: "new" }, roles: [], pending: true },
      muted: {
        user: { id: "400", username: "loud" },
        roles: [],
        communication_disabled_until: new Date(T + 2 * DAY).toISOString(),
      },
    };
    return members[who] ? json(members[who]) : json({ message: "Unknown Guild" }, 404);
  }
  const key = u.pathname.replace("/api/v10", "") + u.search;
  if (init.method && init.method !== "GET") {
    const body = init.body ? JSON.parse(init.body) : undefined;
    writes.push({ method: init.method, path: key, body });
    return onWrite(init.method, key, body);
  }
  const hit = discord.get(key) ?? discord.get(u.pathname.replace("/api/v10", ""));
  if (typeof hit === "number") return json({}, hit);
  return hit ? json(hit) : json([], 200);
}

// What the bot sees in the guild; the sync checks every session against it.
discord.set(`/guilds/${GUILD}/members/100`, { user: { id: "100" }, roles: [] });
discord.set(`/guilds/${GUILD}/members/200`, { user: { id: "200" }, roles: [STAFF_ROLE] });
discord.set(`/guilds/${GUILD}/members/999`, { user: { id: "999" }, roles: [] });

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
      STAFF_WEBHOOK_URL: "https://staff.example/hook",
    },
    { fetch: fakeFetch, now: () => clock },
  );
  await app.refreshImages();
  server = createServer(app.handle).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function req(path, { method = "GET", cookie, origin = ORIGIN, body, ip } = {}) {
  const headers = {};
  if (ip) headers["cf-connecting-ip"] = ip;
  if (cookie) headers.cookie = cookie;
  if (origin && method !== "GET") headers.origin = origin;
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
}

// Full OAuth round trip against the fake Discord; returns the session cookie or the redirect.
// Every login from its own address: the clock stands still, so they'd all share one minute.
let logins = 0;
async function login(code, img = IMG) {
  const ip = `10.0.0.${++logins}`;
  const start = await req(`/api/login?img=${img}`, { ip });
  assert.equal(start.status, 302);
  const authorize = new URL(start.headers.get("location"));
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  const oauthCookie = start.headers.getSetCookie()[0].split(";")[0];
  const cb = await req(`/api/callback?code=${code}&state=${authorize.searchParams.get("state")}`, {
    cookie: oauthCookie,
    ip,
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

  const forged = await req("/api/callback?code=member&state=nope", { cookie: "__Host-vt_oauth=real" });
  assert.match(forged.headers.get("location"), /login=failed/);

  const muted = await login("muted");
  assert.equal(muted.cookie, undefined);
  assert.match(muted.location, /login=timed-out/);
});

test("callback: a state works once and only for 10 minutes", async () => {
  const ip = "10.1.0.1";
  const start = async () => {
    const res = await req(`/api/login?img=${IMG}`, { ip });
    const state = new URL(res.headers.get("location")).searchParams.get("state");
    const cookie = res.headers.getSetCookie()[0].split(";")[0];
    // Only the state travels in the cookie; the PKCE verifier stays on the server.
    assert.equal(cookie, `__Host-vt_oauth=${state}`);
    return (code = "member") => req(`/api/callback?code=${code}&state=${state}`, { cookie, ip });
  };
  const before = tokenRequests;
  const callback = await start();
  assert.equal((await callback()).headers.get("location"), `/#img-${IMG}`);
  for (let i = 0; i < 5; i++) assert.match((await callback()).headers.get("location"), /login=failed/);
  assert.equal(tokenRequests - before, 1, "replays never reach Discord");

  const late = await start();
  clock += 10 * MIN;
  try {
    assert.match((await late()).headers.get("location"), /login=failed/);
  } finally {
    clock = T + DAY;
  }
  assert.equal(tokenRequests - before, 1);
});

test("rate limits: IPv6 by /64, keys leave with their window", async () => {
  assert.equal(ipKey("::ffff:1.2.3.4"), "1.2.3.4");
  assert.equal(ipKey("1.2.3.4"), "1.2.3.4");
  assert.equal(ipKey("2001:0DB8:0:1::5"), "2001:db8:0:1::/64");
  assert.equal(ipKey("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(ipKey("2001:db8:1:2:3:4:5:6"), "2001:db8:1:2::/64");

  const codes = [];
  for (let i = 1; i <= 11; i++) codes.push((await req("/api/login", { ip: `2001:db8:7:7::${i.toString(16)}` })).status);
  assert.deepEqual(codes, [...Array(10).fill(302), 429], "one /64, one limit");
  assert.equal((await req("/api/login", { ip: "2001:db8:7:8::1" })).status, 302, "the next /64 is someone else");

  const cookie = session("hk-daily", "700", "hk");
  assert.equal((await req(`/api/images/${IMG}/comments`, { method: "POST", cookie, body: { body: "hk" } })).status, 201);
  assert.ok(app.hits.has("login:2001:db8:7:8::/64"));
  assert.ok(app.hits.has("comment-day:700"));
  clock += MIN;
  try {
    app.housekeeping();
  } finally {
    clock = T + DAY;
  }
  assert.ok(!app.hits.has("login:2001:db8:7:8::/64"), "a one-minute key is gone after a minute");
  assert.ok(app.hits.has("comment-day:700"), "the daily one stays");
});

test("writes need Origin, then a session", async () => {
  const { cookie } = await login("member");
  assert.equal((await req(`/api/images/${IMG}/like`, { method: "POST", cookie, origin: null })).status, 403);
  assert.equal(
    (await req(`/api/images/${IMG}/like`, { method: "POST", cookie, origin: "https://evil.example" })).status,
    403,
  );
  assert.equal((await req(`/api/images/${IMG}/like`, { method: "POST" })).status, 401);
  assert.equal((await (await req("/api/me")).json()).user, null);
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

  assert.equal((await req(`/api/images/${IMG}/comments`, { method: "POST", cookie: alice, body: null })).status, 400);

  const staffBefore = staffPosts.length;
  const created = await (await post(alice, "hi‮there\u0000 <b>")).json();
  // The staff channel gets the comment as plain text, without previews or mentions.
  for (let i = 0; i < 50 && staffPosts.length === staffBefore; i++) await new Promise((r) => setTimeout(r, 2));
  assert.deepEqual(staffPosts.at(-1), {
    content: `💬 **alice** commented on <${ORIGIN}/#img-${IMG}>:\n>>> hithere \\<b\\>`,
    allowed_mentions: { parse: [] },
    flags: 4,
  });
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

// A logged-in user of its own, so no earlier test's rate limit counts.
function session(token, userId, name, avatar = null) {
  app.db
    .prepare("INSERT INTO sessions (token_hash, user_id, name, avatar, is_staff, expires) VALUES (?, ?, ?, ?, 0, ?)")
    .run(createHash("sha256").update(token).digest("hex"), userId, name, avatar, Date.now() * 2);
  return `__Host-vt_sess=${token}`;
}

test("site comments go to the post's thread and come back out", async () => {
  const BOT = "4242";
  const P2 = snow(T + 3_600_000);
  const HOOK = { id: "9001", token: "hooktoken", user: { id: BOT } };
  // Earlier tests left site comments on IMG; they are not what this test is about.
  app.db.prepare("UPDATE comments SET discord_msg_id = '-' WHERE source = 'site'").run();
  app.db.prepare("INSERT OR REPLACE INTO image_posts (image_id, channel_id, message_id) VALUES (?, ?, ?)").run(IMG2, GALLERY, P2);
  discord.set("/users/@me", { id: BOT });
  discord.set(`/channels/${GALLERY}/webhooks`, []);
  discord.set(`/channels/${GALLERY}/messages/${P2}`, { id: P2, content: "Sunset over <@1> the bay\nmore https://x.y" });

  let sent = 0;
  let sendStatus = 200;
  onWrite = (method, path, body) => {
    if (path === `/channels/${GALLERY}/messages/${P2}/threads`) {
      discord.set(`/channels/${GALLERY}/messages/${P2}`, { id: P2, thread: { id: P2, thread_metadata: {} } });
      return json({ id: P2, name: body.name });
    }
    if (path === `/channels/${GALLERY}/webhooks`) return json(HOOK);
    if (path.startsWith(`/webhooks/${HOOK.id}/${HOOK.token}?`))
      return sendStatus === 200 ? json({ id: snow(T + 86_400_000 - 1000 + sent++) }) : json({ code: sendStatus === 404 ? 10015 : 0 }, sendStatus);
    if (method === "DELETE") return new Response(null, { status: 204 });
    return json({}, 404);
  };
  const cookie = session("alice-mirror", "101", "alice");
  const comment = (body) => req(`/api/images/${IMG2}/comments`, { method: "POST", cookie, body: { body } });
  const row = (id) => app.db.prepare("SELECT discord_msg_id, deleted_by FROM comments WHERE id = ?").get(id);

  // A run without work must not leave the mirror blocked (it once did: the reset ran before the assignment).
  await app.mirror();

  // First comment: the bot opens the thread (named after the post), makes the webhook, posts as alice.
  writes.length = 0;
  const first = await (await comment("@everyone look at this")).json();
  // Sent right after the POST, not only with the next sync.
  for (let i = 0; i < 50 && !row(first.id).discord_msg_id; i++) await new Promise((r) => setTimeout(r, 2));
  assert.match(row(first.id).discord_msg_id ?? "", /^\d+$/, "sent without waiting for the sync");
  assert.deepEqual(
    writes.map((w) => `${w.method} ${w.path.split("?")[0]}`),
    [`POST /channels/${GALLERY}/messages/${P2}/threads`, `POST /channels/${GALLERY}/webhooks`, `POST /webhooks/${HOOK.id}/${HOOK.token}`],
  );
  assert.equal(writes[0].body.name, "Sunset over  the bay");
  assert.equal(writes[1].body.name, "Void Tales Gallery");
  const exec = writes[2];
  assert.equal(exec.path, `/webhooks/${HOOK.id}/${HOOK.token}?wait=true&thread_id=${P2}`);
  assert.equal(exec.body.username, "alice · via Gallery");
  assert.deepEqual(exec.body.allowed_mentions, { parse: [] }, "no @everyone from the site");
  assert.equal(exec.body.flags, 4, "no link previews");
  assert.equal(exec.body.content, `@everyone look at this\n-# [View in the gallery](<${ORIGIN}/#img-${IMG2}>)`);
  const firstMsg = row(first.id).discord_msg_id;
  assert.match(firstMsg, /^\d+$/);

  // Nothing is sent twice: the next run finds no work, the webhook is reused from memory.
  writes.length = 0;
  await app.mirror();
  assert.equal(writes.length, 0);

  // The sync sees our webhook message in the thread and neither imports nor deletes it.
  discord.set(`/channels/${P2}/messages?limit=100`, [
    { id: firstMsg, webhook_id: HOOK.id, author: { id: HOOK.id, bot: true }, content: exec.body.content },
  ]);
  await app.syncPost(GALLERY, P2);
  const mine = async () =>
    (await (await req(`/api/images/${IMG2}/comments`)).json()).filter((c) => c.id >= first.id).map((c) => [c.id, c.source]);
  assert.deepEqual(await mine(), [[first.id, "site"]]);

  // Discord is down: the comment waits, counts as backlog once it's late, and goes out on the next run.
  sendStatus = 503;
  const second = await (await comment("second")).json();
  await app.mirror();
  assert.equal(row(second.id).discord_msg_id, null);
  assert.equal((await (await req("/api/health")).json()).mirrorBacklog, 0, "not late yet");
  app.db.prepare("UPDATE comments SET created = created - ? WHERE id = ?").run(31 * 60_000, second.id);
  assert.equal((await (await req("/api/health")).json()).mirrorBacklog, 1);
  // Meanwhile someone deleted the webhook (10015): it is made again, then the comment goes out.
  sendStatus = 404;
  await app.mirror();
  assert.equal(row(second.id).discord_msg_id, null);
  sendStatus = 200;
  writes.length = 0;
  await app.mirror();
  assert.deepEqual(writes.map((w) => `${w.method} ${w.path.split("?")[0]}`), [
    `POST /channels/${GALLERY}/webhooks`,
    `POST /webhooks/${HOOK.id}/${HOOK.token}`,
  ]);
  const secondMsg = row(second.id).discord_msg_id;
  assert.match(secondMsg, /^\d+$/);
  assert.equal((await (await req("/api/health")).json()).mirrorBacklog, 0);

  // Deleted on the site: the bot removes the Discord message too.
  writes.length = 0;
  assert.equal((await req(`/api/comments/${second.id}`, { method: "DELETE", cookie })).status, 200);
  await app.mirror();
  assert.deepEqual(writes.map((w) => `${w.method} ${w.path}`), [`DELETE /channels/${P2}/messages/${secondMsg}`]);
  assert.equal(row(second.id).discord_msg_id, null);

  // Deleted in Discord: gone from the site with the next sync.
  discord.set(`/channels/${P2}/messages?limit=100`, []);
  await app.syncPost(GALLERY, P2);
  assert.deepEqual({ ...row(first.id) }, { discord_msg_id: null, deleted_by: "discord" });
  assert.deepEqual(await mine(), []);

  // A locked thread takes nothing; the comment stays on the site and is never retried.
  discord.set(`/channels/${GALLERY}/messages/${P2}`, { id: P2, thread: { id: P2, thread_metadata: { locked: true } } });
  writes.length = 0;
  const third = await (await comment("third")).json();
  await app.mirror();
  assert.equal(writes.length, 0);
  assert.equal(row(third.id).discord_msg_id, "-");
});

test("thread race and webhook names", async () => {
  const P3 = snow(T + 7_200_000);
  app.db.prepare("UPDATE comments SET discord_msg_id = '-' WHERE discord_msg_id IS NULL").run();
  app.db.prepare("INSERT OR REPLACE INTO image_posts (image_id, channel_id, message_id) VALUES (?, ?, ?)").run(IMG2, GALLERY, P3);
  discord.set(`/channels/${GALLERY}/messages/${P3}`, { id: P3, content: "" });
  onWrite = (_method, path) => {
    // Someone opened the thread in Discord in the same moment.
    if (path.endsWith("/threads")) {
      discord.set(`/channels/${GALLERY}/messages/${P3}`, { id: P3, thread: { id: P3, thread_metadata: { archived: true } } });
      return json({ code: 160004 }, 400);
    }
    if (path.startsWith("/webhooks/")) return json({ id: snow(T + 86_400_000) });
    return json({}, 404);
  };
  writes.length = 0;
  // Straight into the table and one single run: the race has to be handled in that run.
  const c = {
    id: Number(
      app.db
        .prepare("INSERT INTO comments (image_id, user_id, name, avatar, body, source, created) VALUES (?, '555', 'disDISCORDcord', 'https://cdn/x.png', ?, 'site', ?)")
        .run(IMG2, "**hi** [x](https://e.x) <@1>\n-# fake footer", T + 86_400_000).lastInsertRowid,
    ),
  };
  await app.mirror();
  const exec = writes.find((w) => w.path.startsWith("/webhooks/"));
  assert.equal(exec.path.split("thread_id=")[1], P3, "archived thread: the webhook reopens it");
  assert.equal(exec.body.username, "Someone · via Gallery", "no name left once discord is out");
  assert.equal(
    exec.body.content,
    `\\*\\*hi\\*\\* \\[x\\]\\(https://e.x\\) \\<@1\\>\n\\-\\# fake footer\n-# [View in the gallery](<${ORIGIN}/#img-${IMG2}>)`,
    "Discord shows the text the way the site does",
  );
  assert.equal(exec.body.avatar_url, "https://cdn/x.png");
  assert.match(app.db.prepare("SELECT discord_msg_id FROM comments WHERE id = ?").get(c.id).discord_msg_id, /^\d+$/);
});

test("unliking a Discord like removes the reaction there", async () => {
  const P4 = snow(T + 10_800_000);
  const heart = encodeURIComponent("❤️");
  app.db.prepare("INSERT OR REPLACE INTO image_posts (image_id, channel_id, message_id) VALUES (?, ?, ?)").run(IMG2, GALLERY, P4);
  discord.set(`/channels/${GALLERY}/messages/${P4}`, { id: P4, reactions: [{ emoji: { name: "❤️" } }, { emoji: { name: "🔥" } }] });
  discord.set(`/channels/${GALLERY}/messages/${P4}/reactions/${heart}?limit=100`, [{ id: "4711" }]);
  await app.syncPost(GALLERY, P4);
  const cookie = session("dave-unlike", "4711", "dave");
  const like = () => req(`/api/images/${IMG2}/like`, { method: "POST", cookie });
  const source = () => app.db.prepare("SELECT source FROM likes WHERE image_id = ? AND user_id = '4711'").get(IMG2)?.source;
  assert.equal(source(), "discord");

  // Discord refuses: the like stays and the site says so instead of pretending.
  onWrite = () => json({ code: 50013 }, 403);
  let res = await like();
  assert.equal(res.status, 409);
  assert.equal((await res.json()).liked, true);
  assert.equal(source(), "discord");

  // Discord agrees: only the like emoji goes, for this user, and the like with it.
  onWrite = () => new Response(null, { status: 204 });
  writes.length = 0;
  res = await like();
  assert.equal(res.status, 200);
  assert.equal((await res.json()).liked, false);
  assert.deepEqual(writes.map((w) => `${w.method} ${w.path}`), [`DELETE /channels/${GALLERY}/messages/${P4}/reactions/${heart}/4711`]);
  assert.equal(source(), undefined);

  // The next like is an ordinary site like again.
  assert.equal((await (await like()).json()).liked, true);
  assert.equal(source(), "site");
});

test("site likes show up as one bot message in the post's thread", async () => {
  const P5 = snow(T + 14_400_000);
  const NOTE = snow(T + DAY + 1);
  const NOTE2 = snow(T + DAY + 2);
  const heart = encodeURIComponent("❤️");
  // Earlier tests left site likes and posts behind; they are not what this test is about.
  app.db.prepare("DELETE FROM likes WHERE source = 'site'").run();
  app.db.prepare("DELETE FROM kv WHERE key LIKE 'likenote:%'").run();
  app.db.prepare("INSERT OR REPLACE INTO image_posts (image_id, channel_id, message_id) VALUES (?, ?, ?)").run(IMG, GALLERY, P5);
  // No text on the post: the thread is named after its author, not after an image title (file names).
  discord.set(`/channels/${GALLERY}/messages/${P5}`, { id: P5, content: "", author: { id: "100", username: "shin", global_name: "Shin" }, attachments: [{}, {}] });

  const notes = [NOTE, NOTE2];
  let edit = [];
  onWrite = (method, path) => {
    if (path === `/channels/${GALLERY}/messages/${P5}/threads`) {
      discord.set(`/channels/${GALLERY}/messages/${P5}`, { id: P5, thread: { id: P5, thread_metadata: {} } });
      return json({ id: P5 });
    }
    if (method === "POST" && path === `/channels/${P5}/messages`) return json({ id: notes.shift() });
    if (method === "PATCH" && path.startsWith(`/channels/${P5}/messages/`)) {
      const status = edit.shift() ?? 200;
      return status === 200 ? json({}) : json({ code: status === 400 ? 50083 : 10008 }, status);
    }
    return method === "DELETE" ? new Response(null, { status: 204 }) : json({});
  };
  const ana = session("ana-likes", "901", "ana");
  const ben = session("ben-likes", "902", "ben");
  const like = (cookie, img = IMG) => req(`/api/images/${img}/like`, { method: "POST", cookie });
  const sent = () => writes.map((w) => `${w.method} ${w.path}`);
  const one = `-# ❤️ 1 like in the gallery · [View](<${ORIGIN}/#img-${IMG}>)`;
  const line = (n, img, count) => `-# [Image ${n}](<${ORIGIN}/#img-${img}>) · ❤️ ${count}`;

  // First like on the site: the bot opens the thread and posts the note right away, no names, no pings.
  writes.length = 0;
  await like(ana);
  for (let i = 0; i < 50 && writes.length < 2; i++) await new Promise((r) => setTimeout(r, 2));
  assert.deepEqual(sent(), [`POST /channels/${GALLERY}/messages/${P5}/threads`, `POST /channels/${P5}/messages`]);
  assert.equal(writes[0].body.name, "Screenshots by Shin");
  assert.deepEqual(writes[1].body, { content: one, allowed_mentions: { parse: [] }, flags: 4 });

  // Nothing changed, nothing sent.
  writes.length = 0;
  await app.mirror();
  assert.equal(writes.length, 0);

  // Two images on the post: one line each, the same message edited. Each like kicks the mirror
  // itself; mirror() waits for that run, so the writes are complete afterwards. Numbered in the
  // order the images were mapped (attachment order), not by ID: here IMG2 comes first.
  const map = app.db.prepare("INSERT OR REPLACE INTO image_posts (image_id, channel_id, message_id) VALUES (?, ?, ?)");
  map.run(IMG2, GALLERY, P5);
  map.run(IMG, GALLERY, P5);
  writes.length = 0;
  await like(ben, IMG2);
  await app.mirror();
  assert.deepEqual(sent(), [`PATCH /channels/${P5}/messages/${NOTE}`]);
  assert.equal(writes[0].body.content, `${line(1, IMG2, 1)}\n${line(2, IMG, 1)}`);

  // Archived thread: reopened, then edited.
  edit = [400];
  writes.length = 0;
  await like(ben);
  await app.mirror();
  assert.deepEqual(sent(), [`PATCH /channels/${P5}/messages/${NOTE}`, `PATCH /channels/${P5}`, `PATCH /channels/${P5}/messages/${NOTE}`]);
  assert.deepEqual(writes[1].body, { archived: false });
  assert.equal(writes[2].body.content, `${line(1, IMG2, 1)}\n${line(2, IMG, 2)}`);

  // Staff deleted the note in Discord: the next change posts a new one.
  edit = [404];
  writes.length = 0;
  await like(ben, IMG2);
  await app.mirror();
  assert.deepEqual(sent(), [`PATCH /channels/${P5}/messages/${NOTE}`, `POST /channels/${P5}/messages`]);
  assert.equal(writes[1].body.content, line(2, IMG, 2));

  // Ana also reacts in Discord: one person, one like, so the note stops counting her.
  discord.set(`/channels/${GALLERY}/messages/${P5}`, { id: P5, reactions: [{ emoji: { name: "❤️" } }], thread: { id: P5, thread_metadata: {} } });
  discord.set(`/channels/${GALLERY}/messages/${P5}/reactions/${heart}?limit=100`, [{ id: "901" }]);
  await app.syncPost(GALLERY, P5);
  writes.length = 0;
  await app.mirror();
  assert.equal(writes[0].body.content, line(2, IMG, 1));
  assert.equal((await (await req("/api/stats")).json())[IMG].likes, 2, "ana once, ben once");

  // No site likes left: the note goes.
  writes.length = 0;
  await like(ben);
  await app.mirror();
  assert.deepEqual(sent(), [`DELETE /channels/${P5}/messages/${NOTE2}`]);
  assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM kv WHERE key LIKE 'likenote:%'").get().n, 0);

  // A locked thread takes nothing, and isn't asked again until the count changes.
  discord.set(`/channels/${GALLERY}/messages/${P5}`, { id: P5, thread: { id: P5, thread_metadata: { locked: true } } });
  await like(ben);
  await app.mirror();
  writes.length = 0;
  await app.mirror();
  assert.equal(writes.length, 0);
  assert.equal(JSON.parse(app.db.prepare("SELECT value FROM kv WHERE key = ?").get(`likenote:${P5}`).value).id, "-");
});

test("sessions follow membership, timeout and staff role", async () => {
  const member = (id, extra = {}) => ({ user: { id }, roles: [], ...extra });
  const gone = session("re-gone", "601", "gone");
  const muted = session("re-muted", "602", "muted");
  const demoted = session("re-demoted", "603", "demoted");
  app.db.prepare("UPDATE sessions SET is_staff = 1 WHERE user_id = '603'").run();
  const flaky = session("re-flaky", "604", "flaky");
  discord.set(`/guilds/${GUILD}/members/601`, 404);
  discord.set(`/guilds/${GUILD}/members/602`, member("602", { communication_disabled_until: new Date(T + 2 * DAY).toISOString() }));
  discord.set(`/guilds/${GUILD}/members/603`, member("603"));
  discord.set(`/guilds/${GUILD}/members/604`, 500);
  assert.equal((await (await req("/api/me", { cookie: demoted })).json()).user.staff, true);

  await app.recheckSessions();
  const me = async (cookie) => (await (await req("/api/me", { cookie })).json()).user;
  assert.equal(await me(gone), null, "left the guild");
  assert.equal(await me(muted), null, "timed out");
  assert.equal((await (await req("/api/me", { cookie: demoted })).json()).user.staff, false, "role taken away");
  assert.notEqual(await me(flaky), null, "a Discord error logs nobody out");
});
