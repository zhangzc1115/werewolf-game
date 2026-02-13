const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

app.use(express.static(path.join(__dirname, 'public')));

const DATA_DIR = process.env.WW_DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = process.env.WW_STATE_FILE || path.join(DATA_DIR, 'game-state.json');
const DISABLE_PERSIST = process.env.WW_DISABLE_PERSIST === '1';

const PHASES = {
    WAITING: 'waiting',
    HYBRID: 'hybrid',
    WOLF: 'wolf',
    WITCH: 'witch',
    SEER: 'seer',
    DAY_ANNOUNCE: 'day_announce',
    SHOOT: 'shoot_phase',
    GAME_OVER: 'game_over'
};

let nextPlayerId = 1;
let adminSocketId = null;

function createInitialState() {
    return {
        phase: PHASES.WAITING,
        round: 0,
        players: [],
        actions: {
            hybridModels: {}, // { [hybridPlayerId]: modelPlayerId }
            wolfVotes: {},
            witch: { save: false, poisonTargetId: null },
            seerChecks: {}
        },
        nightResult: {
            deadIds: [],
            wolfTargetId: null,
            saved: false,
            poisonTargetId: null,
            causes: {} // { [playerId]: ['wolf', 'poison', 'shot', ...] }
        },
        dayVote: {
            votedOutId: null,
            shotTargetId: null
        },
        shootPhase: {
            shooterId: null,
            shooterRole: null,
            trigger: null, // 'night_death' | 'day_vote'
            nextAfterShot: null // 'day_announce' | 'next_night'
        },
        publicNotice: '',
        winner: null
    };
}

let gameState = createInitialState();

function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
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
    return role === 'wolf' || role === 'wolf_king';
}

function isGoodBaseRole(role) {
    return ['villager', 'witch', 'seer', 'hunter', 'idiot'].includes(role);
}

function isGodRole(role) {
    return ['witch', 'seer', 'hunter', 'idiot'].includes(role);
}

function isGamePhaseRunning() {
    return [
        PHASES.HYBRID,
        PHASES.WOLF,
        PHASES.WITCH,
        PHASES.SEER,
        PHASES.DAY_ANNOUNCE,
        PHASES.SHOOT
    ].includes(gameState.phase);
}

function resetNightData() {
    gameState.actions = {
        hybridModels: {},
        wolfVotes: {},
        witch: { save: false, poisonTargetId: null },
        seerChecks: {}
    };
    gameState.nightResult = {
        deadIds: [],
        wolfTargetId: null,
        saved: false,
        poisonTargetId: null,
        causes: {}
    };
}

function resetDayData() {
    gameState.dayVote = {
        votedOutId: null,
        shotTargetId: null
    };
    gameState.shootPhase = {
        shooterId: null,
        shooterRole: null,
        trigger: null,
        nextAfterShot: null
    };
}

function clearPublicNotice() {
    gameState.publicNotice = '';
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

function saveStateToDisk() {
    if (DISABLE_PERSIST) return;
    try {
        ensureDataDir();
        const serializablePlayers = gameState.players.map((p) => ({
            id: p.id,
            name: p.name,
            role: p.role,
            alive: Boolean(p.alive),
            token: p.token || generateToken(),
            connected: Boolean(p.connected),
            canVote: Boolean(p.canVote),
            isExposed: Boolean(p.isExposed),
            modelId: p.modelId ? Number(p.modelId) : null,
            socketId: null
        }));

        const payload = {
            nextPlayerId,
            gameState: {
                ...gameState,
                players: serializablePlayers
            }
        };

        fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2), 'utf8');
    } catch (err) {
        console.error('持久化状态失败:', err.message);
    }
}

function loadStateFromDisk() {
    if (DISABLE_PERSIST) return;
    try {
        if (!fs.existsSync(STATE_FILE)) return;

        const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        const loaded = raw.gameState || {};
        const loadedPlayers = Array.isArray(loaded.players) ? loaded.players : [];

        gameState = {
            ...createInitialState(),
            ...loaded,
            players: loadedPlayers.map((p) => ({
                id: Number(p.id),
                name: String(p.name || `玩家${p.id || ''}`).trim() || `玩家${p.id || ''}`,
                role: String(p.role || 'unassigned'),
                alive: Boolean(p.alive),
                token: String(p.token || generateToken()),
                connected: false,
                socketId: null,
                canVote: p.canVote === undefined ? true : Boolean(p.canVote),
                isExposed: Boolean(p.isExposed),
                modelId: p.modelId ? Number(p.modelId) : null
            }))
        };

        if (!Object.values(PHASES).includes(gameState.phase)) {
            gameState.phase = PHASES.WAITING;
        }

        if (!gameState.winner || !gameState.winner.team) {
            gameState.winner = null;
        }

        nextPlayerId = Number(raw.nextPlayerId) || 1;
        if (gameState.players.length) {
            const maxPlayerId = Math.max(...gameState.players.map((p) => p.id));
            nextPlayerId = Math.max(nextPlayerId, maxPlayerId + 1);
        }

        adminSocketId = null;
    } catch (err) {
        console.error('读取持久化状态失败，使用初始状态:', err.message);
        gameState = createInitialState();
        nextPlayerId = 1;
        adminSocketId = null;
    }
}

function buildRoleDeck(config, playerCount) {
    const safeConfig = {
        wolf: Math.max(0, Number(config?.wolf) || 0),
        wolfKing: Math.max(0, Number(config?.wolfKing) || 0),
        witch: Number(config?.witch) > 0 ? Math.max(0, Number(config.witch)) : (Boolean(config?.witch) ? 1 : 0),
        seer: Number(config?.seer) > 0 ? Math.max(0, Number(config.seer)) : (Boolean(config?.seer) ? 1 : 0),
        hunter: Number(config?.hunter) > 0 ? Math.max(0, Number(config.hunter)) : (Boolean(config?.hunter) ? 1 : 0),
        idiot: Number(config?.idiot) > 0 ? Math.max(0, Number(config.idiot)) : (Boolean(config?.idiot) ? 1 : 0),
        hybrid: Math.max(0, Number(config?.hybrid) || 0)
    };

    if (safeConfig.wolf + safeConfig.wolfKing === 0) {
        safeConfig.wolf = 1;
    }

    const roles = [];

    for (let i = 0; i < safeConfig.wolf; i++) roles.push('wolf');
    for (let i = 0; i < safeConfig.wolfKing; i++) roles.push('wolf_king');
    for (let i = 0; i < safeConfig.witch; i++) roles.push('witch');
    for (let i = 0; i < safeConfig.seer; i++) roles.push('seer');
    for (let i = 0; i < safeConfig.hunter; i++) roles.push('hunter');
    for (let i = 0; i < safeConfig.idiot; i++) roles.push('idiot');
    for (let i = 0; i < safeConfig.hybrid; i++) roles.push('hybrid');

    while (roles.length > playerCount) {
        const villagerUnsafePriority = ['wolf', 'wolf_king', 'witch', 'seer', 'hunter', 'idiot', 'hybrid'];
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
        roles.push('villager');
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

function resolveNight() {
    const wolfTargetId = tallyWolfTarget();
    const witchSave = gameState.actions.witch.save;
    const witchPoisonTargetId = gameState.actions.witch.poisonTargetId;

    const deadSet = new Set();
    const causes = {};
    const validWolfTarget = wolfTargetId ? getPlayerById(wolfTargetId) : null;

    if (validWolfTarget && validWolfTarget.alive && !witchSave) {
        deadSet.add(validWolfTarget.id);
        addDeathCause(causes, validWolfTarget.id, 'wolf');
    }

    const validPoisonTarget = witchPoisonTargetId ? getPlayerById(witchPoisonTargetId) : null;
    if (validPoisonTarget && validPoisonTarget.alive) {
        deadSet.add(validPoisonTarget.id);
        addDeathCause(causes, validPoisonTarget.id, 'poison');
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
        causes
    };

    resetDayData();
}

function createWitchPrompt() {
    const wolfTargetId = tallyWolfTarget();
    const wolfTarget = wolfTargetId ? getPlayerById(wolfTargetId) : null;
    return {
        wolfTargetId: wolfTarget ? wolfTarget.id : null,
        wolfTargetName: wolfTarget ? wolfTarget.name : null,
        canSave: !gameState.actions.witch.save,
        canPoison: gameState.actions.witch.poisonTargetId === null
    };
}

function getHybridTeamByModelId(modelId, visited = new Set()) {
    const model = getPlayerById(modelId);
    if (!model) return 'good';

    if (isWolfTeamRole(model.role)) return 'wolves';
    if (isGoodBaseRole(model.role)) return 'villagers';

    if (model.role === 'hybrid') {
        if (visited.has(model.id)) return 'villagers';
        visited.add(model.id);
        return getHybridTeamByModelId(model.modelId, visited);
    }

    return 'villagers';
}

function getHybridTeam(player) {
    if (!player || player.role !== 'hybrid') return null;
    return getHybridTeamByModelId(player.modelId);
}

function computeLivingTeamCounts() {
    let wolves = 0;
    let villagers = 0;

    for (const p of gameState.players) {
        if (!p.alive) continue;
        if (['unassigned', 'spectator'].includes(p.role)) continue;

        if (isWolfTeamRole(p.role)) {
            wolves += 1;
            continue;
        }

        if (isGoodBaseRole(p.role)) {
            villagers += 1;
            continue;
        }

        if (p.role === 'hybrid') {
            const team = getHybridTeam(p);
            if (team === 'wolves') {
                wolves += 1;
            } else {
                villagers += 1;
            }
        }
    }

    return { wolves, villagers };
}

function evaluateVictory() {
    const counts = computeLivingTeamCounts();

    if (counts.wolves === 0 && counts.villagers === 0) {
        return { team: 'draw', reason: '无存活玩家', counts };
    }

    if (counts.wolves === 0) {
        return { team: 'villagers', reason: '狼队全部出局', counts };
    }

    if (counts.villagers === 0) {
        return { team: 'wolves', reason: '好人全部出局', counts };
    }

    return null;
}

function applyVictoryIfNeeded() {
    const winner = evaluateVictory();
    if (!winner) return false;

    const hybridWinners = gameState.players
        .filter((p) => p.role === 'hybrid')
        .map((p) => ({ playerId: p.id, team: getHybridTeam(p) }))
        .filter((x) => x.team === winner.team)
        .map((x) => x.playerId);

    gameState.winner = {
        ...winner,
        hybridWinnerIds: hybridWinners
    };
    gameState.phase = PHASES.GAME_OVER;

    emitAdminLog(
        winner.team === 'villagers'
            ? '游戏结束：好人阵营胜利'
            : winner.team === 'wolves'
                ? '游戏结束：狼队胜利'
                : '游戏结束：平局'
    );
    setPublicNotice(
        winner.team === 'villagers'
            ? '🎉 好人阵营胜利'
            : winner.team === 'wolves'
                ? '🐺 狼队胜利'
                : '⚖️ 平局'
    );
    return true;
}

function hasUnselectedHybrid() {
    return gameState.players.some((p) => p.alive && p.role === 'hybrid' && !p.modelId);
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
        emitAdminLog(`第 ${gameState.round} 夜开始，混血儿先选择榜样`);
        return;
    }

    gameState.phase = PHASES.WOLF;
    emitAdminLog(`第 ${gameState.round} 夜开始，狼人行动`);
}

function beginShootPhase(shooter, trigger, nextAfterShot) {
    gameState.phase = PHASES.SHOOT;
    gameState.shootPhase = {
        shooterId: shooter.id,
        shooterRole: shooter.role,
        trigger,
        nextAfterShot
    };

    const roleName = shooter.role === 'hunter' ? '猎人' : '狼枪';
    emitAdminLog(`${roleName} ${shooter.name} 进入开枪阶段`);
    setPublicNotice(`🔫 ${roleName} 正在选择开枪目标`);
}

function maybeStartNightDeathShoot() {
    const deadIds = gameState.nightResult.deadIds || [];
    const causes = gameState.nightResult.causes || {};

    for (const id of deadIds) {
        const p = getPlayerById(id);
        if (!p || p.role !== 'hunter') continue;

        const c = causes[String(id)] || [];
        const killedByWolf = c.includes('wolf');
        const poisoned = c.includes('poison');

        if (killedByWolf && !poisoned) {
            beginShootPhase(p, 'night_death', 'day_announce');
            return true;
        }
    }

    return false;
}

function processDayVoteOut(votedOut) {
    if (votedOut.role === 'idiot' && !votedOut.isExposed) {
        votedOut.isExposed = true;
        votedOut.canVote = false;
        setPublicNotice(`🤡 ${votedOut.name} 是白痴，翻牌免死，失去投票权`);
        emitAdminLog(`白天投票：${votedOut.name} 为白痴，翻牌免死且失去投票权`);

        if (!applyVictoryIfNeeded()) {
            startNightRound(true);
        }
        return;
    }

    votedOut.alive = false;
    gameState.dayVote.votedOutId = votedOut.id;
    emitAdminLog(`白天投票出局：${votedOut.name}`);

    if (votedOut.role === 'wolf_king' || votedOut.role === 'hunter') {
        beginShootPhase(votedOut, 'day_vote', 'next_night');
        return;
    }

    if (!applyVictoryIfNeeded()) {
        startNightRound(true);
    }
}

function maybeVisibleRoleForViewer(player, viewer, viewerIsAdmin) {
    if (viewerIsAdmin) return player.role;
    if (viewer && viewer.id === player.id) return player.role;
    if (player.isExposed && player.role === 'idiot') return player.role;
    return null;
}

function maybeVisibleModelIdForViewer(player, viewer, viewerIsAdmin) {
    if (player.role !== 'hybrid') return null;
    if (viewerIsAdmin) return player.modelId || null;
    if (viewer && viewer.id === player.id) return player.modelId || null;
    return null;
}

function toPublicState(socketId) {
    const viewer = getPlayerBySocketId(socketId);
    const viewerIsAdmin = socketId === adminSocketId;

    const players = gameState.players.map((p) => ({
        id: p.id,
        name: p.name,
        alive: p.alive,
        connected: p.connected,
        canVote: p.canVote,
        isExposed: p.isExposed,
        role: maybeVisibleRoleForViewer(p, viewer, viewerIsAdmin),
        modelId: maybeVisibleModelIdForViewer(p, viewer, viewerIsAdmin)
    }));

    return {
        phase: gameState.phase,
        round: gameState.round,
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
                modelId: viewer.modelId || null
            }
            : null,
        players,
        nightResult: {
            deadIds: [...gameState.nightResult.deadIds]
        },
        dayVote: {
            votedOutId: gameState.dayVote.votedOutId,
            shotTargetId: gameState.dayVote.shotTargetId
        },
        witchPrompt: gameState.phase === PHASES.WITCH ? createWitchPrompt() : null,
        shootPhase: gameState.phase === PHASES.SHOOT
            ? {
                shooterId: gameState.shootPhase.shooterId,
                shooterRole: gameState.shootPhase.shooterRole,
                trigger: gameState.shootPhase.trigger
            }
            : null,
        publicNotice: gameState.publicNotice,
        winner: gameState.winner
    };
}

function emitState() {
    io.sockets.sockets.forEach((socket) => {
        socket.emit('update', toPublicState(socket.id));
    });
    saveStateToDisk();
}

function emitAdminLog(message) {
    io.emit('admin-log', message);
}

loadStateFromDisk();

io.on('connection', (socket) => {
    console.log('新玩家连接:', socket.id);

    socket.emit('update', toPublicState(socket.id));

    socket.on('join', (payload) => {
        const incomingName = typeof payload === 'string' ? payload : payload?.name;
        const incomingToken = typeof payload === 'object' && payload ? payload.token : null;

        const name = String(incomingName || '').trim();
        const token = String(incomingToken || '').trim();

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
                emitAdminLog(`${existingByToken.name} 已重连`);
                emitState();
                return;
            }
        }

        const playerToken = token || generateToken();
        const displayName = name || `玩家${nextPlayerId}`;

        gameState.players.push({
            id: nextPlayerId++,
            name: displayName,
            role: 'unassigned',
            alive: true,
            token: playerToken,
            connected: true,
            socketId: socket.id,
            canVote: true,
            isExposed: false,
            modelId: null
        });

        emitAdminLog(`${displayName} 加入了房间`);
        socket.emit('join-ack', { token: playerToken, id: nextPlayerId - 1, name: displayName });
        emitState();
    });

    socket.on('admin-claim', () => {
        if (adminSocketId && adminSocketId !== socket.id) {
            socket.emit('admin-log', '已有上帝设备在线，无法重复接管。');
            return;
        }
        adminSocketId = socket.id;
        emitAdminLog('上帝设备已接管控制台');
        emitState();
    });

    socket.on('admin-start', (rolesConfig) => {
        if (!isAdminSocket(socket)) return;

        const participants = gameState.players.filter((p) => p.connected);
        if (participants.length < 4) {
            socket.emit('admin-log', '至少需要 4 名在线玩家才能开始');
            return;
        }

        gameState.players.forEach((p) => {
            p.role = 'spectator';
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
        gameState.winner = null;
        clearPublicNotice();
        startNightRound(false);
        emitState();
    });

    socket.on('admin-next-phase', (nextPhase) => {
        if (!isAdminSocket(socket)) return;
        if (gameState.phase === PHASES.GAME_OVER) return;

        const allowed = new Set([PHASES.HYBRID, PHASES.WOLF, PHASES.WITCH, PHASES.SEER, PHASES.DAY_ANNOUNCE]);
        if (!allowed.has(nextPhase)) return;

        if (gameState.round === 1 && hasUnselectedHybrid() && nextPhase !== PHASES.HYBRID && gameState.phase !== PHASES.HYBRID) {
            socket.emit('admin-log', '第1夜必须先进行混血儿认榜样阶段');
            return;
        }

        if (nextPhase === PHASES.HYBRID) {
            if (gameState.round !== 1) {
                socket.emit('admin-log', '混血儿认榜样仅在第1夜');
                return;
            }
            gameState.phase = PHASES.HYBRID;
            emitAdminLog('进入混血儿认榜样阶段');
            emitState();
            return;
        }

        if (nextPhase === PHASES.WOLF) {
            if (gameState.phase === PHASES.DAY_ANNOUNCE) {
                startNightRound(true);
            } else {
                gameState.phase = PHASES.WOLF;
                emitAdminLog('进入狼人阶段');
            }
            emitState();
            return;
        }

        if (nextPhase === PHASES.DAY_ANNOUNCE) {
            resolveNight();

            if (maybeStartNightDeathShoot()) {
                emitState();
                return;
            }

            if (!applyVictoryIfNeeded()) {
                gameState.phase = PHASES.DAY_ANNOUNCE;
                const deadNames = gameState.nightResult.deadIds
                    .map((id) => getPlayerById(id))
                    .filter(Boolean)
                    .map((p) => p.name);
                emitAdminLog(deadNames.length ? `天亮：死亡玩家 ${deadNames.join('、')}` : '天亮：平安夜');
            }

            emitState();
            return;
        }

        gameState.phase = nextPhase;
        if (nextPhase === PHASES.WITCH) {
            emitAdminLog('进入女巫回合');
        } else if (nextPhase === PHASES.SEER) {
            emitAdminLog('进入预言家回合');
        }
        emitState();
    });

    socket.on('admin-day-vote', (payload) => {
        if (!isAdminSocket(socket)) return;
        if (gameState.phase !== PHASES.DAY_ANNOUNCE) return;

        const targetId = Number(payload?.targetId);
        const votedOut = getPlayerById(targetId);
        if (!votedOut || !votedOut.alive) return;

        processDayVoteOut(votedOut);
        emitState();
    });

    socket.on('action', (data) => {
        const player = getPlayerBySocketId(socket.id);
        if (!player || !player.connected) return;
        if (!isGamePhaseRunning()) return;

        const type = String(data?.type || '');
        const targetId = Number(data?.targetId);

        const isShootAction =
            gameState.phase === PHASES.SHOOT &&
            type === 'shoot' &&
            gameState.shootPhase.shooterId === player.id;

        if (!player.alive && !isShootAction) return;

        if (gameState.phase === PHASES.HYBRID && player.role === 'hybrid' && type === 'hybrid_model') {
            if (gameState.round !== 1) return;
            if (player.modelId) return;

            const target = getPlayerById(targetId);
            if (!target || !target.alive || target.id === player.id) return;

            player.modelId = target.id;
            gameState.actions.hybridModels[player.id] = target.id;
            emitAdminLog(`混血儿已选择榜样：${target.name}`);
            emitState();
            return;
        }

        if (gameState.phase === PHASES.WOLF && isWolfTeamRole(player.role) && type === 'kill') {
            const target = getPlayerById(targetId);
            if (!target || !target.alive || target.id === player.id) return;

            gameState.actions.wolfVotes[player.id] = target.id;
            emitAdminLog(`${player.name} 已提交狼人击杀目标`);
            emitState();
            return;
        }

        if (gameState.phase === PHASES.WITCH && player.role === 'witch') {
            if (type === 'save') {
                const wolfTargetId = tallyWolfTarget();
                const wolfTarget = wolfTargetId ? getPlayerById(wolfTargetId) : null;
                if (!wolfTarget || !wolfTarget.alive || gameState.actions.witch.save) return;
                gameState.actions.witch.save = true;
                emitAdminLog('女巫已使用解药');
                emitState();
                return;
            }

            if (type === 'poison') {
                const target = getPlayerById(targetId);
                if (!target || !target.alive || target.id === player.id) return;
                if (gameState.actions.witch.poisonTargetId !== null) return;

                gameState.actions.witch.poisonTargetId = target.id;
                emitAdminLog(`女巫已使用毒药，目标 ${target.name}`);
                emitState();
                return;
            }
        }

        if (gameState.phase === PHASES.SEER && player.role === 'seer' && type === 'check') {
            const target = getPlayerById(targetId);
            if (!target || !target.alive || target.id === player.id) return;
            if (gameState.actions.seerChecks[player.id]) return;

            gameState.actions.seerChecks[player.id] = target.id;
            socket.emit('seer-result', {
                name: target.name,
                isGood: target.role === 'hybrid' ? true : !isWolfTeamRole(target.role)
            });
            emitAdminLog(`预言家已查验 ${target.name}`);
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
            addDeathCause(gameState.nightResult.causes, target.id, 'shot');

            const shooterRoleLabel = player.role === 'hunter' ? '猎人' : '狼枪';
            emitAdminLog(`${shooterRoleLabel} 开枪带走了 ${target.name}`);
            setPublicNotice(`🔫 ${shooterRoleLabel} 带走了 ${target.name}`);

            if (!applyVictoryIfNeeded()) {
                if (gameState.shootPhase.nextAfterShot === 'day_announce') {
                    gameState.phase = PHASES.DAY_ANNOUNCE;
                    const deadNames = gameState.nightResult.deadIds
                        .map((id) => getPlayerById(id))
                        .filter(Boolean)
                        .map((p) => p.name);
                    emitAdminLog(deadNames.length ? `天亮：死亡玩家 ${deadNames.join('、')}` : '天亮：平安夜');
                } else {
                    startNightRound(true);
                }
            }

            emitState();
        }
    });

    socket.on('disconnect', () => {
        const leavingPlayer = getPlayerBySocketId(socket.id);

        if (adminSocketId === socket.id) {
            adminSocketId = null;
            emitAdminLog('上帝设备已离线，请重新接管控制台');
        }

        if (leavingPlayer) {
            leavingPlayer.socketId = null;
            leavingPlayer.connected = false;
            emitAdminLog(`${leavingPlayer.name} 掉线`);
        }

        emitState();
    });
});

const PORT = Number(process.env.PORT) || 3000;
http.listen(PORT, () => {
    console.log('\n>>> 游戏服务器已启动! <<<');
    console.log(`请让大家连接 Wi-Fi，并在手机浏览器输入: http://${getLocalIP()}:${PORT}\n`);
});
