# gallery-api

Likes and comments for gallery.voidtales.win. One Node file, no npm dependencies
(`node:http`, `node:sqlite`, `fetch`), SQLite on a volume. Traefik routes
`Host(gallery.voidtales.win) && PathPrefix(/api)` here, so it runs on the same origin as the static site:
no CORS, the session cookie stays first-party.

- **Reading** is public: `GET /api/stats`, `GET /api/images/:id/comments`.
- **Writing** needs a Discord login and membership in the Void Tales guild (OAuth2 code flow with PKCE, scopes
  `identify guilds.members.read`). Sessions last 7 days; only the SHA-256 of the cookie is stored, the Discord
  access token is not stored at all.
- **Discord mirror**: every 10 minutes (posts from the last 30 days, all posts once a day) the configured like
  emojis on the original Discord post count as likes for every image of that post, and replies in the post's
  thread show up as comments. One way only; Discord stays the place to moderate those.
  The image → post mapping comes from the n8n summary messages (image IDs in the delete links). The n8n workflow
  itself is never changed for this.
- Staff (Discord roles in `STAFF_ROLE_IDS`) can delete any site comment; everyone can delete their own. Deleting
  is a soft delete (`deleted_by`).
- Once a day `VACUUM INTO` writes a consistent copy to `BACKUP_PATH` for the offsite pull.

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | yes | OAuth app; redirect URI `https://gallery.voidtales.win/api/callback` |
| `DISCORD_GUILD_ID` | yes | guild whose members may write |
| `DISCORD_BOT_TOKEN` | for the mirror | bot with read access to the gallery channels; without it there is no Discord sync |
| `STAFF_ROLE_IDS` | no | comma-separated role IDs that may delete any comment |
| `STAFF_WEBHOOK_URL` | no | Discord webhook that gets every new site comment (mentions disabled) |
| `GALLERY_CHANNEL_IDS` | no | channels to scan for n8n summaries (default: the two gallery channels) |
| `SUMMARY_BOT_ID` | no | author of the n8n summaries (default: the n8n bot) |
| `LIKE_EMOJIS` | no | reactions that count as a like (default `👍,❤️`) |
| `PUBLIC_ORIGIN` | no | default `https://gallery.voidtales.win`; also the only accepted `Origin` for writes |
| `IMAGES_URL` | no | default `$PUBLIC_ORIGIN/images.json`, refreshed every 5 minutes |
| `DB_PATH`, `BACKUP_PATH` | no | default `/data/gallery.db`, `/data/backup/gallery.db` |

Secrets only as environment of the Dokploy app, never in the repo.

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
