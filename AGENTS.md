# Repository Guidelines

## Project Structure & Module Organization
This is a small Node.js + Socket.IO app.

- `server.js`: Express server, Socket.IO events, in-memory game state, LAN startup output.
- `public/index.html`: single-page UI shell for player/admin views.
- `public/client.js`: client-side game flow, socket event handlers, UI state switching.
- `public/style.css`: global styles for all screens.
- `package.json`: runtime dependencies (`express`, `socket.io`).

Keep backend game rules in `server.js` and UI-only behavior in `public/client.js`.

## Build, Test, and Development Commands
Install dependencies:

```bash
npm install
```

Run locally (LAN-ready on port `3000`):

```bash
node server.js
```

Then open `http://localhost:3000` on host, or `http://<host-lan-ip>:3000` from phones on the same Wi-Fi.

## Coding Style & Naming Conventions
- Use 4 spaces for indentation (match existing JS/HTML/CSS files).
- JavaScript: `camelCase` for variables/functions, `UPPER_SNAKE_CASE` for constants like ports.
- Keep socket event names explicit and stable (examples: `join`, `admin-start`, `action`).
- Prefer small, single-purpose functions in `public/client.js` for each phase/UI action.
- Keep text encoding as UTF-8 to avoid garbled Chinese characters in UI and logs.

## Testing Guidelines
There is currently no automated test suite in this repository.

- For server logic changes, manually test: join flow, role assignment, night actions, phase transition, reconnect/disconnect.
- For UI changes, test both player and admin screens in browser and mobile viewport.
- When adding tests, place them under `tests/` and use `*.test.js` naming.

## Commit & Pull Request Guidelines
No local `.git` history is available in this project snapshot, so follow a consistent standard:

- Commit format: `type(scope): summary` (example: `fix(server): guard invalid action payload`).
- Keep commits focused (one behavior change per commit).
- PRs should include: what changed, why, manual verification steps, and screenshots/GIFs for UI edits.
- Reference related issue IDs when available.
