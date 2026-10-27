# gallery-api

Likes and comments for gallery.voidtales.win. One Node file, no npm dependencies
(`node:http`, `node:sqlite`, `fetch`), SQLite on a volume. Traefik routes
`Host(gallery.voidtales.win) && PathPrefix(/api)` here, so it runs on the same origin as the static site:
no CORS, the session cookie stays first-party.

- **Reading** is public: `GET /api/stats`, `GET /api/images/:id/comments`.
- **Writing** needs a Discord login and membership in the Void Tales guild (OAuth2 code flow with PKCE, scopes
  `identify guilds.members.read`). Sessions last 7 days; only the SHA-256 of the cookie is stored, the Discord
  access token is not stored at all. A login `state` works once and for 10 minutes; the PKCE verifier stays on
  the server, the cookie only carries the state. Members in a timeout can't log in.
- **Membership is checked again on every sync**: the bot looks up every logged-in user in the guild. Left the
  guild or timed out → the session ends; staff role taken away → staff rights end, at the latest after 10
  minutes. A Discord error keeps the session.
- **Rate limits** (in memory, reset on restart): login 10/min per address, callback 10/min per address and 30
  token exchanges per minute in total, likes 60/min and comments 5/min and 30/day per user. IPv6 addresses count
  by their /64.
- **Discord mirror**: every 10 minutes (posts from the last 30 days, all posts once a day) the configured like
  emojis on the original Discord post count as likes for every image of that post, and replies in the post's
  thread show up as comments; Discord stays the place to moderate those.
  The image → post mapping comes from the n8n summary messages (image IDs in the delete links). The n8n workflow
  itself is never changed for this.
- **Site comments go to Discord too**: right after posting (and retried on every sync) a site comment is sent to
  the post's thread through a channel webhook named "Void Tales Gallery", as `<name> · via Gallery` with the
  commenter's avatar and a link back to the image; mentions and link previews are disabled, and Markdown is
  escaped so Discord shows the same plain text as the site (the staff webhook too). The bot opens the thread when
  the post has none and makes the webhook on first use. Archived threads reopen by themselves; locked
  threads, deleted posts and comments older than 7 days are skipped. Deleting on the site deletes the Discord
  message; staff deleting the message in Discord deletes the comment on the site with the next sync
  (`deleted_by = 'discord'`). State lives in `comments.discord_msg_id`: `NULL` = not sent yet, `-` = never
  will be, digits = the Discord message. The webhook token is only kept in memory, not in the database.
  `/api/health` reports `mirrorBacklog`, the number of comments that waited more than 30 minutes for Discord
  in either direction (alert `GalleryMirrorBacklog`).
- Staff (Discord roles in `STAFF_ROLE_IDS`) can delete any site comment; everyone can delete their own. Deleting
  is a soft delete (`deleted_by`).
- Once a day `VACUUM INTO` writes a consistent copy to `BACKUP_PATH` for the offsite pull.

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | yes | OAuth app; redirect URI `https://gallery.voidtales.win/api/callback` |
| `DISCORD_GUILD_ID` | yes | guild whose members may write |
| `DISCORD_BOT_TOKEN` | for the mirror | bot of the OAuth app itself (see below); without it there is no Discord sync and no membership re-check |
| `STAFF_ROLE_IDS` | no | comma-separated role IDs that may delete any comment |
| `STAFF_WEBHOOK_URL` | no | Discord webhook that gets every new site comment (mentions disabled) |
| `GALLERY_CHANNEL_IDS` | no | channels to scan for n8n summaries (default: the two gallery channels) |
| `SUMMARY_BOT_ID` | no | author of the n8n summaries (default: the n8n bot) |
| `LIKE_EMOJIS` | no | reactions that count as a like (default `👍,❤️`) |
| `PUBLIC_ORIGIN` | no | default `https://gallery.voidtales.win`; also the only accepted `Origin` for writes |
| `IMAGES_URL` | no | default `$PUBLIC_ORIGIN/images.json`, refreshed every 5 minutes |
| `DB_PATH`, `BACKUP_PATH` | no | default `/data/gallery.db`, `/data/backup/gallery.db` |

Secrets only as environment of the Dokploy app, never in the repo.

### The bot

The bot is the bot user of the same Discord app as the login, not an admin bot. It never connects to the
gateway (it shows as offline); the API only makes REST calls with it.

- Developer Portal: *Public Bot* off, *Message Content Intent* on (thread replies are read as comments), the
  other two intents off.
- In the guild without any role and server permissions; in each gallery channel a member override allowing
  *View Channel*, *Read Message History*, *Manage Messages*, *Manage Webhooks* and *Create Public Threads*
  (`34896684032`).

## Local

```bash
node --test api/server.test.js
# API on :3000, dev server proxies /api there (astro.config.mjs)
DB_PATH=/tmp/g.db BACKUP_PATH=/tmp/g-backup.db PUBLIC_ORIGIN=http://localhost:4321 \
  IMAGES_URL=http://localhost:4321/images.json DISCORD_CLIENT_ID=x DISCORD_CLIENT_SECRET=x \
  DISCORD_GUILD_ID=1 node api/server.js
pnpm run dev
```

The OAuth redirect only works on production. To test logged in, insert a session row with the SHA-256 of a token
of your choice and set the cookie `__Host-vt_sess=<token>` on `localhost`.

## Deploy

`.github/workflows/deploy-api.yml`: on changes under `api/` it runs the tests, builds
`inventory69/voidtales-gallery-api:{latest,<sha>}` and calls the Dokploy webhook `DOKPLOY_API_DEPLOY_WEBHOOK`.
It is separate from `deploy.yml` so a new gallery image doesn't restart the API. If the API is down, the
gallery keeps working without numbers and login.
