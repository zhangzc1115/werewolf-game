# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Werewolf LAN party game — a Node.js + Express + Socket.IO app with a vanilla JS frontend. Players connect via phone browsers on the same network. An admin/moderator controls phase progression. No build step; all code is plain JavaScript.

## Commands

```bash
npm install              # Install dependencies
npm start                # Start server (port 3000, or PORT env)
npm test                 # Run all tests (Node.js built-in test runner)
npm run test:watch       # Run tests in watch mode
node --test tests/game.test.js  # Run a single test file
```

Environment variables: `PORT`, `WW_DATA_DIR` (default `./data`), `WW_STATE_FILE`, `WW_DISABLE_PERSIST=1`.

## Architecture

Single-room game with admin-driven phase progression. No automated voting — admin manually enters vote-out targets.

**Backend (`server.js`):** All game logic lives here — role assignment, night resolution, victory evaluation, shoot triggers, visibility filtering. In-memory state persisted to `data/game-state.json` on every change. Key functions: `buildRoleDeck()`, `resolveNight()`, `evaluateVictory()`, `getHybridTeam()`, `toPublicState()`.

**Frontend (`public/`):** Single-page app with four screen divs (login, lobby, game, admin) toggled by JS. `client.js` handles Socket.IO events and renders phase-specific UI. Player identity stored in localStorage (`ww_player_token`, `ww_player_name`, `ww_is_admin`).

**Tests (`tests/game.test.js`):** Integration tests that spawn a real server instance, connect Socket.IO clients, and walk through game scenarios. Tests use temp directories for state isolation and randomized ports. Uses `createClient()` helper with `waitForState()` for asserting game state after actions.

## Game Phase Flow

Night 1: `hybrid → wolf → witch → seer → day_announce`
Night 2+: `wolf → witch → seer → day_announce`
Special: `shoot_phase` triggers when wolf_king is voted out or hunter is killed by wolves (not poison).

## Key Game Rules (see GAMEPLAY_BEHAVIOR.md for full spec)

- Hybrid chooses a model player on night 1; their team follows that model's alignment. Seer always sees hybrid as good.
- Idiot survives first vote-out (becomes exposed, loses voting rights); dies normally on second.
- Hunter cannot shoot if poisoned at night. Wolf_king does not shoot on night death.
- Victory: good wins when all wolves eliminated; wolves win when all good eliminated. Hybrid counted on their model's team.

## Coding Conventions

- 4-space indentation in all JS/HTML/CSS files.
- `camelCase` for variables/functions, `UPPER_SNAKE_CASE` for constants.
- Socket event names are hyphenated: `admin-start`, `admin-day-vote`, `admin-next-phase`.
- Keep backend game rules in `server.js` and UI-only behavior in `public/client.js`.
- UTF-8 encoding required — UI text and logs contain Chinese characters.
- Commit format: `type(scope): summary` (e.g., `fix(server): guard invalid action payload`).
