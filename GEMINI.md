# GEMINI.md - Project Context & Instructions

This file provides instructional context for Gemini CLI when working within this repository. It summarizes the project's purpose, architecture, and development workflows.

## Project Overview

**Werewolf LAN Game** (狼人杀助手) is a lightweight, browser-based assistant for in-person "Werewolf Kill" games. It uses a single-room architecture where one device (typically a laptop) acts as the **Admin/God**, and players join via their phones over a local network (LAN).

### Core Technologies
- **Backend:** Node.js, Express, Socket.IO.
- **Frontend:** Vanilla JavaScript, HTML5, CSS3.
- **State Management:** In-memory state on the server, persisted to `data/game-state.json`.
- **Testing:** Node.js built-in test runner (`node --test`).

### Key Roles Supported
- **Good Team:** Villager, Witch, Seer, Hunter, Idiot.
- **Wolf Team:** Wolf, Wolf King.
- **Special:** Hybrid (陣營隨榜樣變化).

## Architecture & Structure

- `server.js`: The heart of the application. Handles socket connections, game logic, phase transitions, and state persistence.
- `public/`: Contains the frontend assets.
  - `index.html`: Single-page application shell.
  - `client.js`: Frontend logic, UI state management, and socket event handling.
  - `style.css`: Minimalist, dark-themed styling optimized for mobile play.
- `data/`: (Auto-generated) Stores `game-state.json` for persistence.
- `tests/`: Integration tests using `socket.io-client` and the built-in Node runner.
- `GAMEPLAY_BEHAVIOR.md` / `GAMEPLAY_BEHAVIOR_ZH.md`: Detailed specification of game rules and server logic.

## Building and Running

### Prerequisites
- Node.js 18 or higher.

### Key Commands
- **Install dependencies:** `npm install`
- **Start server:** `npm start` (Runs on `http://localhost:3000`)
- **Run tests:** `npm test`
- **Run tests (watch mode):** `npm run test:watch`

## Development Conventions

### Coding Style
- **Indentation:** 4 spaces.
- **Naming:** `camelCase` for variables/functions, `UPPER_SNAKE_CASE` for constants.
- **Encoding:** **Strict UTF-8** is required for all files to support Chinese character logs and UI text.
- **Server:** Logic-heavy; responsible for enforcing game rules and phase order.
- **Client:** View-heavy; handles screen switching and simple action emits.

### Testing Practices
- Use the built-in Node test runner.
- New features or bug fixes should include a test case in `tests/`.
- Tests typically spawn a server on a random port and use `socket.io-client` to simulate player interactions.

### Known Constraints & Edge Cases
- **Witch Potions:** Limited to one save and one poison per game (fixed in recent iterations).
- **Hunter/Wolf King:** Can only shoot if they die by specific causes (Wolf King on day vote, Hunter on day vote or night wolf-kill).
- **Persistence:** Ensure `gameState.nightResult.causes` is persisted to maintain shoot-trigger logic across server restarts.
- **Visibility:** Wolves should see their teammates (WIP/Verify); Seers should have persisted check results (WIP).

## Instructional Context for Gemini
- When modifying game logic, always refer to `GAMEPLAY_BEHAVIOR.md` to ensure alignment with the intended ruleset.
- When adding new roles, update `server.js` (role assignment, actions, victory conditions) and `public/client.js` (UI screens, role names).
- Prioritize UTF-8 encoding stability.
