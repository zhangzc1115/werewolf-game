# Werewolf Game Behavior Specification

This document describes the intended behavior of the current implementation in this repository.

## 1. Runtime Model

- Server: Node.js + Express + Socket.IO (`server.js`).
- State storage:
  - In-memory live state while running.
  - Persisted to `data/game-state.json` on state updates.
  - Loaded on startup if file exists.
- Identity/reconnect:
  - Each player gets a token.
  - Client stores token in `localStorage`.
  - On reconnect/refresh, server rebinds player by token.

## 2. Roles

- `wolf` (狼人)
- `wolf_king` (狼枪)
- `witch` (女巫)
- `seer` (预言家)
- `hunter` (猎人)
- `idiot` (白痴)
- `hybrid` (混血儿)
- `villager` (平民)
- Internal non-play roles:
  - `spectator` (旁观)
  - `unassigned` (未分配)

## 3. Teams

- Wolf team:
  - `wolf`
  - `wolf_king`
- Good team:
  - `villager`
  - `witch`
  - `seer`
  - `hunter`
  - `idiot`
- Hybrid:
  - `hybrid` has dynamic team based on chosen role model.

## 4. Game Start / Role Assignment

- Admin starts game via `admin-start` payload:
  - `wolf` (count, non-negative integer)
  - `wolfKing` (count, non-negative integer)
  - `witch` (count)
  - `seer` (count)
  - `hunter` (count)
  - `idiot` (count)
  - `hybrid` (count)
- At least 4 online players are required to start.
- If `wolf + wolfKing === 0`, server forces at least one `wolf`.
- If configured special roles exceed player count, server trims roles.
- Remaining slots are filled with `villager`.

## 5. Phases

- `waiting`: lobby, before game starts.
- `hybrid`: first-night-only role model selection phase.
- `wolf`: wolf team acts (`wolf` + `wolf_king` can submit kill).
- `witch`: witch may save the wolf target or poison one player.
- `seer`: seer checks one player.
- `day_announce`: night deaths are announced; admin can process daytime vote out.
- `shoot_phase`: shared shoot phase for `wolf_king` and `hunter` when triggered.
- `game_over`: win condition met; no further phase progression.

## 6. Night Action Behavior

- Night order:
  - Night 1: `hybrid -> wolf -> witch -> seer`
  - Night 2+: `wolf -> witch -> seer`
- Hybrid:
  - Night 1 only, chooses one alive player as `modelId`.
  - Model can be any alive player except self.
  - Hybrid team follows model's team.
- Wolf kill:
  - Each alive wolf-team player can submit one kill target.
  - Server tallies votes and picks highest-count target.
- Witch:
  - Save can cancel the wolf target once per night.
  - Poison can kill one alive target once per night.
- Seer:
  - One check per seer per night.
  - Returns good/bad where wolf team (`wolf`, `wolf_king`) is bad.
  - `hybrid` is always seen as good.
- Night resolve:
  - Applies kill and poison (with save logic).
  - Updates `nightResult.deadIds`.
  - Tracks death causes (`wolf`, `poison`, `shot`) for trigger logic.
  - Resets day-vote state.

## 7. Day Vote, Idiot, and Shoot Triggers

- Admin marks day vote result using `admin-day-vote` with `targetId`.
- If voted-out player is `idiot` and not exposed:
  - Player survives (not killed).
  - `isExposed = true`.
  - `canVote = false`.
  - Public notice is broadcast.
  - No shoot phase.
- If voted-out player is `wolf_king`:
  - Enter `shoot_phase`.
  - Shooter is that dead `wolf_king`.
- If voted-out player is `hunter`:
  - Enter `shoot_phase`.
  - Shooter is that dead `hunter`.
- If voted-out player is other roles:
  - Normal elimination.
  - Check victory.
  - If game continues, proceed to next night.

## 8. Shoot Phase Behavior

- `shoot_phase` action:
  - Shooter sends `action: { type: 'shoot', targetId }`.
  - Target is eliminated immediately.
  - Server broadcasts public/admin log.
- Trigger sources:
  - Day vote out `wolf_king` or `hunter`.
  - Night death `hunter` if killed by wolf and not poisoned.
- Restriction:
  - If `hunter` is poisoned, hunter cannot shoot.
  - `wolf_king` does not shoot on night death.

## 9. Victory Conditions

- Effective alive wolf count:
  - alive `wolf` + alive `wolf_king` + alive `hybrid` aligned to wolf model.
- Effective alive good count:
  - alive good roles (`villager`, `witch`, `seer`, `hunter`, `idiot`) + alive `hybrid` aligned to good model.
- Good win: effective wolf count is `0`.
- Wolf win: effective good count is `0`.
- Draw: both counts are `0`.
- On victory:
  - `phase = game_over`
  - `winner` is set and broadcast.
  - `winner.hybridWinnerIds` includes hybrid players whose model side won.

## 10. Visibility Rules

- Admin sees all players' roles.
- Player sees:
  - Own role.
  - Own `modelId` if role is `hybrid`.
  - Other players' alive/connected status and flags (`canVote`, `isExposed`).
  - Other players' role hidden, except exposed `idiot` is publicly visible.

## 11. Admin Controls (Current UI)

- Start game (with prompts for counts of wolf, wolf king, witch, seer, hunter, idiot, hybrid).
- Advance phase buttons:
  - hybrid
  - wolf
  - witch
  - seer
  - day_announce
- Day vote out button:
  - prompts for player id
  - sends `admin-day-vote`

## 12. Known Constraints

- No full automated daytime public voting system; admin manually enters vote-out target.
- No multiplayer room separation; single global room.
- Phase order is admin-driven; server enforces key constraints (e.g. first-night hybrid requirement), but moderator still controls sequencing.
- Single room/global game state only.
