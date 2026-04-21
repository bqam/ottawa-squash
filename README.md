# Court T · Squash Session Manager

A shared squash session manager for your crew. One server, one SQLite database, one group code — everyone on every phone sees the same state in real time.

## Features

- **Shared state** — players, courts, matches, and session live on the server. Anyone on the crew with the code sees the same thing.
- **Real-time sync** — when one phone starts a match or enters a score, everyone else's screen updates within a second (via Server-Sent Events).
- **Round-robin scheduler** — every available player plays every other exactly once, paired so closest ratings go on Court 1.
- **Variable match length** — matches run for as long as they run; tap "finish" to enter the score.
- **Simple login** — one shared group code, no accounts, no passwords.
- **PWA** — installs to your phone's home screen, full-screen app experience.

## Run locally

```bash
npm install
GROUP_CODE=squash123 npm start
# open http://localhost:3000
```

The SQLite database (`court-t.db`) is created automatically on first run.

## Deploy to Railway (easiest, free-ish)

1. Create a GitHub repo and push this folder to it.
2. Go to [railway.app](https://railway.app), sign in with GitHub, click **New Project → Deploy from GitHub repo**, pick your repo.
3. In the project **Variables** tab, add:
   - `GROUP_CODE` = whatever you want your crew to type
   - `DB_PATH` = `/data/court-t.db`
4. In the **Settings** tab, add a **Volume** mounted at `/data`. This keeps your database across redeploys.
5. Railway will auto-detect Node, run `npm install`, then `npm start`. Once deployed, click **Generate Domain** under Settings → Networking.
6. Visit the URL, enter your group code, and you're in.

Share the URL + code with your crew. They install it to their home screen and they're set.

## Deploy to Render (also free)

1. Push to GitHub, go to [render.com](https://render.com) → **New → Web Service**, connect the repo.
2. Build command: `npm install` · Start command: `npm start`
3. Add environment variable `GROUP_CODE`.
4. For persistent storage, add a **Disk** mounted at `/data` and set `DB_PATH=/data/court-t.db`.

## Deploy to your DigitalOcean droplet

You already have a droplet with Nginx + PM2. Drop this folder on it:

```bash
# on the droplet
cd /var/www
git clone <your-repo> court-t
cd court-t
npm install
GROUP_CODE=your-code DB_PATH=/var/lib/court-t.db pm2 start server.js --name court-t
pm2 save
```

Then add an Nginx site pointing to `http://127.0.0.1:3000` with SSE-friendly settings:

```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;
  proxy_set_header Connection '';
  proxy_buffering off;       # important for SSE
  proxy_cache off;           # important for SSE
  proxy_read_timeout 86400s;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
}
```

Run certbot and you're live over HTTPS.

## Environment variables

| Variable | Default | What it does |
| --- | --- | --- |
| `GROUP_CODE` | `squash123` | The code everyone types to log in. **Change this.** |
| `PORT` | `3000` | Port the server listens on. |
| `DB_PATH` | `./court-t.db` | Where to put the SQLite file. Use a mounted volume path on Railway/Render. |

## How the scheduling works

When you start a session, the server:

1. Takes the list of available players (those toggled ON in the Play tab).
2. Uses the **circle method** to produce a full round-robin — each player paired with each other exactly once.
3. Within each round, sorts pairs by rating closeness so the tightest match goes on Court 1.
4. Assigns matches to your courts in order, filling slots as courts free up.

If you have an odd number of players, one person sits out each round on rotation.

## What if the server goes down?

The client screen just stops updating — you'll see `OFFLINE` in the header. Once the server is back and reachable, it reconnects automatically and pulls the current state. Data is never lost because everything is written to SQLite immediately.
