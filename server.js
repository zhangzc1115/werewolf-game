const express = require("express");
process.stdout.setDefaultEncoding("utf8");
const app = express();
const http = require("node:http").createServer(app);
const io = require("socket.io")(http);
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const crypto = require("node:crypto");

app.use(express.static(path.join(__dirname, "public")));

const DATA_DIR = process.env.WW_DATA_DIR || path.join(__dirname, "data");
const STATE_FILE =
	process.env.WW_STATE_FILE || path.join(DATA_DIR, "game-state.json");
const SAVED_GAMES_FILE =
	process.env.WW_SAVED_GAMES_FILE || path.join(DATA_DIR, "saved-games.json");
const DISABLE_PERSIST = process.env.WW_DISABLE_PERSIST === "1";
const MAX_SAVED_GAMES = 10;

const PHASES = {
	WAITING: "waiting",
	HYBRID: "hybrid",
	WOLF: "wolf",
	WITCH: "witch",
	SEER: "seer",
	DAY_ANNOUNCE: "day_announce",
	SHOOT: "shoot_phase",
	GAME_OVER: "game_over",
};

const AUTO_PHASE_MS = {
	hybrid: 30000,
	wolf: 30000,
	witch: 25000,
	seer: 25000,
	day_announce: 90000,
	shoot_phase: 30000,
};

let nextPlayerId = 1;
let adminSocketId = null;
let phaseTimer = null;
let phaseTimerKey = "";

function createInitialState() {
	return {
		phase: PHASES.WAITING,
		round: 0,
		gameStartedAt: null,
		gameMode: "admin_moderated",
		hostPlayerId: null,
		winCondition: "side-kill", // side-kill, annihilation
		players: [],
		actions: {
			hybridModels: {}, // { [hybridPlayerId]: modelPlayerId }
			wolfVotes: {},
			witch: { save: false, poisonTargetId: null },
			seerChecks: {},
		},
		nightResult: {
			deadIds: [],
			wolfTargetId: null,
			saved: false,
			poisonTargetId: null,
			causes: {}, // { [playerId]: ['wolf', 'poison', 'shot', ...] }
		},
		dayVote: {
			votedOutId: null,
			shotTargetId: null,
			votes: {},
		},
		shootPhase: {
			shooterId: null,
			shooterRole: null,
			trigger: null, // 'night_death' | 'day_vote'
			nextAfterShot: null, // 'day_announce' | 'next_night'
		},
		witchAbilities: { saveUsed: false, poisonUsed: false },
		publicNotice: "",
		winner: null,
	};
}

let gameState = createInitialState();

function getLocalIP() {
	const interfaces = os.networkInterfaces();
	for (const name of Object.keys(interfaces)) {
		for (const iface of interfaces[name]) {
			if (iface.family === "IPv4" && !iface.internal) {
				return iface.address;
			}
		}
	}
	return "localhost";
}

function isAdminSocket(socket) {
	return socket.id === adminSocketId;
}

function getPlayerBySocketId(socketId) {
	return gameState.players.find((p) => p.socketId === socketId);
}

function getPlayerByToken(token) {
	return gameState.players.find((p) => p.token === token);
}

function getPlayerById(playerId) {
	return gameState.players.find((p) => p.id === Number(playerId));
}

function isWolfTeamRole(role) {
	return role === "wolf" || role === "wolf_king";
}

function isGoodBaseRole(role) {
	return ["villager", "witch", "seer", "hunter", "idiot"].includes(role);
}

function _isGodRole(role) {
	return ["witch", "seer", "hunter", "idiot"].includes(role);
}

function isGamePhaseRunning() {
	return [
		PHASES.HYBRID,
		PHASES.WOLF,
		PHASES.WITCH,
		PHASES.SEER,
		PHASES.DAY_ANNOUNCE,
		PHASES.SHOOT,
	].includes(gameState.phase);
}

function isSelfModeratedMode() {
	return gameState.gameMode === "self_moderated";
}

function clearPhaseTimer() {
	if (phaseTimer) {
		clearTimeout(phaseTimer);
		phaseTimer = null;
	}
	phaseTimerKey = "";
}

function resetNightData() {
	gameState.actions = {
		hybridModels: {},
		wolfVotes: {},
		witch: { save: false, poisonTargetId: null },
		seerChecks: {},
	};
	gameState.nightResult = {
		deadIds: [],
		wolfTargetId: null,
		saved: false,
		poisonTargetId: null,
		causes: {},
	};
}

function resetDayData() {
	gameState.dayVote = {
		votedOutId: null,
		shotTargetId: null,
		votes: {},
	};
	gameState.shootPhase = {
		shooterId: null,
		shooterRole: null,
		trigger: null,
		nextAfterShot: null,
	};
}

function clearPublicNotice() {
	gameState.publicNotice = "";
}

function setPublicNotice(message) {
	gameState.publicNotice = message;
}

function shuffle(array) {
	const arr = [...array];
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[arr[i], arr[j]] = [arr[j], arr[i]];
	}
	return arr;
}

function generateToken() {
	if (crypto.randomUUID) return crypto.randomUUID();
	return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function ensureDataDir() {
	if (!fs.existsSync(DATA_DIR)) {
		fs.mkdirSync(DATA_DIR, { recursive: true });
	}
}

function serializePlayersForDisk(players) {
	return players.map((p) => ({
		id: p.id,
		name: p.name,
		role: p.role,
		alive: Boolean(p.alive),
		token: p.token || generateToken(),
		connected: Boolean(p.connected),
		canVote: Boolean(p.canVote),
		isExposed: Boolean(p.isExposed),
		modelId: p.modelId ? Number(p.modelId) : null,
		socketId: null,
	}));
}

function serializeCurrentSnapshot() {
	return {
		nextPlayerId,
		gameState: {
			...gameState,
			players: serializePlayersForDisk(gameState.players),
		},
	};
}

function applySnapshot(snapshot, options = {}) {
	const loaded = snapshot?.gameState || {};
	const loadedPlayers = Array.isArray(loaded.players) ? loaded.players : [];
	const preserveConnectedByToken = options.preserveConnectedByToken || new Map();

	gameState = {
		...createInitialState(),
		...loaded,
		players: loadedPlayers.map((p) => {
			const playerToken = String(p.token || generateToken());
			const connectedSession = preserveConnectedByToken.get(playerToken);
			const liveSocket =
				connectedSession && io.sockets.sockets.get(connectedSession.socketId);

			return {
				id: Number(p.id),
				name:
					String(p.name || `Player ${p.id || ""}`).trim() ||
					`Player ${p.id || ""}`,
				role: String(p.role || "unassigned"),
				alive: Boolean(p.alive),
				token: playerToken,
				connected: Boolean(liveSocket),
				socketId: liveSocket ? connectedSession.socketId : null,
				canVote: p.canVote === undefined ? true : Boolean(p.canVote),
				isExposed: Boolean(p.isExposed),
				modelId: p.modelId ? Number(p.modelId) : null,
			};
		}),
	};

	if (!Object.values(PHASES).includes(gameState.phase)) {
		gameState.phase = PHASES.WAITING;
	}

	if (!gameState.winner || !gameState.winner.team) {
		gameState.winner = null;
	}
	gameState.gameStartedAt = Number(gameState.gameStartedAt) || null;

	nextPlayerId = Number(snapshot?.nextPlayerId) || 1;
	if (gameState.players.length) {
		const maxPlayerId = Math.max(...gameState.players.map((p) => p.id));
		nextPlayerId = Math.max(nextPlayerId, maxPlayerId + 1);
	}
}

function buildConnectedTokenMap() {
	const map = new Map();
	gameState.players.forEach((p) => {
		if (!p.connected || !p.socketId || !p.token) return;
		if (!io.sockets.sockets.get(p.socketId)) return;
		map.set(String(p.token), { socketId: p.socketId });
	});
	return map;
}

function readSavedGames() {
	if (DISABLE_PERSIST) return [];
	try {
		if (!fs.existsSync(SAVED_GAMES_FILE)) return [];
		const raw = JSON.parse(fs.readFileSync(SAVED_GAMES_FILE, "utf8"));
		return Array.isArray(raw?.saves) ? raw.saves : [];
	} catch (err) {
		console.error("Failed to read saved games:", err.message);
		return [];
	}
}

function writeSavedGames(saves) {
	if (DISABLE_PERSIST) return;
	try {
		ensureDataDir();
		const trimmed = (Array.isArray(saves) ? saves : []).slice(0, MAX_SAVED_GAMES);
		fs.writeFileSync(
			SAVED_GAMES_FILE,
			JSON.stringify({ saves: trimmed }, null, 2),
			"utf8",
		);
	} catch (err) {
		console.error("Failed to write saved games:", err.message);
	}
}

function buildSaveSummary(snapshot) {
	const state = snapshot?.gameState || {};
	const players = Array.isArray(state.players) ? state.players : [];
	const alivePlayers = players.filter((p) => p.alive).length;
	const startedAt = Number(state.gameStartedAt) || null;
	const elapsedMs = startedAt ? Math.max(0, Date.now() - startedAt) : 0;
	return {
		phase: state.phase || PHASES.WAITING,
		round: Number(state.round) || 0,
		gameMode: state.gameMode || "admin_moderated",
		totalPlayers: players.length,
		alivePlayers,
		elapsedMs,
	};
}

function listSavedGameMeta() {
	return readSavedGames().map((entry) => ({
		id: entry.id,
		label: entry.label,
		notes: entry.notes || "",
		savedBy: entry.savedBy || "Unknown",
		savedAt: entry.savedAt,
		summary: entry.summary,
	}));
}

function emitSaveListTo(socket) {
	socket.emit("save-list", listSavedGameMeta());
}

function saveStateToDisk() {
	if (DISABLE_PERSIST) return;
	try {
		ensureDataDir();
		const payload = serializeCurrentSnapshot();

		fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2), "utf8");
	} catch (err) {
		console.error("Failed to save persisted state:", err.message);
	}
}

function loadStateFromDisk() {
	if (DISABLE_PERSIST) return;
	try {
		if (!fs.existsSync(STATE_FILE)) return;

		const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
		applySnapshot(raw);

		adminSocketId = null;
	} catch (err) {
		console.error(
			"Failed to load persisted state, using initial state.",
			err.message,
		);
		gameState = createInitialState();
		nextPlayerId = 1;
		adminSocketId = null;
	}
}

function buildRoleDeck(config, playerCount) {
	const safeConfig = {
		wolf: Math.max(0, Number(config?.wolf) || 0),
		wolfKing: Math.max(0, Number(config?.wolfKing) || 0),
		witch: Number(config?.witch) > 0 || Boolean(config?.witch) ? 1 : 0,
		seer: Number(config?.seer) > 0 || Boolean(config?.seer) ? 1 : 0,
		hunter: Number(config?.hunter) > 0 || Boolean(config?.hunter) ? 1 : 0,
		idiot:
			Number(config?.idiot) > 0
				? Math.max(0, Number(config.idiot))
				: config?.idiot
					? 1
					: 0,
		hybrid: Math.max(0, Number(config?.hybrid) || 0),
	};

	if (safeConfig.wolf + safeConfig.wolfKing === 0) {
		safeConfig.wolf = 1;
	}

	const roles = [];

	for (let i = 0; i < safeConfig.wolf; i++) roles.push("wolf");
	for (let i = 0; i < safeConfig.wolfKing; i++) roles.push("wolf_king");
	for (let i = 0; i < safeConfig.witch; i++) roles.push("witch");
	for (let i = 0; i < safeConfig.seer; i++) roles.push("seer");
	for (let i = 0; i < safeConfig.hunter; i++) roles.push("hunter");
	for (let i = 0; i < safeConfig.idiot; i++) roles.push("idiot");
	for (let i = 0; i < safeConfig.hybrid; i++) roles.push("hybrid");

	while (roles.length > playerCount) {
		const villagerUnsafePriority = [
			"wolf",
			"wolf_king",
			"witch",
			"seer",
			"hunter",
			"idiot",
			"hybrid",
		];
		let removed = false;
		for (const role of villagerUnsafePriority) {
			const idx = roles.indexOf(role);
			if (idx !== -1) {
				roles.splice(idx, 1);
				removed = true;
				break;
			}
		}
		if (!removed) roles.pop();
	}

	while (roles.length < playerCount) {
		roles.push("villager");
	}

	return shuffle(roles);
}

function tallyWolfTarget() {
	const votes = Object.values(gameState.actions.wolfVotes);
	if (votes.length === 0) return null;

	const countByTarget = new Map();
	votes.forEach((targetId) => {
		const t = Number(targetId);
		countByTarget.set(t, (countByTarget.get(t) || 0) + 1);
	});

	let winner = null;
	let winnerCount = -1;
	for (const [targetId, count] of countByTarget.entries()) {
		if (count > winnerCount) {
			winnerCount = count;
			winner = targetId;
		}
	}
	return winner;
}

function addDeathCause(causes, playerId, cause) {
	const key = String(playerId);
	if (!causes[key]) causes[key] = [];
	if (!causes[key].includes(cause)) causes[key].push(cause);
}

function hasWolfVoteTie() {
	const votes = Object.values(gameState.actions.wolfVotes);
	if (votes.length < 2) return false;

	const countByTarget = new Map();
	votes.forEach((targetId) => {
		const t = Number(targetId);
		countByTarget.set(t, (countByTarget.get(t) || 0) + 1);
	});

	let maxCount = 0;
	for (const count of countByTarget.values()) {
		if (count > maxCount) maxCount = count;
	}

	let topCount = 0;
	for (const count of countByTarget.values()) {
		if (count === maxCount) topCount++;
	}

	return topCount > 1;
}

function getAlivePlayersByRoleFilter(filterFn) {
	return gameState.players.filter((p) => p.alive && p.connected && filterFn(p));
}

function getEligibleDayVoters() {
	return gameState.players.filter(
		(p) =>
			p.alive &&
			p.connected &&
			p.canVote &&
			!["spectator", "unassigned"].includes(p.role),
	);
}

function tallyDayVote() {
	const votes = gameState.dayVote.votes || {};
	const countByTarget = new Map();
	Object.values(votes).forEach((targetId) => {
		const t = Number(targetId);
		if (!Number.isInteger(t)) return;
		countByTarget.set(t, (countByTarget.get(t) || 0) + 1);
	});

	let winner = null;
	let maxCount = 0;
	let tie = false;
	for (const [targetId, count] of countByTarget.entries()) {
		if (count > maxCount) {
			maxCount = count;
			winner = targetId;
			tie = false;
		} else if (count === maxCount) {
			tie = true;
		}
	}

	return {
		winnerId: tie ? null : winner,
		tie,
		maxCount,
	};
}

function announceDayDeaths() {
	const deadNames = gameState.nightResult.deadIds
		.map((id) => getPlayerById(id))
		.filter(Boolean)
		.map((p) => p.name);
	emitAdminLog(
		deadNames.length
			? `Day break: deaths ${deadNames.join(", ")}`
			: "Day break: peaceful night",
	);
}

function transitionNightToDayAnnounce() {
	resolveNight();

	if (maybeStartNightDeathShoot()) {
		emitState();
		return;
	}

	if (!applyVictoryIfNeeded()) {
		gameState.phase = PHASES.DAY_ANNOUNCE;
		announceDayDeaths();
	}

	emitState();
}

function continueAfterShootPhase() {
	if (applyVictoryIfNeeded()) {
		emitState();
		return;
	}

	if (gameState.shootPhase.nextAfterShot === "day_announce") {
		gameState.phase = PHASES.DAY_ANNOUNCE;
		announceDayDeaths();
	} else {
		startNightRound(true);
	}

	emitState();
}

function finalizeSelfModeratedDayVote() {
	if (!isSelfModeratedMode()) return;
	if (gameState.phase !== PHASES.DAY_ANNOUNCE) return;

	const eligibleVoters = getEligibleDayVoters();
	const submittedCount = eligibleVoters.filter(
		(p) => gameState.dayVote.votes[p.id],
	).length;
	if (eligibleVoters.length > 0 && submittedCount === 0) {
		emitAdminLog("Self mode: no day votes submitted, skipping execution");
		startNightRound(true);
		emitState();
		return;
	}

	const result = tallyDayVote();
	if (!result.winnerId || result.tie) {
		emitAdminLog("Self mode: day vote tied, no execution");
		setPublicNotice("Day vote tied, no one is executed");
		startNightRound(true);
		emitState();
		return;
	}

	const votedOut = getPlayerById(result.winnerId);
	if (!votedOut || !votedOut.alive) {
		startNightRound(true);
		emitState();
		return;
	}

	processDayVoteOut(votedOut);
	emitState();
}

function autoAdvanceSelfModeratedPhase() {
	if (!isSelfModeratedMode()) return;

	if (gameState.phase === PHASES.HYBRID) {
		gameState.phase = PHASES.WOLF;
		emitAdminLog("Auto: entering wolf phase");
		emitState();
		return;
	}

	if (gameState.phase === PHASES.WOLF) {
		if (hasWolfVoteTie()) {
			gameState.actions.wolfVotes = {};
			setPublicNotice("Wolf vote tied, no kill unless revoted before timeout");
		}
		gameState.phase = PHASES.WITCH;
		emitAdminLog("Auto: entering witch phase");
		emitState();
		return;
	}

	if (gameState.phase === PHASES.WITCH) {
		gameState.phase = PHASES.SEER;
		emitAdminLog("Auto: entering seer phase");
		emitState();
		return;
	}

	if (gameState.phase === PHASES.SEER) {
		transitionNightToDayAnnounce();
		return;
	}

	if (gameState.phase === PHASES.DAY_ANNOUNCE) {
		finalizeSelfModeratedDayVote();
		return;
	}

	if (gameState.phase === PHASES.SHOOT) {
		emitAdminLog("Shoot phase timeout: skipping shot");
		continueAfterShootPhase();
	}
}

function syncPhaseTimer() {
	if (!isSelfModeratedMode()) {
		clearPhaseTimer();
		return;
	}

	if (
		gameState.phase === PHASES.WAITING ||
		gameState.phase === PHASES.GAME_OVER
	) {
		clearPhaseTimer();
		return;
	}

	const ms = AUTO_PHASE_MS[gameState.phase];
	if (!ms) {
		clearPhaseTimer();
		return;
	}

	const nextKey = `${gameState.phase}:${gameState.round}:${gameState.shootPhase.shooterId || 0}`;
	if (phaseTimerKey === nextKey && phaseTimer) return;

	clearPhaseTimer();
	phaseTimerKey = nextKey;
	phaseTimer = setTimeout(() => {
		phaseTimer = null;
		phaseTimerKey = "";
		autoAdvanceSelfModeratedPhase();
	}, ms);
}

function resolveNight() {
	const wolfTargetId = tallyWolfTarget();
	const witchSave = gameState.actions.witch.save;
	const witchPoisonTargetId = gameState.actions.witch.poisonTargetId;

	const deadSet = new Set();
	const causes = {};
	const validWolfTarget = wolfTargetId ? getPlayerById(wolfTargetId) : null;

	if (validWolfTarget?.alive && !witchSave) {
		deadSet.add(validWolfTarget.id);
		addDeathCause(causes, validWolfTarget.id, "wolf");
	}

	const validPoisonTarget = witchPoisonTargetId
		? getPlayerById(witchPoisonTargetId)
		: null;
	if (validPoisonTarget?.alive) {
		deadSet.add(validPoisonTarget.id);
		addDeathCause(causes, validPoisonTarget.id, "poison");
	}

	const deadIds = [...deadSet];
	deadIds.forEach((id) => {
		const player = getPlayerById(id);
		if (player) player.alive = false;
	});

	gameState.nightResult = {
		deadIds,
		wolfTargetId: wolfTargetId || null,
		saved: Boolean(witchSave && validWolfTarget),
		poisonTargetId: witchPoisonTargetId || null,
		causes,
	};

	resetDayData();
}

function createWitchPrompt() {
	const wolfTargetId = tallyWolfTarget();
	const wolfTarget = wolfTargetId ? getPlayerById(wolfTargetId) : null;
	const canSave =
		!gameState.witchAbilities.saveUsed && !gameState.actions.witch.save;
	return {
		wolfTargetId: canSave && wolfTarget ? wolfTarget.id : null,
		wolfTargetName: canSave && wolfTarget ? wolfTarget.name : null,
		canSave,
		canPoison:
			!gameState.witchAbilities.poisonUsed &&
			gameState.actions.witch.poisonTargetId === null,
	};
}

function getHybridTeamByModelId(modelId, visited = new Set()) {
	const model = getPlayerById(modelId);
	if (!model) return "villagers";

	if (isWolfTeamRole(model.role)) return "wolves";
	if (isGoodBaseRole(model.role)) return "villagers";

	if (model.role === "hybrid") {
		if (visited.has(model.id)) return "villagers";
		visited.add(model.id);
		return getHybridTeamByModelId(model.modelId, visited);
	}

	return "villagers";
}

function getHybridTeam(player) {
	if (!player || player.role !== "hybrid") return null;
	return getHybridTeamByModelId(player.modelId);
}

function computeLivingTeamCounts() {
	let wolves = 0;
	let villagers = 0;
	let gods = 0;

	for (const p of gameState.players) {
		if (!p.alive) continue;
		if (["unassigned", "spectator"].includes(p.role)) continue;

		if (isWolfTeamRole(p.role)) {
			wolves += 1;
			continue;
		}

		if (p.role === "villager") {
			villagers += 1;
			continue;
		}

		if (_isGodRole(p.role)) {
			gods += 1;
			continue;
		}

		if (p.role === "hybrid") {
			const team = getHybridTeam(p);
			if (team === "wolves") {
				wolves += 1;
			} else {
				// In side-kill, a good hybrid is often considered a "god" role for balance
				gods += 1;
			}
		}
	}

	return { wolves, villagers, gods };
}

function evaluateVictory() {
	const counts = computeLivingTeamCounts();
	const totalGood = counts.villagers + counts.gods;

	// Common draw condition
	if (counts.wolves === 0 && totalGood === 0) {
		return { team: "draw", reason: "No players alive", counts };
	}

	// Villagers win if all wolves are gone
	if (counts.wolves === 0) {
		return { team: "villagers", reason: "All wolves eliminated", counts };
	}

	if (gameState.winCondition === "annihilation") {
		// 屠城: Win when no good players left
		if (totalGood === 0) {
			return { team: "wolves", reason: "All good players eliminated", counts };
		}
		// Some versions of Annihilation also use parity:
		if (counts.wolves >= totalGood) {
			return { team: "wolves", reason: "Wolves reached parity", counts };
		}
	} else {
		// 屠边 (Default): Win when all villagers dead OR all gods dead
		if (counts.villagers === 0 || counts.gods === 0) {
			return { team: "wolves", reason: "All villagers or gods eliminated", counts };
		}
	}

	return null;
}

function applyVictoryIfNeeded() {
	const winner = evaluateVictory();
	if (!winner) return false;

	const hybridWinners = gameState.players
		.filter((p) => p.role === "hybrid")
		.map((p) => ({ playerId: p.id, team: getHybridTeam(p) }))
		.filter((x) => x.team === winner.team)
		.map((x) => x.playerId);

	gameState.winner = {
		...winner,
		hybridWinnerIds: hybridWinners,
	};
	gameState.phase = PHASES.GAME_OVER;

	emitAdminLog(
		winner.team === "villagers"
			? "Game over: villagers win"
			: winner.team === "wolves"
				? "Game over: wolves win"
				: "Game over: draw",
	);
	setPublicNotice(
		winner.team === "villagers"
			? "Villagers win"
			: winner.team === "wolves"
				? "Wolves win"
				: "Draw",
	);
	return true;
}

function hasUnselectedHybrid() {
	return gameState.players.some(
		(p) => p.alive && p.role === "hybrid" && !p.modelId,
	);
}

function startNightRound(shouldIncreaseRound) {
	if (shouldIncreaseRound) {
		gameState.round += 1;
	}

	resetNightData();
	resetDayData();
	clearPublicNotice();

	if (gameState.round === 1 && hasUnselectedHybrid()) {
		gameState.phase = PHASES.HYBRID;
		emitAdminLog(`Night ${gameState.round} started: hybrid selects model`);
		return;
	}

	gameState.phase = PHASES.WOLF;
	emitAdminLog(`Night ${gameState.round} started: wolves act`);
}

function beginShootPhase(shooter, trigger, nextAfterShot) {
	gameState.phase = PHASES.SHOOT;
	gameState.shootPhase = {
		shooterId: shooter.id,
		shooterRole: shooter.role,
		trigger,
		nextAfterShot,
	};

	const roleName = shooter.role === "hunter" ? "hunter" : "wolf king";
	emitAdminLog(`${roleName} ${shooter.name} entered shoot phase`);
	setPublicNotice(`${roleName} is choosing a shot target`);
}

function maybeStartNightDeathShoot() {
	const deadIds = gameState.nightResult.deadIds || [];
	const causes = gameState.nightResult.causes || {};

	for (const id of deadIds) {
		const p = getPlayerById(id);
		if (!p || p.role !== "hunter") continue;

		const c = causes[String(id)] || [];
		const killedByWolf = c.includes("wolf");
		const poisoned = c.includes("poison");

		if (killedByWolf && !poisoned) {
			beginShootPhase(p, "night_death", "day_announce");
			return true;
		}
	}

	return false;
}

function processDayVoteOut(votedOut) {
	if (votedOut.role === "idiot" && !votedOut.isExposed) {
		votedOut.isExposed = true;
		votedOut.canVote = false;
		setPublicNotice(
			`Player ${votedOut.name} is Idiot: exposed, survives, loses vote right`,
		);
		emitAdminLog(`Day vote: ${votedOut.name} is Idiot, exposed and survives`);

		if (!applyVictoryIfNeeded()) {
			startNightRound(true);
		}
		return;
	}

	votedOut.alive = false;
	gameState.dayVote.votedOutId = votedOut.id;
	emitAdminLog(`Day vote out: ${votedOut.name}`);

	if (votedOut.role === "wolf_king" || votedOut.role === "hunter") {
		beginShootPhase(votedOut, "day_vote", "next_night");
		return;
	}

	if (!applyVictoryIfNeeded()) {
		startNightRound(true);
	}
}

function maybeVisibleRoleForViewer(player, viewer, viewerIsAdmin) {
	if (viewerIsAdmin) return player.role;
	if (viewer && viewer.id === player.id) return player.role;
	if (player.isExposed && player.role === "idiot") return player.role;
	return null;
}

function maybeVisibleModelIdForViewer(player, viewer, viewerIsAdmin) {
	if (player.role !== "hybrid") return null;
	if (viewerIsAdmin) return player.modelId || null;
	if (viewer && viewer.id === player.id) return player.modelId || null;
	return null;
}

function toPublicState(socketId) {
	const viewer = getPlayerBySocketId(socketId);
	const viewerIsAdmin = socketId === adminSocketId;
	const eligibleDayVoters = getEligibleDayVoters();
	const dayVotes = gameState.dayVote.votes || {};
	const dayVoteSubmittedCount = eligibleDayVoters.filter(
		(p) => dayVotes[p.id],
	).length;

	const players = gameState.players.map((p) => ({
		id: p.id,
		name: p.name,
		alive: p.alive,
		connected: p.connected,
		canVote: p.canVote,
		isExposed: p.isExposed,
		role: maybeVisibleRoleForViewer(p, viewer, viewerIsAdmin),
		modelId: maybeVisibleModelIdForViewer(p, viewer, viewerIsAdmin),
	}));

	return {
		phase: gameState.phase,
		round: gameState.round,
		gameMode: gameState.gameMode,
		hostPlayerId: gameState.hostPlayerId,
		isAdmin: viewerIsAdmin,
		me: viewer
			? {
					id: viewer.id,
					name: viewer.name,
					role: viewer.role,
					alive: viewer.alive,
					connected: viewer.connected,
					canVote: viewer.canVote,
					isExposed: viewer.isExposed,
					modelId: viewer.modelId || null,
				}
			: null,
		players,
		nightResult: {
			deadIds: [...gameState.nightResult.deadIds],
		},
		dayVote: {
			votedOutId: gameState.dayVote.votedOutId,
			shotTargetId: gameState.dayVote.shotTargetId,
			myVoteTargetId: viewer ? dayVotes[viewer.id] || null : null,
			submittedCount: dayVoteSubmittedCount,
			eligibleCount: eligibleDayVoters.length,
		},
		witchPrompt:
			gameState.phase === PHASES.WITCH &&
			(viewerIsAdmin || (viewer && viewer.role === "witch" && viewer.alive))
				? createWitchPrompt()
				: null,
		shootPhase:
			gameState.phase === PHASES.SHOOT
				? {
						shooterId: gameState.shootPhase.shooterId,
						shooterRole: gameState.shootPhase.shooterRole,
						trigger: gameState.shootPhase.trigger,
					}
				: null,
		publicNotice: gameState.publicNotice,
		winner: gameState.winner,
	};
}

function emitState() {
	io.sockets.sockets.forEach((socket) => {
		socket.emit("update", toPublicState(socket.id));
	});
	syncPhaseTimer();
	saveStateToDisk();
}

function emitAdminLog(message) {
	if (adminSocketId) {
		const adminSocket = io.sockets.sockets.get(adminSocketId);
		if (adminSocket) {
			adminSocket.emit("admin-log", message);
		}
	}
}

function createSaveLabel(rawLabel) {
	const input = String(rawLabel || "").trim();
	if (input) return input.slice(0, 60);
	const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
	return `Save ${stamp}`;
}

function createSaveNotes(rawNotes) {
	const input = String(rawNotes || "").trim();
	return input.slice(0, 240);
}

function resolveSaverLabel(socketId) {
	const player = getPlayerBySocketId(socketId);
	if (player) return `${player.name} (#${player.id})`;
	if (socketId === adminSocketId) return "Admin Console";
	return `Socket ${socketId}`;
}

function saveCurrentGameSnapshot(rawLabel, rawNotes, savedBy) {
	const snapshot = serializeCurrentSnapshot();
	const now = new Date().toISOString();
	const entry = {
		id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
		label: createSaveLabel(rawLabel),
		notes: createSaveNotes(rawNotes),
		savedBy: String(savedBy || "Unknown"),
		savedAt: now,
		summary: buildSaveSummary(snapshot),
		snapshot,
	};

	const saves = readSavedGames();
	saves.unshift(entry);
	writeSavedGames(saves);
	return entry;
}

function loadGameSnapshotById(saveId) {
	const saves = readSavedGames();
	const entry = saves.find((s) => s.id === saveId);
	if (!entry || !entry.snapshot) return null;

	const connectedByToken = buildConnectedTokenMap();
	applySnapshot(entry.snapshot, { preserveConnectedByToken: connectedByToken });
	return entry;
}

function deleteGameSnapshotById(saveId) {
	const saves = readSavedGames();
	const filtered = saves.filter((s) => s.id !== saveId);
	if (filtered.length === saves.length) return false;
	writeSavedGames(filtered);
	return true;
}

function performHardReset(requestSocketId) {
	clearPhaseTimer();

	const requester = getPlayerBySocketId(requestSocketId);
	const requesterLabel = requester
		? `player ${requester.name} (#${requester.id})`
		: `socket ${requestSocketId}`;

	gameState = createInitialState();
	nextPlayerId = 1;
	adminSocketId = null;

	io.sockets.sockets.forEach((s) => {
		s.emit("hard-reset", {
			message: `Game hard reset by ${requesterLabel}`,
		});
	});

	emitState();
}

function startGameWithParticipants(
	participants,
	rolesConfig,
	mode,
	hostPlayerId,
	winCondition,
) {
	gameState.players.forEach((p) => {
		p.role = "spectator";
		p.alive = false;
		p.canVote = false;
		p.isExposed = false;
		p.modelId = null;
	});

	const deck = buildRoleDeck(rolesConfig, participants.length);
	participants.forEach((player, idx) => {
		player.role = deck[idx];
		player.alive = true;
		player.canVote = true;
		player.isExposed = false;
		player.modelId = null;
	});

	gameState.round = 1;
	gameState.gameStartedAt = Date.now();
	gameState.winner = null;
	gameState.gameMode = mode;
	gameState.winCondition = winCondition || "side-kill";
	gameState.hostPlayerId = mode === "self_moderated" ? hostPlayerId : null;
	gameState.witchAbilities = { saveUsed: false, poisonUsed: false };
	clearPublicNotice();
	startNightRound(false);
}

loadStateFromDisk();

io.on("connection", (socket) => {
	console.log("Player connected:", socket.id);

	socket.emit("update", toPublicState(socket.id));

	socket.on("join", (payload) => {
		const incomingName = typeof payload === "string" ? payload : payload?.name;
		const incomingToken =
			typeof payload === "object" && payload ? payload.token : null;

		const name = String(incomingName || "").trim();
		const token = String(incomingToken || "").trim();

		const existingBySocket = getPlayerBySocketId(socket.id);
		if (existingBySocket) {
			if (name) existingBySocket.name = name;
			existingBySocket.connected = true;
			emitState();
			return;
		}

		if (token) {
			const existingByToken = getPlayerByToken(token);
			if (existingByToken) {
				existingByToken.socketId = socket.id;
				existingByToken.connected = true;
				if (name) existingByToken.name = name;
				emitAdminLog(`${existingByToken.name} reconnected`);
				emitState();
				return;
			}
		}

		const playerToken = token || generateToken();
		const displayName = name || `閻溾晛顔?{nextPlayerId}`;

		gameState.players.push({
			id: nextPlayerId++,
			name: displayName,
			role: "unassigned",
			alive: true,
			token: playerToken,
			connected: true,
			socketId: socket.id,
			canVote: true,
			isExposed: false,
			modelId: null,
		});

		emitAdminLog(`${displayName} joined the room`);
		socket.emit("join-ack", {
			token: playerToken,
			id: nextPlayerId - 1,
			name: displayName,
		});
		emitState();
	});

	socket.on("admin-claim", () => {
		if (adminSocketId && adminSocketId !== socket.id) {
			socket.emit("admin-log", "An admin device is already active");
			return;
		}
		adminSocketId = socket.id;
		emitAdminLog("Admin control claimed");
		emitSaveListTo(socket);
		emitState();
	});

	socket.on("admin-release", () => {
		if (!isAdminSocket(socket)) return;
		adminSocketId = null;
		socket.emit("admin-log", "Admin control released");
		emitState();
	});

	socket.on("admin-transfer", (payload) => {
		if (!isAdminSocket(socket)) return;

		const targetPlayerId = Number(payload?.targetPlayerId);
		const targetPlayer = getPlayerById(targetPlayerId);
		if (!targetPlayer || !targetPlayer.connected || !targetPlayer.socketId) {
			socket.emit("admin-log", "Transfer failed: target player not connected");
			socket.emit("transfer-error", {
				message: "Target player is offline or not found",
			});
			return;
		}

		const previousAdminSocket = io.sockets.sockets.get(adminSocketId);
		adminSocketId = targetPlayer.socketId;

		if (previousAdminSocket && previousAdminSocket.id !== adminSocketId) {
			previousAdminSocket.emit("admin-revoked");
			previousAdminSocket.emit("admin-log", "Admin control transferred away");
		}

		const nextAdminSocket = io.sockets.sockets.get(adminSocketId);
		if (nextAdminSocket) {
			nextAdminSocket.emit("admin-granted");
			nextAdminSocket.emit(
				"admin-log",
				`You are now admin (transferred from ${socket.id})`,
			);
		}

		emitAdminLog(
			`Admin transferred to player ${targetPlayer.name} (#${targetPlayer.id})`,
		);
		emitState();
	});

	socket.on("hard-reset", () => {
		performHardReset(socket.id);
	});

	socket.on("list-saves", () => {
		if (!isAdminSocket(socket)) return;
		emitSaveListTo(socket);
	});

	socket.on("save-game", (payload) => {
		if (!isAdminSocket(socket)) return;
		const label = typeof payload?.label === "string" ? payload.label : "";
		const notes = typeof payload?.notes === "string" ? payload.notes : "";
		const savedBy = resolveSaverLabel(socket.id);
		const entry = saveCurrentGameSnapshot(label, notes, savedBy);
		emitAdminLog(`Saved game snapshot: ${entry.label} by ${entry.savedBy}`);
		emitSaveListTo(socket);
		emitState();
	});

	socket.on("load-game", (payload) => {
		if (!isAdminSocket(socket)) return;
		const saveId = String(payload?.saveId || "").trim();
		if (!saveId) return;

		const entry = loadGameSnapshotById(saveId);
		if (!entry) {
			socket.emit("admin-log", "Load failed: save not found");
			emitSaveListTo(socket);
			return;
		}

		adminSocketId = socket.id;
		clearPhaseTimer();
		emitAdminLog(`Loaded game snapshot: ${entry.label}`);
		emitSaveListTo(socket);
		emitState();
	});

	socket.on("delete-save", (payload) => {
		if (!isAdminSocket(socket)) return;
		const saveId = String(payload?.saveId || "").trim();
		if (!saveId) return;

		const ok = deleteGameSnapshotById(saveId);
		if (ok) {
			socket.emit("admin-log", "Saved snapshot deleted");
		} else {
			socket.emit("admin-log", "Delete failed: save not found");
		}
		emitSaveListTo(socket);
	});

	socket.on("admin-start", (payload) => {
		if (!isAdminSocket(socket)) return;

		const rolesConfig = payload?.rolesConfig || payload;
		const winCondition = payload?.winCondition || "side-kill";

		const participants = gameState.players.filter((p) => p.connected);
		if (participants.length < 4) {
			socket.emit("admin-log", "At least 4 connected players are required");
			return;
		}

		startGameWithParticipants(
			participants,
			rolesConfig,
			"admin_moderated",
			null,
			winCondition,
		);
		emitState();
	});

	socket.on("player-start-self", (payload) => {
		const starter = getPlayerBySocketId(socket.id);
		if (!starter || !starter.connected) return;
		if (gameState.phase !== PHASES.WAITING) return;

		const rolesConfig = payload?.rolesConfig || payload;
		const winCondition = payload?.winCondition || "side-kill";

		const participants = gameState.players.filter((p) => p.connected);
		if (participants.length < 4) {
			socket.emit("start-error", {
				message: "At least 4 connected players are required",
			});
			return;
		}

		startGameWithParticipants(
			participants,
			rolesConfig,
			"self_moderated",
			starter.id,
			winCondition,
		);
		emitAdminLog(`Self-moderated game started by ${starter.name}`);
		emitState();
	});

	socket.on("admin-next-phase", (nextPhase) => {
		if (!isAdminSocket(socket)) return;
		if (gameState.phase === PHASES.GAME_OVER) return;

		const allowed = new Set([
			PHASES.HYBRID,
			PHASES.WOLF,
			PHASES.WITCH,
			PHASES.SEER,
			PHASES.DAY_ANNOUNCE,
		]);
		if (!allowed.has(nextPhase)) return;

		if (
			gameState.round === 1 &&
			hasUnselectedHybrid() &&
			nextPhase !== PHASES.HYBRID &&
			gameState.phase !== PHASES.HYBRID
		) {
			socket.emit("admin-log", "Night 1 must run hybrid selection first");
			return;
		}

		if (nextPhase === PHASES.HYBRID) {
			if (gameState.round !== 1) {
				socket.emit("admin-log", "Hybrid selection only exists on night 1");
				return;
			}
			gameState.phase = PHASES.HYBRID;
			emitAdminLog("Entered hybrid phase");
			emitState();
			return;
		}

		if (
			gameState.phase === PHASES.WOLF &&
			nextPhase !== PHASES.WOLF &&
			hasWolfVoteTie()
		) {
			gameState.actions.wolfVotes = {};
			emitAdminLog("Wolf vote tied; revote required");
			emitState();
			return;
		}

		if (nextPhase === PHASES.WOLF) {
			if (gameState.phase === PHASES.DAY_ANNOUNCE) {
				startNightRound(true);
			} else {
				gameState.phase = PHASES.WOLF;
				emitAdminLog("Entered wolf phase");
			}
			emitState();
			return;
		}

		if (nextPhase === PHASES.DAY_ANNOUNCE) {
			transitionNightToDayAnnounce();
			return;
		}

		gameState.phase = nextPhase;
		if (nextPhase === PHASES.WITCH) {
			emitAdminLog("Entered witch phase");
		} else if (nextPhase === PHASES.SEER) {
			emitAdminLog("Entered seer phase");
		}
		emitState();
	});

	socket.on("admin-day-vote", (payload) => {
		if (!isAdminSocket(socket)) return;
		if (gameState.phase !== PHASES.DAY_ANNOUNCE) return;

		const targetId = Number(payload?.targetId);
		const votedOut = getPlayerById(targetId);
		if (!votedOut || !votedOut.alive) return;

		processDayVoteOut(votedOut);
		emitState();
	});

	socket.on("action", (data) => {
		const player = getPlayerBySocketId(socket.id);
		if (!player || !player.connected) return;
		if (!isGamePhaseRunning()) return;

		const type = String(data?.type || "");
		const targetId = Number(data?.targetId);

		const isShootAction =
			gameState.phase === PHASES.SHOOT &&
			type === "shoot" &&
			gameState.shootPhase.shooterId === player.id;

		if (!player.alive && !isShootAction) return;

		if (
			gameState.phase === PHASES.HYBRID &&
			player.role === "hybrid" &&
			type === "hybrid_model"
		) {
			if (gameState.round !== 1) return;
			if (player.modelId) return;

			const target = getPlayerById(targetId);
			if (!target || !target.alive || target.id === player.id) return;

			player.modelId = target.id;
			gameState.actions.hybridModels[player.id] = target.id;
			emitAdminLog(`Hybrid selected model: ${target.name}`);

			if (isSelfModeratedMode() && !hasUnselectedHybrid()) {
				gameState.phase = PHASES.WOLF;
				emitAdminLog("Self mode: entering wolf phase");
			}

			emitState();
			return;
		}

		if (
			gameState.phase === PHASES.WOLF &&
			isWolfTeamRole(player.role) &&
			type === "kill"
		) {
			const target = getPlayerById(targetId);
			if (!target || !target.alive || target.id === player.id) return;

			gameState.actions.wolfVotes[player.id] = target.id;
			emitAdminLog(`${player.name} submitted wolf vote`);

			if (isSelfModeratedMode()) {
				const aliveWolves = getAlivePlayersByRoleFilter((p) =>
					isWolfTeamRole(p.role),
				);
				const submitted = aliveWolves.filter(
					(w) => gameState.actions.wolfVotes[w.id],
				).length;
				if (
					aliveWolves.length > 0 &&
					submitted >= aliveWolves.length &&
					!hasWolfVoteTie()
				) {
					gameState.phase = PHASES.WITCH;
					emitAdminLog("Self mode: entering witch phase");
				}
			}

			emitState();
			return;
		}

		if (gameState.phase === PHASES.WITCH && player.role === "witch") {
			if (type === "save") {
				if (gameState.witchAbilities.saveUsed) return;
				const wolfTargetId = tallyWolfTarget();
				const wolfTarget = wolfTargetId ? getPlayerById(wolfTargetId) : null;
				if (!wolfTarget || !wolfTarget.alive || gameState.actions.witch.save)
					return;

				gameState.actions.witch.save = true;
				gameState.witchAbilities.saveUsed = true;
				emitAdminLog("Witch used antidote");
				emitState();
				return;
			}

			if (type === "poison") {
				if (gameState.witchAbilities.poisonUsed) return;
				const target = getPlayerById(targetId);
				if (!target || !target.alive || target.id === player.id) return;
				if (gameState.actions.witch.poisonTargetId !== null) return;

				gameState.actions.witch.poisonTargetId = target.id;
				gameState.witchAbilities.poisonUsed = true;
				emitAdminLog(`Witch poisoned ${target.name}`);
				emitState();
				return;
			}
		}

		if (
			gameState.phase === PHASES.SEER &&
			player.role === "seer" &&
			type === "check"
		) {
			const target = getPlayerById(targetId);
			if (!target || !target.alive || target.id === player.id) return;
			if (gameState.actions.seerChecks[player.id]) return;

			gameState.actions.seerChecks[player.id] = target.id;
			socket.emit("seer-result", {
				name: target.name,
				isGood: target.role === "hybrid" ? true : !isWolfTeamRole(target.role),
			});
			emitAdminLog(`Seer checked ${target.name}`);

			if (isSelfModeratedMode()) {
				transitionNightToDayAnnounce();
				return;
			}

			emitState();
			return;
		}

		if (
			gameState.phase === PHASES.DAY_ANNOUNCE &&
			isSelfModeratedMode() &&
			type === "day_vote"
		) {
			if (!player.alive || !player.canVote) return;

			const target = getPlayerById(targetId);
			if (!target || !target.alive) return;

			gameState.dayVote.votes[player.id] = target.id;
			emitAdminLog(`Self mode: ${player.name} voted`);

			const eligible = getEligibleDayVoters();
			const submitted = eligible.filter(
				(p) => gameState.dayVote.votes[p.id],
			).length;
			if (eligible.length > 0 && submitted >= eligible.length) {
				finalizeSelfModeratedDayVote();
				return;
			}

			emitState();
			return;
		}

		if (isShootAction) {
			const target = getPlayerById(targetId);
			if (!target || !target.alive || target.id === player.id) return;

			target.alive = false;
			if (!gameState.nightResult.deadIds.includes(target.id)) {
				gameState.nightResult.deadIds.push(target.id);
			}
			gameState.dayVote.shotTargetId = target.id;
			gameState.shootPhase.shotTargetId = target.id;
			addDeathCause(gameState.nightResult.causes, target.id, "shot");

			const shooterRoleLabel =
				player.role === "hunter" ? "hunter" : "wolf king";
			emitAdminLog(`${shooterRoleLabel} shot ${target.name}`);
			setPublicNotice(`${shooterRoleLabel} shot ${target.name}`);

			continueAfterShootPhase();
		}
	});

	socket.on("disconnect", () => {
		const leavingPlayer = getPlayerBySocketId(socket.id);

		if (adminSocketId === socket.id) {
			adminSocketId = null;
			emitAdminLog("Admin device disconnected, control can be reclaimed");
		}

		if (leavingPlayer) {
			leavingPlayer.socketId = null;
			leavingPlayer.connected = false;
			emitAdminLog(`${leavingPlayer.name} disconnected`);
		}

		emitState();
	});
});

const PORT = Number(process.env.PORT) || 3000;
http.listen(PORT, () => {
	console.log("\\n>>> 游戏服务器已启动! <<<");
	console.log(
		`请让大家连接同一 Wi-Fi，并在浏览器输入: http://${getLocalIP()}:${PORT}\n`,
	);
});

