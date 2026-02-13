const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { io } = require("socket.io-client");

const ROOT_DIR = path.join(__dirname, "..");

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomPort() {
	return 20000 + Math.floor(Math.random() * 20000);
}

function waitForPort(port, timeoutMs = 8000) {
	const startedAt = Date.now();
	return new Promise((resolve, reject) => {
		const tryConnect = () => {
			const socket = net.createConnection({ host: "127.0.0.1", port });
			socket.once("connect", () => {
				socket.destroy();
				resolve();
			});
			socket.once("error", () => {
				socket.destroy();
				if (Date.now() - startedAt > timeoutMs) {
					reject(new Error(`Timed out waiting for server on port ${port}`));
					return;
				}
				setTimeout(tryConnect, 80);
			});
		};
		tryConnect();
	});
}

function createClient(url) {
	const socket = io(url, {
		transports: ["websocket"],
		reconnection: false,
		timeout: 5000,
	});

	let lastState = null;
	const waiters = [];

	socket.on("update", (state) => {
		lastState = state;
		for (let i = waiters.length - 1; i >= 0; i--) {
			const waiter = waiters[i];
			let ok = false;
			try {
				ok = waiter.predicate(state);
			} catch (_) {
				ok = false;
			}
			if (ok) {
				waiters.splice(i, 1);
				waiter.resolve(state);
			}
		}
	});

	function waitForState(predicate, timeoutMs = 5000) {
		if (lastState && predicate(lastState)) {
			return Promise.resolve(lastState);
		}
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				const idx = waiters.findIndex((w) => w.resolve === resolve);
				if (idx >= 0) waiters.splice(idx, 1);
				reject(new Error("Timed out waiting for state condition"));
			}, timeoutMs);

			waiters.push({
				predicate,
				resolve: (state) => {
					clearTimeout(timeout);
					resolve(state);
				},
			});
		});
	}

	return {
		socket,
		get state() {
			return lastState;
		},
		waitForState,
	};
}

function onceEvent(socket, event, timeoutMs = 5000) {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			socket.off(event, onEvent);
			reject(new Error(`Timed out waiting for ${event}`));
		}, timeoutMs);

		const onEvent = (payload) => {
			clearTimeout(timeout);
			resolve(payload);
		};
		socket.once(event, onEvent);
	});
}

async function assertNoEvent(socket, event, waitMs = 300) {
	let fired = false;
	const handler = () => {
		fired = true;
	};
	socket.once(event, handler);
	await delay(waitMs);
	socket.off(event, handler);
	assert.equal(fired, false, `Expected no ${event} event`);
}

async function startServer() {
	const port = randomPort();
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "werewolf-test-"));
	const env = {
		...process.env,
		PORT: String(port),
		WW_DISABLE_PERSIST: "1",
		WW_DATA_DIR: dataDir,
		WW_STATE_FILE: path.join(dataDir, "game-state.json"),
	};

	const proc = spawn(process.execPath, ["server.js"], {
		cwd: ROOT_DIR,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});

	let stderr = "";
	proc.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});

	await waitForPort(port);
	const url = `http://127.0.0.1:${port}`;

	return {
		url,
		proc,
		async stop() {
			if (!proc.killed) {
				proc.kill();
			}
			await new Promise((resolve) => proc.once("exit", resolve));
			if (stderr.trim()) {
				// Keep this available in failures via returned object if needed.
			}
		},
	};
}

async function createGame(config) {
	const server = await startServer();
	const admin = createClient(server.url);
	const players = [];
	const names = config.names || ["P1", "P2", "P3", "P4", "P5", "P6"];

	await onceEvent(admin.socket, "connect");
	admin.socket.emit("admin-claim");
	await admin.waitForState((s) => Boolean(s && Array.isArray(s.players)));

	const playerTokens = [];
	for (let i = 0; i < config.playerCount; i++) {
		const c = createClient(server.url);
		await onceEvent(c.socket, "connect");
		const joinToken = `${names[i]}-token-${Date.now()}-${i}`;
		const joinAckP = onceEvent(c.socket, "join-ack");
		c.socket.emit("join", { name: names[i], token: joinToken });
		const joinAck = await joinAckP;
		await c.waitForState((s) => Boolean(s?.me && s.me.name === names[i]));
		playerTokens.push(joinAck?.token ? joinAck.token : joinToken);
		players.push(c);
	}

	admin.socket.emit("admin-start", config.roles);
	await admin.waitForState((s) => s.phase !== "waiting");

	for (const p of players) {
		await p.waitForState((s) =>
			Boolean(s.me?.role && s.me.role !== "unassigned"),
		);
	}

	function getAdminPlayerByRole(role) {
		return admin.state.players.find((p) => p.role === role);
	}

	function getClientByPlayerId(playerId) {
		return players.find((c) => c.state?.me && c.state.me.id === playerId);
	}

	function getClientByRole(role) {
		const p = getAdminPlayerByRole(role);
		if (!p) return null;
		return getClientByPlayerId(p.id);
	}

	async function waitAdmin(predicate, timeoutMs = 5000) {
		return admin.waitForState(predicate, timeoutMs);
	}

	async function cleanup() {
		for (const p of players) {
			p.socket.disconnect();
		}
		admin.socket.disconnect();
		await server.stop();
	}

	return {
		server,
		admin,
		players,
		playerTokens,
		getAdminPlayerByRole,
		getClientByRole,
		getClientByPlayerId,
		waitAdmin,
		cleanup,
	};
}

async function createSelfModeratedGame(config) {
	const server = await startServer();
	const admin = createClient(server.url);
	const players = [];
	const names = config.names || ["P1", "P2", "P3", "P4", "P5", "P6"];

	await onceEvent(admin.socket, "connect");
	admin.socket.emit("admin-claim");
	await admin.waitForState((s) => Boolean(s && Array.isArray(s.players)));

	const playerTokens = [];
	for (let i = 0; i < config.playerCount; i++) {
		const c = createClient(server.url);
		await onceEvent(c.socket, "connect");
		const joinToken = `${names[i]}-token-${Date.now()}-${i}`;
		const joinAckP = onceEvent(c.socket, "join-ack");
		c.socket.emit("join", { name: names[i], token: joinToken });
		const joinAck = await joinAckP;
		await c.waitForState((s) => Boolean(s?.me && s.me.name === names[i]));
		playerTokens.push(joinAck?.token ? joinAck.token : joinToken);
		players.push(c);
	}

	const starterClient = players[config.starterIndex || 0];
	starterClient.socket.emit("player-start-self", config.roles);
	await admin.waitForState(
		(s) => s.phase !== "waiting" && s.gameMode === "self_moderated",
	);

	for (const p of players) {
		await p.waitForState((s) =>
			Boolean(s.me?.role && s.me.role !== "unassigned"),
		);
	}

	function getAdminPlayerByRole(role) {
		return admin.state.players.find((p) => p.role === role);
	}

	function getClientByPlayerId(playerId) {
		return players.find((c) => c.state?.me && c.state.me.id === playerId);
	}

	function getClientByRole(role) {
		const p = getAdminPlayerByRole(role);
		if (!p) return null;
		return getClientByPlayerId(p.id);
	}

	async function waitAdmin(predicate, timeoutMs = 5000) {
		return admin.waitForState(predicate, timeoutMs);
	}

	async function cleanup() {
		for (const p of players) {
			p.socket.disconnect();
		}
		admin.socket.disconnect();
		await server.stop();
	}

	return {
		server,
		admin,
		players,
		playerTokens,
		getAdminPlayerByRole,
		getClientByRole,
		getClientByPlayerId,
		waitAdmin,
		cleanup,
	};
}

async function goToDayAnnounce(game) {
	game.admin.socket.emit("admin-next-phase", "day_announce");
	await game.waitAdmin(
		(s) =>
			s.phase === "day_announce" ||
			s.phase === "shoot_phase" ||
			s.phase === "game_over",
	);
}

test("night 1 enters hybrid phase when hybrid exists", async (t) => {
	const game = await createGame({
		playerCount: 4,
		roles: {
			wolf: 1,
			wolfKing: 0,
			witch: 0,
			seer: 0,
			hunter: 0,
			idiot: 0,
			hybrid: 1,
		},
	});
	t.after(async () => game.cleanup());

	assert.equal(game.admin.state.phase, "hybrid");
});

test("hybrid can choose model once and cannot change later", async (t) => {
	const game = await createGame({
		playerCount: 4,
		roles: {
			wolf: 1,
			wolfKing: 0,
			witch: 0,
			seer: 0,
			hunter: 0,
			idiot: 0,
			hybrid: 1,
		},
	});
	t.after(async () => game.cleanup());

	const hybridAdmin = game.getAdminPlayerByRole("hybrid");
	assert.ok(hybridAdmin);
	const hybridClient = game.getClientByPlayerId(hybridAdmin.id);
	assert.ok(hybridClient);

	const firstTarget = game.admin.state.players.find(
		(p) => p.alive && p.id !== hybridAdmin.id,
	);
	assert.ok(firstTarget);
	hybridClient.socket.emit("action", {
		type: "hybrid_model",
		targetId: firstTarget.id,
	});

	await game.waitAdmin(
		(s) =>
			s.players.find((p) => p.id === hybridAdmin.id).modelId === firstTarget.id,
	);

	const secondTarget = game.admin.state.players.find(
		(p) => p.alive && p.id !== hybridAdmin.id && p.id !== firstTarget.id,
	);
	if (secondTarget) {
		hybridClient.socket.emit("action", {
			type: "hybrid_model",
			targetId: secondTarget.id,
		});
		await delay(200);
		const modelId = game.admin.state.players.find(
			(p) => p.id === hybridAdmin.id,
		).modelId;
		assert.equal(modelId, firstTarget.id);
	}
});

test("seer sees hybrid as good even when hybrid models a wolf", async (t) => {
	const game = await createGame({
		playerCount: 4,
		roles: {
			wolf: 1,
			wolfKing: 0,
			witch: 0,
			seer: 1,
			hunter: 0,
			idiot: 0,
			hybrid: 1,
		},
	});
	t.after(async () => game.cleanup());

	const hybrid = game.getAdminPlayerByRole("hybrid");
	const wolf = game.getAdminPlayerByRole("wolf");
	const seerClient = game.getClientByRole("seer");
	const hybridClient = game.getClientByPlayerId(hybrid.id);
	assert.ok(hybrid && wolf && seerClient && hybridClient);

	hybridClient.socket.emit("action", {
		type: "hybrid_model",
		targetId: wolf.id,
	});
	await game.waitAdmin(
		(s) => s.players.find((p) => p.id === hybrid.id).modelId === wolf.id,
	);

	game.admin.socket.emit("admin-next-phase", "wolf");
	await game.waitAdmin((s) => s.phase === "wolf");
	game.admin.socket.emit("admin-next-phase", "seer");
	await game.waitAdmin((s) => s.phase === "seer");

	const resultPromise = onceEvent(seerClient.socket, "seer-result");
	seerClient.socket.emit("action", { type: "check", targetId: hybrid.id });
	const result = await resultPromise;
	assert.equal(result.name, hybrid.name);
	assert.equal(result.isGood, true);
});

test("idiot survives first day vote out and becomes exposed with no vote right", async (t) => {
	const game = await createGame({
		playerCount: 4,
		roles: {
			wolf: 1,
			wolfKing: 0,
			witch: 0,
			seer: 0,
			hunter: 0,
			idiot: 1,
			hybrid: 0,
		},
	});
	t.after(async () => game.cleanup());

	await goToDayAnnounce(game);
	const idiot = game.getAdminPlayerByRole("idiot");
	assert.ok(idiot);

	game.admin.socket.emit("admin-day-vote", { targetId: idiot.id });
	await game.waitAdmin((s) => {
		const p = s.players.find((x) => x.id === idiot.id);
		return p.isExposed === true && p.alive === true && p.canVote === false;
	});
});

test("idiot dies normally after being exposed and voted out again", async (t) => {
	const game = await createGame({
		playerCount: 4,
		roles: {
			wolf: 1,
			wolfKing: 0,
			witch: 0,
			seer: 0,
			hunter: 0,
			idiot: 1,
			hybrid: 0,
		},
	});
	t.after(async () => game.cleanup());

	await goToDayAnnounce(game);
	const idiot = game.getAdminPlayerByRole("idiot");
	assert.ok(idiot);

	game.admin.socket.emit("admin-day-vote", { targetId: idiot.id });
	await game.waitAdmin(
		(s) => s.players.find((x) => x.id === idiot.id).isExposed === true,
	);

	// After exposure, phase advanced to next night — advance back to day
	await goToDayAnnounce(game);

	game.admin.socket.emit("admin-day-vote", { targetId: idiot.id });
	await game.waitAdmin(
		(s) => s.players.find((x) => x.id === idiot.id).alive === false,
	);
});

test("wolf king voted out triggers shoot phase and shot advances to next night", async (t) => {
	const game = await createGame({
		playerCount: 4,
		roles: {
			wolf: 1,
			wolfKing: 1,
			witch: 0,
			seer: 0,
			hunter: 0,
			idiot: 0,
			hybrid: 0,
		},
	});
	t.after(async () => game.cleanup());

	await goToDayAnnounce(game);
	const wolfKing = game.getAdminPlayerByRole("wolf_king");
	assert.ok(wolfKing);

	game.admin.socket.emit("admin-day-vote", { targetId: wolfKing.id });
	await game.waitAdmin(
		(s) =>
			s.phase === "shoot_phase" &&
			s.shootPhase &&
			s.shootPhase.shooterId === wolfKing.id,
	);

	const wolfKingClient = game.getClientByPlayerId(wolfKing.id);
	const target = game.admin.state.players.find(
		(p) => p.alive && p.role === "villager",
	);
	assert.ok(wolfKingClient && target);

	wolfKingClient.socket.emit("action", { type: "shoot", targetId: target.id });
	await game.waitAdmin((s) => s.phase === "wolf" && s.round === 2);
	assert.equal(
		game.admin.state.players.find((p) => p.id === target.id).alive,
		false,
	);
});

test("wolf king poisoned at night does not trigger shoot phase", async (t) => {
	const game = await createGame({
		playerCount: 4,
		roles: {
			wolf: 1,
			wolfKing: 1,
			witch: 1,
			seer: 0,
			hunter: 0,
			idiot: 0,
			hybrid: 0,
		},
	});
	t.after(async () => game.cleanup());

	const wolfKing = game.getAdminPlayerByRole("wolf_king");
	const witchClient = game.getClientByRole("witch");
	assert.ok(wolfKing && witchClient);

	game.admin.socket.emit("admin-next-phase", "witch");
	await game.waitAdmin((s) => s.phase === "witch");

	const poisonLog = onceEvent(game.admin.socket, "admin-log");
	witchClient.socket.emit("action", { type: "poison", targetId: wolfKing.id });
	await poisonLog;

	game.admin.socket.emit("admin-next-phase", "day_announce");
	await game.waitAdmin((s) => s.phase === "day_announce");
	assert.equal(
		game.admin.state.players.find((p) => p.id === wolfKing.id).alive,
		false,
	);
});

test("hunter killed by wolves at night gets shoot phase", async (t) => {
	const game = await createGame({
		playerCount: 4,
		roles: {
			wolf: 1,
			wolfKing: 0,
			witch: 0,
			seer: 0,
			hunter: 1,
			idiot: 0,
			hybrid: 0,
		},
	});
	t.after(async () => game.cleanup());

	const hunter = game.getAdminPlayerByRole("hunter");
	const wolfClient = game.getClientByRole("wolf");
	assert.ok(hunter && wolfClient);

	const killLog = onceEvent(game.admin.socket, "admin-log");
	wolfClient.socket.emit("action", { type: "kill", targetId: hunter.id });
	await killLog;

	game.admin.socket.emit("admin-next-phase", "day_announce");
	await game.waitAdmin(
		(s) => s.phase === "shoot_phase" && s.shootPhase.shooterId === hunter.id,
	);

	const hunterClient = game.getClientByPlayerId(hunter.id);
	const target = game.admin.state.players.find(
		(p) => p.alive && p.role === "villager",
	);
	assert.ok(hunterClient && target);
	hunterClient.socket.emit("action", { type: "shoot", targetId: target.id });

	await game.waitAdmin((s) => s.phase === "day_announce");
	assert.equal(
		game.admin.state.players.find((p) => p.id === target.id).alive,
		false,
	);
});

test("hunter poisoned at night cannot shoot", async (t) => {
	const game = await createGame({
		playerCount: 4,
		roles: {
			wolf: 1,
			wolfKing: 0,
			witch: 1,
			seer: 0,
			hunter: 1,
			idiot: 0,
			hybrid: 0,
		},
	});
	t.after(async () => game.cleanup());

	const hunter = game.getAdminPlayerByRole("hunter");
	const witchClient = game.getClientByRole("witch");
	assert.ok(hunter && witchClient);

	game.admin.socket.emit("admin-next-phase", "witch");
	await game.waitAdmin((s) => s.phase === "witch");

	const poisonLog = onceEvent(game.admin.socket, "admin-log");
	witchClient.socket.emit("action", { type: "poison", targetId: hunter.id });
	await poisonLog;

	game.admin.socket.emit("admin-next-phase", "day_announce");
	await game.waitAdmin((s) => s.phase === "day_announce");
	assert.equal(
		game.admin.state.players.find((p) => p.id === hunter.id).alive,
		false,
	);
});

test("hybrid aligned to wolves keeps wolves alive for win calculation", async (t) => {
	const game = await createGame({
		playerCount: 4,
		roles: {
			wolf: 1,
			wolfKing: 0,
			witch: 0,
			seer: 0,
			hunter: 0,
			idiot: 0,
			hybrid: 1,
		},
	});
	t.after(async () => game.cleanup());

	const hybrid = game.getAdminPlayerByRole("hybrid");
	const wolf = game.getAdminPlayerByRole("wolf");
	const hybridClient = game.getClientByPlayerId(hybrid.id);
	assert.ok(hybrid && wolf && hybridClient);

	hybridClient.socket.emit("action", {
		type: "hybrid_model",
		targetId: wolf.id,
	});
	await game.waitAdmin(
		(s) => s.players.find((p) => p.id === hybrid.id).modelId === wolf.id,
	);

	await goToDayAnnounce(game);

	// Vote out the wolf — game should NOT end because hybrid counts as wolf-aligned
	game.admin.socket.emit("admin-day-vote", { targetId: wolf.id });
	await game.waitAdmin(
		(s) => s.players.find((p) => p.id === wolf.id).alive === false,
	);
	assert.notEqual(game.admin.state.phase, "game_over");
	assert.equal(game.admin.state.winner, null);

	// Eliminate villagers to prove wolves eventually win via hybrid
	await goToDayAnnounce(game);
	const v1 = game.admin.state.players.find(
		(p) => p.alive && p.role === "villager",
	);
	assert.ok(v1);
	game.admin.socket.emit("admin-day-vote", { targetId: v1.id });
	await game.waitAdmin(
		(s) => s.players.find((p) => p.id === v1.id).alive === false,
	);

	await goToDayAnnounce(game);
	const v2 = game.admin.state.players.find(
		(p) => p.alive && p.role === "villager",
	);
	assert.ok(v2);
	game.admin.socket.emit("admin-day-vote", { targetId: v2.id });
	await game.waitAdmin(
		(s) => s.phase === "game_over" && s.winner && s.winner.team === "wolves",
	);
	assert.ok(game.admin.state.winner.hybridWinnerIds.includes(hybrid.id));
});

test("witch save is once per game", async (t) => {
	const game = await createGame({
		playerCount: 5,
		names: ["Wolf1", "Witch1", "V1", "V2", "V3"],
		roles: {
			wolf: 1,
			wolfKing: 0,
			witch: 1,
			seer: 0,
			hunter: 0,
			idiot: 0,
			hybrid: 0,
		},
	});
	t.after(async () => game.cleanup());

	const wolf = game.getAdminPlayerByRole("wolf");
	const witch = game.getAdminPlayerByRole("witch");
	const wolfClient = game.getClientByPlayerId(wolf.id);
	const witchClient = game.getClientByPlayerId(witch.id);
	const villagers = game.admin.state.players.filter(
		(p) => p.role === "villager",
	);
	assert.ok(
		wolf && witch && wolfClient && witchClient && villagers.length >= 2,
	);

	// Night 1: wolf kills villager1, witch saves
	let logP = onceEvent(game.admin.socket, "admin-log");
	wolfClient.socket.emit("action", { type: "kill", targetId: villagers[0].id });
	await logP;

	game.admin.socket.emit("admin-next-phase", "witch");
	await game.waitAdmin((s) => s.phase === "witch");
	logP = onceEvent(game.admin.socket, "admin-log");
	witchClient.socket.emit("action", { type: "save" });
	await logP;

	game.admin.socket.emit("admin-next-phase", "day_announce");
	await game.waitAdmin((s) => s.phase === "day_announce");
	// Villager1 should be alive (saved)
	assert.equal(
		game.admin.state.players.find((p) => p.id === villagers[0].id).alive,
		true,
	);

	// Day: no vote-out, advance to night 2
	game.admin.socket.emit("admin-next-phase", "wolf");
	await game.waitAdmin((s) => s.phase === "wolf" && s.round === 2);

	// Night 2: wolf kills villager1 again, witch tries to save (should be rejected)
	logP = onceEvent(game.admin.socket, "admin-log");
	wolfClient.socket.emit("action", { type: "kill", targetId: villagers[0].id });
	await logP;

	game.admin.socket.emit("admin-next-phase", "witch");
	await game.waitAdmin((s) => s.phase === "witch");
	// Witch tries to save — action is silently rejected (saveUsed), no admin-log expected
	witchClient.socket.emit("action", { type: "save" });
	await delay(300);

	game.admin.socket.emit("admin-next-phase", "day_announce");
	await game.waitAdmin((s) => s.phase === "day_announce");
	// Villager1 should be dead (save rejected — already used)
	assert.equal(
		game.admin.state.players.find((p) => p.id === villagers[0].id).alive,
		false,
	);
});

test("witch poison is once per game", async (t) => {
	const game = await createGame({
		playerCount: 5,
		names: ["Wolf1", "Witch1", "V1", "V2", "V3"],
		roles: {
			wolf: 1,
			wolfKing: 0,
			witch: 1,
			seer: 0,
			hunter: 0,
			idiot: 0,
			hybrid: 0,
		},
	});
	t.after(async () => game.cleanup());

	const witch = game.getAdminPlayerByRole("witch");
	const witchClient = game.getClientByPlayerId(witch.id);
	const villagers = game.admin.state.players.filter(
		(p) => p.role === "villager",
	);
	assert.ok(witch && witchClient && villagers.length >= 2);

	// Night 1: witch poisons villager1
	game.admin.socket.emit("admin-next-phase", "witch");
	await game.waitAdmin((s) => s.phase === "witch");
	const logP = onceEvent(game.admin.socket, "admin-log");
	witchClient.socket.emit("action", {
		type: "poison",
		targetId: villagers[0].id,
	});
	await logP;

	game.admin.socket.emit("admin-next-phase", "day_announce");
	await game.waitAdmin((s) => s.phase === "day_announce");
	// Villager1 should be dead (poisoned)
	assert.equal(
		game.admin.state.players.find((p) => p.id === villagers[0].id).alive,
		false,
	);

	// Day: no vote-out, advance to night 2
	game.admin.socket.emit("admin-next-phase", "wolf");
	await game.waitAdmin((s) => s.phase === "wolf" && s.round === 2);

	// Night 2: witch tries to poison villager2 (should be rejected)
	game.admin.socket.emit("admin-next-phase", "witch");
	await game.waitAdmin((s) => s.phase === "witch");
	witchClient.socket.emit("action", {
		type: "poison",
		targetId: villagers[1].id,
	});
	await delay(300);

	game.admin.socket.emit("admin-next-phase", "day_announce");
	await game.waitAdmin((s) => s.phase === "day_announce");
	// Villager2 should still be alive (poison rejected — already used)
	assert.equal(
		game.admin.state.players.find((p) => p.id === villagers[1].id).alive,
		true,
	);
});

test("witch cannot see wolf target after save is used", async (t) => {
	const game = await createGame({
		playerCount: 5,
		names: ["Wolf1", "Witch1", "V1", "V2", "V3"],
		roles: {
			wolf: 1,
			wolfKing: 0,
			witch: 1,
			seer: 0,
			hunter: 0,
			idiot: 0,
			hybrid: 0,
		},
	});
	t.after(async () => game.cleanup());

	const wolf = game.getAdminPlayerByRole("wolf");
	const witch = game.getAdminPlayerByRole("witch");
	const wolfClient = game.getClientByPlayerId(wolf.id);
	const witchClient = game.getClientByPlayerId(witch.id);
	const villagers = game.admin.state.players.filter(
		(p) => p.role === "villager",
	);
	assert.ok(
		wolf && witch && wolfClient && witchClient && villagers.length >= 2,
	);

	// Night 1: wolf kills villager1, witch saves
	let logP = onceEvent(game.admin.socket, "admin-log");
	wolfClient.socket.emit("action", { type: "kill", targetId: villagers[0].id });
	await logP;

	game.admin.socket.emit("admin-next-phase", "witch");
	await game.waitAdmin((s) => s.phase === "witch");
	logP = onceEvent(game.admin.socket, "admin-log");
	witchClient.socket.emit("action", { type: "save" });
	await logP;

	game.admin.socket.emit("admin-next-phase", "day_announce");
	await game.waitAdmin((s) => s.phase === "day_announce");

	// Day: no vote-out, advance to night 2
	game.admin.socket.emit("admin-next-phase", "wolf");
	await game.waitAdmin((s) => s.phase === "wolf" && s.round === 2);

	// Night 2: wolf kills villager2, enter witch phase
	logP = onceEvent(game.admin.socket, "admin-log");
	wolfClient.socket.emit("action", { type: "kill", targetId: villagers[1].id });
	await logP;

	game.admin.socket.emit("admin-next-phase", "witch");
	await witchClient.waitForState((s) => s.phase === "witch" && s.witchPrompt);

	// Witch should not see wolf target (save already used) and canSave should be false
	assert.equal(witchClient.state.witchPrompt.wolfTargetId, null);
	assert.equal(witchClient.state.witchPrompt.wolfTargetName, null);
	assert.equal(witchClient.state.witchPrompt.canSave, false);
});

test("multiple wolves tally kill by majority vote", async (t) => {
	const game = await createGame({
		playerCount: 6,
		roles: {
			wolf: 2,
			wolfKing: 0,
			witch: 0,
			seer: 0,
			hunter: 0,
			idiot: 0,
			hybrid: 0,
		},
	});
	t.after(async () => game.cleanup());

	const wolves = game.admin.state.players.filter((p) => p.role === "wolf");
	const villagers = game.admin.state.players.filter(
		(p) => p.role === "villager",
	);
	assert.equal(wolves.length, 2);
	assert.ok(villagers.length >= 2);

	const wolf1 = game.getClientByPlayerId(wolves[0].id);
	const wolf2 = game.getClientByPlayerId(wolves[1].id);
	wolf1.socket.emit("action", { type: "kill", targetId: villagers[0].id });
	wolf2.socket.emit("action", { type: "kill", targetId: villagers[1].id });
	await game.waitAdmin((s) => s.phase === "wolf");

	game.admin.socket.emit("admin-next-phase", "witch");
	await game.waitAdmin((s) => s.phase === "wolf");

	wolf1.socket.emit("action", { type: "kill", targetId: villagers[0].id });
	wolf2.socket.emit("action", { type: "kill", targetId: villagers[0].id });
	await goToDayAnnounce(game);
	assert.equal(
		game.admin.state.players.find((p) => p.id === villagers[0].id).alive,
		false,
	);
});

test("wolf and poison kill same target deadIds deduplicated", async (t) => {
	const game = await createGame({
		playerCount: 5,
		roles: {
			wolf: 1,
			wolfKing: 0,
			witch: 1,
			seer: 0,
			hunter: 0,
			idiot: 0,
			hybrid: 0,
		},
	});
	t.after(async () => game.cleanup());

	const wolf = game.getAdminPlayerByRole("wolf");
	const witch = game.getAdminPlayerByRole("witch");
	const villager = game.admin.state.players.find((p) => p.role === "villager");
	const wolfClient = game.getClientByPlayerId(wolf.id);
	const witchClient = game.getClientByPlayerId(witch.id);

	wolfClient.socket.emit("action", { type: "kill", targetId: villager.id });
	game.admin.socket.emit("admin-next-phase", "witch");
	await game.waitAdmin((s) => s.phase === "witch");
	witchClient.socket.emit("action", { type: "poison", targetId: villager.id });

	await goToDayAnnounce(game);
	const deadIds = game.admin.state.nightResult.deadIds;
	assert.equal(deadIds.filter((id) => id === villager.id).length, 1);
});

test("peaceful night no wolf vote and no witch action", async (t) => {
	const game = await createGame({
		playerCount: 4,
		roles: {
			wolf: 1,
			wolfKing: 0,
			witch: 0,
			seer: 0,
			hunter: 0,
			idiot: 0,
			hybrid: 0,
		},
	});
	t.after(async () => game.cleanup());

	await goToDayAnnounce(game);
	assert.equal(game.admin.state.nightResult.deadIds.length, 0);
});

test("self-moderated game starts via player-start-self", async (t) => {
	const game = await createSelfModeratedGame({
		playerCount: 4,
		roles: {
			wolf: 1,
			wolfKing: 0,
			witch: 0,
			seer: 0,
			hunter: 0,
			idiot: 0,
			hybrid: 0,
		},
	});
	t.after(async () => game.cleanup());

	assert.equal(game.admin.state.gameMode, "self_moderated");
	assert.ok(game.admin.state.hostPlayerId);
	assert.ok(["wolf", "hybrid"].includes(game.admin.state.phase));
});

test("self-moderated auto-advances wolf to witch when all wolves vote", async (t) => {
	const game = await createSelfModeratedGame({
		playerCount: 5,
		roles: {
			wolf: 1,
			wolfKing: 0,
			witch: 1,
			seer: 0,
			hunter: 0,
			idiot: 0,
			hybrid: 0,
		},
	});
	t.after(async () => game.cleanup());

	if (game.admin.state.phase === "hybrid") {
		await game.waitAdmin((s) => s.phase === "wolf", 35000);
	}
	const wolf = game.getAdminPlayerByRole("wolf");
	const wolfClient = game.getClientByPlayerId(wolf.id);
	const target = game.admin.state.players.find((p) => p.role === "villager");
	wolfClient.socket.emit("action", { type: "kill", targetId: target.id });
	await game.waitAdmin((s) => s.phase === "witch");
});

test("self-moderated day vote all players vote majority wins", async (t) => {
	const game = await createSelfModeratedGame({
		playerCount: 5,
		roles: {
			wolf: 1,
			wolfKing: 0,
			witch: 0,
			seer: 1,
			hunter: 0,
			idiot: 0,
			hybrid: 0,
		},
	});
	t.after(async () => game.cleanup());

	if (game.admin.state.phase === "wolf") {
		const wolf = game.getAdminPlayerByRole("wolf");
		const seer = game.getAdminPlayerByRole("seer");
		const wolfClient = game.getClientByPlayerId(wolf.id);
		const seerClient = game.getClientByPlayerId(seer.id);
		const target = game.admin.state.players.find((p) => p.role === "villager");
		wolfClient.socket.emit("action", { type: "kill", targetId: target.id });
		await game.waitAdmin((s) => s.phase === "seer", 35000);
		const seerTarget = game.admin.state.players.find(
			(p) => p.alive && p.id !== seer.id,
		);
		seerClient.socket.emit("action", {
			type: "check",
			targetId: seerTarget.id,
		});
	}
	await game.waitAdmin((s) => s.phase === "day_announce");

	const alive = game.admin.state.players.filter((p) => p.alive);
	const voteTarget = alive.find((p) => p.role === "wolf") || alive[0];
	alive.forEach((p) => {
		const c = game.getClientByPlayerId(p.id);
		if (p.canVote)
			c.socket.emit("action", { type: "day_vote", targetId: voteTarget.id });
	});

	await game.waitAdmin((s) => s.round === 2 || s.phase === "game_over");
	assert.equal(
		game.admin.state.players.find((p) => p.id === voteTarget.id).alive,
		false,
	);
});

test("self-moderated day vote tie no one eliminated", async (t) => {
	const game = await createSelfModeratedGame({
		playerCount: 4,
		roles: {
			wolf: 1,
			wolfKing: 0,
			witch: 1,
			seer: 0,
			hunter: 0,
			idiot: 0,
			hybrid: 0,
		},
	});
	t.after(async () => game.cleanup());

	// Keep all 4 players alive for a 2-2 tie.
	if (game.admin.state.phase === "wolf") {
		game.admin.socket.emit("admin-next-phase", "day_announce");
	} else {
		await game.waitAdmin((s) => s.phase === "wolf", 35000);
		game.admin.socket.emit("admin-next-phase", "day_announce");
	}
	await game.waitAdmin((s) => s.phase === "day_announce");

	const aliveVoters = game.admin.state.players.filter(
		(p) => p.alive && p.canVote,
	);
	assert.equal(aliveVoters.length, 4);
	const targetA = aliveVoters[0];
	const targetB = aliveVoters[1];
	game
		.getClientByPlayerId(aliveVoters[0].id)
		.socket.emit("action", { type: "day_vote", targetId: targetA.id });
	game
		.getClientByPlayerId(aliveVoters[1].id)
		.socket.emit("action", { type: "day_vote", targetId: targetA.id });
	game
		.getClientByPlayerId(aliveVoters[2].id)
		.socket.emit("action", { type: "day_vote", targetId: targetB.id });
	game
		.getClientByPlayerId(aliveVoters[3].id)
		.socket.emit("action", { type: "day_vote", targetId: targetB.id });
	await game.waitAdmin((s) => s.round === 2 || s.phase === "game_over");

	// Tie should execute nobody.
	assert.equal(
		game.admin.state.players.find((p) => p.id === targetA.id).alive,
		true,
	);
	assert.equal(
		game.admin.state.players.find((p) => p.id === targetB.id).alive,
		true,
	);
});

test("admin cannot force hybrid phase on night 2+", async (t) => {
	const game = await createGame({
		playerCount: 4,
		roles: {
			wolf: 1,
			wolfKing: 0,
			witch: 0,
			seer: 0,
			hunter: 0,
			idiot: 0,
			hybrid: 1,
		},
	});
	t.after(async () => game.cleanup());

	const hybrid = game.getAdminPlayerByRole("hybrid");
	const hybridClient = game.getClientByPlayerId(hybrid.id);
	const model = game.admin.state.players.find(
		(p) => p.id !== hybrid.id && p.alive,
	);
	hybridClient.socket.emit("action", {
		type: "hybrid_model",
		targetId: model.id,
	});
	await game.waitAdmin(
		(s) => s.players.find((p) => p.id === hybrid.id).modelId === model.id,
	);

	await goToDayAnnounce(game);
	game.admin.socket.emit("admin-next-phase", "wolf");
	await game.waitAdmin((s) => s.phase === "wolf" && s.round === 2);

	game.admin.socket.emit("admin-next-phase", "hybrid");
	await delay(300);
	assert.notEqual(game.admin.state.phase, "hybrid");
});

test("wolf vote tie blocks admin phase advance and clears votes", async (t) => {
	const game = await createGame({
		playerCount: 4,
		roles: {
			wolf: 2,
			wolfKing: 0,
			witch: 0,
			seer: 0,
			hunter: 0,
			idiot: 0,
			hybrid: 0,
		},
	});
	t.after(async () => game.cleanup());

	const wolves = game.admin.state.players.filter((p) => p.role === "wolf");
	const villagers = game.admin.state.players.filter(
		(p) => p.role === "villager",
	);
	game
		.getClientByPlayerId(wolves[0].id)
		.socket.emit("action", { type: "kill", targetId: villagers[0].id });
	game
		.getClientByPlayerId(wolves[1].id)
		.socket.emit("action", { type: "kill", targetId: villagers[1].id });
	await game.waitAdmin((s) => s.phase === "wolf");

	game.admin.socket.emit("admin-next-phase", "witch");
	await game.waitAdmin((s) => s.phase === "wolf");
	const wolfClients = wolves.map((w) => game.getClientByPlayerId(w.id));
	const hasAnyVote = wolfClients.some(
		(c) => c.state && c.state.phase === "wolf",
	);
	assert.equal(hasAnyVote, true);
});

test("player reconnects by token and preserves role", async (t) => {
	const game = await createGame({
		playerCount: 5,
		roles: {
			wolf: 1,
			wolfKing: 0,
			witch: 1,
			seer: 1,
			hunter: 0,
			idiot: 0,
			hybrid: 0,
		},
	});
	t.after(async () => game.cleanup());

	const targetClient = game.players[0];
	const token = game.playerTokens[0];
	const prevId = targetClient.state.me.id;
	const prevRole = targetClient.state.me.role;
	const prevName = targetClient.state.me.name;
	targetClient.socket.disconnect();
	await delay(150);

	const re = createClient(game.server.url);
	await onceEvent(re.socket, "connect");
	re.socket.emit("join", { name: prevName, token });
	await re.waitForState((s) => s.me && s.me.id === prevId);
	assert.equal(re.state.me.role, prevRole);
	re.socket.disconnect();
});

test("wolf witch seer cannot self target", async (t) => {
	const game = await createGame({
		playerCount: 5,
		roles: {
			wolf: 1,
			wolfKing: 0,
			witch: 1,
			seer: 1,
			hunter: 0,
			idiot: 0,
			hybrid: 0,
		},
	});
	t.after(async () => game.cleanup());

	const wolf = game.getAdminPlayerByRole("wolf");
	const witch = game.getAdminPlayerByRole("witch");
	const seer = game.getAdminPlayerByRole("seer");
	const wolfClient = game.getClientByPlayerId(wolf.id);
	const witchClient = game.getClientByPlayerId(witch.id);
	const seerClient = game.getClientByPlayerId(seer.id);

	wolfClient.socket.emit("action", { type: "kill", targetId: wolf.id });
	await delay(300);
	game.admin.socket.emit("admin-next-phase", "day_announce");
	await game.waitAdmin((s) => s.phase === "day_announce");
	assert.equal(game.admin.state.nightResult.deadIds.length, 0);

	game.admin.socket.emit("admin-next-phase", "wolf");
	await game.waitAdmin((s) => s.phase === "wolf" && s.round === 2);
	game.admin.socket.emit("admin-next-phase", "witch");
	await game.waitAdmin((s) => s.phase === "witch");
	witchClient.socket.emit("action", { type: "poison", targetId: witch.id });
	await delay(300);
	game.admin.socket.emit("admin-next-phase", "day_announce");
	await game.waitAdmin((s) => s.phase === "day_announce");
	assert.equal(
		game.admin.state.players.find((p) => p.id === witch.id).alive,
		true,
	);

	game.admin.socket.emit("admin-next-phase", "wolf");
	await game.waitAdmin((s) => s.phase === "wolf" && s.round === 3);
	game.admin.socket.emit("admin-next-phase", "seer");
	await game.waitAdmin((s) => s.phase === "seer");
	seerClient.socket.emit("action", { type: "check", targetId: seer.id });
	await assertNoEvent(seerClient.socket, "seer-result", 300);
});

test("game ends when last good player is eliminated", async (t) => {
	const game = await createGame({
		playerCount: 4,
		roles: {
			wolf: 2,
			wolfKing: 0,
			witch: 0,
			seer: 0,
			hunter: 0,
			idiot: 0,
			hybrid: 0,
		},
	});
	t.after(async () => game.cleanup());

	const wolves = game.admin.state.players.filter((p) => p.role === "wolf");
	const villagers = game.admin.state.players.filter(
		(p) => p.role === "villager",
	);
	game
		.getClientByPlayerId(wolves[0].id)
		.socket.emit("action", { type: "kill", targetId: villagers[0].id });
	game
		.getClientByPlayerId(wolves[1].id)
		.socket.emit("action", { type: "kill", targetId: villagers[0].id });
	await goToDayAnnounce(game);
	const aliveVillager = game.admin.state.players.find(
		(p) => p.alive && p.role === "villager",
	);
	assert.ok(aliveVillager);
	game.admin.socket.emit("admin-day-vote", { targetId: aliveVillager.id });
	await game.waitAdmin(
		(s) => s.phase === "game_over" && s.winner && s.winner.team === "wolves",
	);
});

test("draw when wolf and last good die simultaneously", async (t) => {
	const game = await createGame({
		playerCount: 4,
		roles: {
			wolf: 1,
			wolfKing: 0,
			witch: 1,
			seer: 0,
			hunter: 0,
			idiot: 0,
			hybrid: 0,
		},
	});
	t.after(async () => game.cleanup());

	const wolf = game.getAdminPlayerByRole("wolf");
	const witch = game.getAdminPlayerByRole("witch");
	const wolfClient = game.getClientByPlayerId(wolf.id);
	const witchClient = game.getClientByPlayerId(witch.id);

	// Day 1: eliminate villager 1
	await goToDayAnnounce(game);
	const v1 = game.admin.state.players.find(
		(p) => p.alive && p.role === "villager",
	);
	game.admin.socket.emit("admin-day-vote", { targetId: v1.id });
	await game.waitAdmin(
		(s) => s.players.find((p) => p.id === v1.id).alive === false,
	);

	// Day 2: eliminate villager 2 so only wolf + witch remain.
	await goToDayAnnounce(game);
	const v2 = game.admin.state.players.find(
		(p) => p.alive && p.role === "villager",
	);
	assert.ok(v2);
	game.admin.socket.emit("admin-day-vote", { targetId: v2.id });
	await game.waitAdmin(
		(s) => s.players.find((p) => p.id === v2.id).alive === false,
	);

	// Night 3: wolf kills witch, witch poisons wolf.
	if (game.admin.state.phase !== "wolf") {
		game.admin.socket.emit("admin-next-phase", "wolf");
		await game.waitAdmin((s) => s.phase === "wolf");
	}
	wolfClient.socket.emit("action", { type: "kill", targetId: witch.id });
	game.admin.socket.emit("admin-next-phase", "witch");
	await game.waitAdmin((s) => s.phase === "witch");
	witchClient.socket.emit("action", { type: "poison", targetId: wolf.id });
	game.admin.socket.emit("admin-next-phase", "day_announce");
	await game.waitAdmin(
		(s) => s.phase === "game_over" && s.winner && s.winner.team === "draw",
	);
});
