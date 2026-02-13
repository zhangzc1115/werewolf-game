const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');

const ROOT_DIR = path.join(__dirname, '..');

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
            const socket = net.createConnection({ host: '127.0.0.1', port });
            socket.once('connect', () => {
                socket.destroy();
                resolve();
            });
            socket.once('error', () => {
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
        transports: ['websocket'],
        reconnection: false,
        timeout: 5000
    });

    let lastState = null;
    const waiters = [];

    socket.on('update', (state) => {
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
                reject(new Error('Timed out waiting for state condition'));
            }, timeoutMs);

            waiters.push({
                predicate,
                resolve: (state) => {
                    clearTimeout(timeout);
                    resolve(state);
                }
            });
        });
    }

    return {
        socket,
        get state() {
            return lastState;
        },
        waitForState
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

async function startServer() {
    const port = randomPort();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'werewolf-test-'));
    const env = {
        ...process.env,
        PORT: String(port),
        WW_DISABLE_PERSIST: '1',
        WW_DATA_DIR: dataDir,
        WW_STATE_FILE: path.join(dataDir, 'game-state.json')
    };

    const proc = spawn(process.execPath, ['server.js'], {
        cwd: ROOT_DIR,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let stderr = '';
    proc.stderr.on('data', (chunk) => {
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
            await new Promise((resolve) => proc.once('exit', resolve));
            if (stderr.trim()) {
                // Keep this available in failures via returned object if needed.
            }
        }
    };
}

async function createGame(config) {
    const server = await startServer();
    const admin = createClient(server.url);
    const players = [];
    const names = config.names || ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'];

    await onceEvent(admin.socket, 'connect');
    admin.socket.emit('admin-claim');
    await admin.waitForState((s) => Boolean(s && Array.isArray(s.players)));

    for (let i = 0; i < config.playerCount; i++) {
        const c = createClient(server.url);
        await onceEvent(c.socket, 'connect');
        c.socket.emit('join', { name: names[i], token: `${names[i]}-token-${Date.now()}-${i}` });
        await c.waitForState((s) => Boolean(s && s.me && s.me.name === names[i]));
        players.push(c);
    }

    admin.socket.emit('admin-start', config.roles);
    await admin.waitForState((s) => s.phase !== 'waiting');

    for (const p of players) {
        await p.waitForState((s) => Boolean(s.me && s.me.role && s.me.role !== 'unassigned'));
    }

    function getAdminPlayerByRole(role) {
        return admin.state.players.find((p) => p.role === role);
    }

    function getClientByPlayerId(playerId) {
        return players.find((c) => c.state && c.state.me && c.state.me.id === playerId);
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
        getAdminPlayerByRole,
        getClientByRole,
        getClientByPlayerId,
        waitAdmin,
        cleanup
    };
}

async function goToDayAnnounce(game) {
    game.admin.socket.emit('admin-next-phase', 'day_announce');
    await game.waitAdmin((s) => s.phase === 'day_announce' || s.phase === 'shoot_phase' || s.phase === 'game_over');
}

test('night 1 enters hybrid phase when hybrid exists', async (t) => {
    const game = await createGame({
        playerCount: 3,
        roles: { wolf: 1, wolfKing: 0, witch: 0, seer: 0, hunter: 0, idiot: 0, hybrid: 1 }
    });
    t.after(async () => game.cleanup());

    assert.equal(game.admin.state.phase, 'hybrid');
});

test('hybrid can choose model once and cannot change later', async (t) => {
    const game = await createGame({
        playerCount: 4,
        roles: { wolf: 1, wolfKing: 0, witch: 0, seer: 0, hunter: 0, idiot: 0, hybrid: 1 }
    });
    t.after(async () => game.cleanup());

    const hybridAdmin = game.getAdminPlayerByRole('hybrid');
    assert.ok(hybridAdmin);
    const hybridClient = game.getClientByPlayerId(hybridAdmin.id);
    assert.ok(hybridClient);

    const firstTarget = game.admin.state.players.find((p) => p.alive && p.id !== hybridAdmin.id);
    assert.ok(firstTarget);
    hybridClient.socket.emit('action', { type: 'hybrid_model', targetId: firstTarget.id });

    await game.waitAdmin((s) => s.players.find((p) => p.id === hybridAdmin.id).modelId === firstTarget.id);

    const secondTarget = game.admin.state.players.find((p) => p.alive && p.id !== hybridAdmin.id && p.id !== firstTarget.id);
    if (secondTarget) {
        hybridClient.socket.emit('action', { type: 'hybrid_model', targetId: secondTarget.id });
        await delay(200);
        const modelId = game.admin.state.players.find((p) => p.id === hybridAdmin.id).modelId;
        assert.equal(modelId, firstTarget.id);
    }
});

test('seer sees hybrid as good even when hybrid models a wolf', async (t) => {
    const game = await createGame({
        playerCount: 4,
        roles: { wolf: 1, wolfKing: 0, witch: 0, seer: 1, hunter: 0, idiot: 0, hybrid: 1 }
    });
    t.after(async () => game.cleanup());

    const hybrid = game.getAdminPlayerByRole('hybrid');
    const wolf = game.getAdminPlayerByRole('wolf');
    const seerClient = game.getClientByRole('seer');
    const hybridClient = game.getClientByPlayerId(hybrid.id);
    assert.ok(hybrid && wolf && seerClient && hybridClient);

    hybridClient.socket.emit('action', { type: 'hybrid_model', targetId: wolf.id });
    await game.waitAdmin((s) => s.players.find((p) => p.id === hybrid.id).modelId === wolf.id);

    game.admin.socket.emit('admin-next-phase', 'wolf');
    await game.waitAdmin((s) => s.phase === 'wolf');
    game.admin.socket.emit('admin-next-phase', 'seer');
    await game.waitAdmin((s) => s.phase === 'seer');

    const resultPromise = onceEvent(seerClient.socket, 'seer-result');
    seerClient.socket.emit('action', { type: 'check', targetId: hybrid.id });
    const result = await resultPromise;
    assert.equal(result.name, hybrid.name);
    assert.equal(result.isGood, true);
});

test('idiot survives first day vote out and becomes exposed with no vote right', async (t) => {
    const game = await createGame({
        playerCount: 3,
        roles: { wolf: 1, wolfKing: 0, witch: 0, seer: 0, hunter: 0, idiot: 1, hybrid: 0 }
    });
    t.after(async () => game.cleanup());

    await goToDayAnnounce(game);
    const idiot = game.getAdminPlayerByRole('idiot');
    assert.ok(idiot);

    game.admin.socket.emit('admin-day-vote', { targetId: idiot.id });
    await game.waitAdmin((s) => {
        const p = s.players.find((x) => x.id === idiot.id);
        return p.isExposed === true && p.alive === true && p.canVote === false;
    });
});

test('idiot dies normally after being exposed and voted out again', async (t) => {
    const game = await createGame({
        playerCount: 3,
        roles: { wolf: 1, wolfKing: 0, witch: 0, seer: 0, hunter: 0, idiot: 1, hybrid: 0 }
    });
    t.after(async () => game.cleanup());

    await goToDayAnnounce(game);
    const idiot = game.getAdminPlayerByRole('idiot');
    assert.ok(idiot);

    game.admin.socket.emit('admin-day-vote', { targetId: idiot.id });
    await game.waitAdmin((s) => s.players.find((x) => x.id === idiot.id).isExposed === true);

    game.admin.socket.emit('admin-day-vote', { targetId: idiot.id });
    await game.waitAdmin((s) => s.players.find((x) => x.id === idiot.id).alive === false);
});

test('wolf king voted out triggers shoot phase and shot advances to next night', async (t) => {
    const game = await createGame({
        playerCount: 3,
        roles: { wolf: 0, wolfKing: 1, witch: 0, seer: 0, hunter: 0, idiot: 0, hybrid: 0 }
    });
    t.after(async () => game.cleanup());

    await goToDayAnnounce(game);
    const wolfKing = game.getAdminPlayerByRole('wolf_king');
    assert.ok(wolfKing);

    game.admin.socket.emit('admin-day-vote', { targetId: wolfKing.id });
    await game.waitAdmin((s) => s.phase === 'shoot_phase' && s.shootPhase && s.shootPhase.shooterId === wolfKing.id);

    const wolfKingClient = game.getClientByPlayerId(wolfKing.id);
    const target = game.admin.state.players.find((p) => p.alive && p.id !== wolfKing.id);
    assert.ok(wolfKingClient && target);

    wolfKingClient.socket.emit('action', { type: 'shoot', targetId: target.id });
    await game.waitAdmin((s) => s.phase === 'wolf' && s.round === 2);
    assert.equal(game.admin.state.players.find((p) => p.id === target.id).alive, false);
});

test('wolf king poisoned at night does not trigger shoot phase', async (t) => {
    const game = await createGame({
        playerCount: 4,
        roles: { wolf: 0, wolfKing: 1, witch: 1, seer: 0, hunter: 0, idiot: 0, hybrid: 0 }
    });
    t.after(async () => game.cleanup());

    const wolfKing = game.getAdminPlayerByRole('wolf_king');
    const witchClient = game.getClientByRole('witch');
    assert.ok(wolfKing && witchClient);

    game.admin.socket.emit('admin-next-phase', 'witch');
    await game.waitAdmin((s) => s.phase === 'witch');
    witchClient.socket.emit('action', { type: 'poison', targetId: wolfKing.id });

    game.admin.socket.emit('admin-next-phase', 'day_announce');
    await game.waitAdmin((s) => s.phase === 'day_announce');
    assert.equal(game.admin.state.players.find((p) => p.id === wolfKing.id).alive, false);
});

test('hunter killed by wolves at night gets shoot phase', async (t) => {
    const game = await createGame({
        playerCount: 3,
        roles: { wolf: 1, wolfKing: 0, witch: 0, seer: 0, hunter: 1, idiot: 0, hybrid: 0 }
    });
    t.after(async () => game.cleanup());

    const hunter = game.getAdminPlayerByRole('hunter');
    const wolfClient = game.getClientByRole('wolf');
    assert.ok(hunter && wolfClient);

    wolfClient.socket.emit('action', { type: 'kill', targetId: hunter.id });
    game.admin.socket.emit('admin-next-phase', 'day_announce');
    await game.waitAdmin((s) => s.phase === 'shoot_phase' && s.shootPhase.shooterId === hunter.id);

    const hunterClient = game.getClientByPlayerId(hunter.id);
    const target = game.admin.state.players.find((p) => p.alive && p.id !== hunter.id);
    assert.ok(hunterClient && target);
    hunterClient.socket.emit('action', { type: 'shoot', targetId: target.id });

    await game.waitAdmin((s) => s.phase === 'day_announce');
    assert.equal(game.admin.state.players.find((p) => p.id === target.id).alive, false);
});

test('hunter poisoned at night cannot shoot', async (t) => {
    const game = await createGame({
        playerCount: 4,
        roles: { wolf: 1, wolfKing: 0, witch: 1, seer: 0, hunter: 1, idiot: 0, hybrid: 0 }
    });
    t.after(async () => game.cleanup());

    const hunter = game.getAdminPlayerByRole('hunter');
    const witchClient = game.getClientByRole('witch');
    assert.ok(hunter && witchClient);

    game.admin.socket.emit('admin-next-phase', 'witch');
    await game.waitAdmin((s) => s.phase === 'witch');
    witchClient.socket.emit('action', { type: 'poison', targetId: hunter.id });

    game.admin.socket.emit('admin-next-phase', 'day_announce');
    await game.waitAdmin((s) => s.phase === 'day_announce');
    assert.equal(game.admin.state.players.find((p) => p.id === hunter.id).alive, false);
});

test('hybrid aligned to wolves keeps wolves alive for win calculation', async (t) => {
    const game = await createGame({
        playerCount: 3,
        roles: { wolf: 1, wolfKing: 0, witch: 0, seer: 0, hunter: 0, idiot: 0, hybrid: 1 }
    });
    t.after(async () => game.cleanup());

    const hybrid = game.getAdminPlayerByRole('hybrid');
    const wolf = game.getAdminPlayerByRole('wolf');
    const villager = game.admin.state.players.find((p) => p.role === 'villager');
    const hybridClient = game.getClientByPlayerId(hybrid.id);
    assert.ok(hybrid && wolf && villager && hybridClient);

    hybridClient.socket.emit('action', { type: 'hybrid_model', targetId: wolf.id });
    await game.waitAdmin((s) => s.players.find((p) => p.id === hybrid.id).modelId === wolf.id);

    await goToDayAnnounce(game);

    game.admin.socket.emit('admin-day-vote', { targetId: wolf.id });
    await game.waitAdmin((s) => s.players.find((p) => p.id === wolf.id).alive === false);
    assert.equal(game.admin.state.phase, 'day_announce');
    assert.equal(game.admin.state.winner, null);

    game.admin.socket.emit('admin-day-vote', { targetId: villager.id });
    await game.waitAdmin((s) => s.phase === 'game_over' && s.winner && s.winner.team === 'wolves');
    assert.ok(game.admin.state.winner.hybridWinnerIds.includes(hybrid.id));
});
