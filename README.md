# Werewolf LAN Game

A lightweight browser-based werewolf assistant for in-person games. One device acts as host/admin, and players join from phones.

## Important Update
Glitch project hosting was shut down on **July 8, 2025**, so the old Glitch deployment path no longer works.  
Use local LAN mode or Ngrok instead.

## Quick Start (Local LAN)
Requirements: Node.js 18+ recommended.

```bash
npm install
npm start
```

Server starts on `http://localhost:3000`.

- Host/admin opens `http://localhost:3000` on laptop.
- Players on same Wi-Fi open `http://<host-lan-ip>:3000`.

## Fastest Internet Sharing: Ngrok
This is the best option for same-day party play without managing cloud servers.

1. Start the app locally:
   ```bash
   npm start
   ```
2. Install/login to ngrok (once), then run:
   ```bash
   ngrok http 3000
   ```
3. Share the generated `https://...ngrok...` URL with players.

Notes for free plan:
- No tunnel timeout, but monthly usage caps apply.
- Ngrok shows a browser warning/interstitial page for public HTML endpoints on free tier. Each player may need to click through once.

## Alternative Hosting
- Render: better for always-on use and easier sharing over time.
- Replit: quick cloud setup, but check sleep/idle behavior on your plan.

## Admin Flow
1. Open page and click the admin/host button.
2. Wait for players to join lobby.
3. Start game, then advance phases from admin controls.

## Customization
Adjust role setup and phase logic in `server.js` (socket handlers such as `admin-start` and phase transitions).
