const socket = io();
let me = null;
let isAdmin = false;
let joined = false;
let lastPhase = '';

const STORAGE_TOKEN = 'ww_player_token';
const STORAGE_NAME = 'ww_player_name';
const STORAGE_ADMIN = 'ww_is_admin';

const synth = window.speechSynthesis;

function speak(text) {
    if (!isAdmin) return;
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    utterance.rate = 0.9;
    utterance.pitch = 1;
    synth.speak(utterance);
}

function showScreen(id) {
    document.querySelectorAll('.screen').forEach((el) => el.classList.add('hidden'));
    document.getElementById(id).classList.remove('hidden');
}

function setMaskText(text) {
    const title = document.querySelector('#mask h3');
    if (title) {
        title.innerText = text;
    }
}

function appendAdminLog(message) {
    const log = document.getElementById('admin-log');
    if (!log) return;
    const row = document.createElement('div');
    row.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    log.prepend(row);
}

function roleName(role) {
    const map = {
        wolf: '🐺 狼人',
        wolf_king: '🔫 狼枪',
        witch: '🧪 女巫',
        seer: '🔮 预言家',
        hunter: '🏹 猎人',
        idiot: '🤡 白痴',
        hybrid: '🧬 混血儿',
        villager: '🧑‍🌾 平民',
        spectator: '👀 旁观',
        unassigned: '未分配'
    };
    return map[role] || '未知';
}

function winnerText(winner) {
    if (!winner) return '游戏结束';
    if (winner.team === 'villagers') return `好人阵营胜利（${winner.reason}）`;
    if (winner.team === 'wolves') return `狼队胜利（${winner.reason}）`;
    return `平局（${winner.reason || '无'}）`;
}

function getOrCreatePlayerToken() {
    let token = localStorage.getItem(STORAGE_TOKEN);
    if (!token) {
        token = self.crypto && self.crypto.randomUUID ? self.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        localStorage.setItem(STORAGE_TOKEN, token);
    }
    return token;
}

function emitJoin(name) {
    const token = getOrCreatePlayerToken();
    localStorage.setItem(STORAGE_NAME, name);
    localStorage.setItem(STORAGE_ADMIN, '0');
    socket.emit('join', { name, token });
}

function renderPlayerList(state) {
    const list = document.getElementById('player-list');
    if (!list) return;

    const myId = state.me ? state.me.id : null;
    list.innerHTML = state.players
        .map((p) => {
            const meMark = p.id === myId ? ' (我)' : '';
            const aliveMark = p.alive ? '' : ' [出局]';
            const onlineMark = p.connected ? '' : ' [离线]';
            const voteMark = p.canVote ? '' : ' [无票]';
            const exposedMark = p.isExposed ? ' [翻牌]' : '';
            const roleMark = p.role ? ` - ${roleName(p.role)}` : '';
            return `<div>${p.id}号 ${p.name}${meMark}${aliveMark}${onlineMark}${voteMark}${exposedMark}${roleMark}</div>`;
        })
        .join('');
}

function announcePhase(phase) {
    switch (phase) {
        case 'hybrid':
            speak('第一夜，混血儿请睁眼，选择榜样。');
            break;
        case 'wolf':
            speak('狼人和狼枪请睁眼，选择击杀目标。');
            break;
        case 'witch':
            speak('女巫请睁眼，决定是否用药。');
            break;
        case 'seer':
            speak('预言家请睁眼，进行查验。');
            break;
        case 'day_announce':
            speak('天亮了，所有玩家请睁眼。');
            break;
        case 'shoot_phase':
            speak('请执行开枪阶段，其他玩家等待。');
            break;
        case 'game_over':
            speak('游戏结束。');
            break;
        default:
            break;
    }
}

function renderTargets(actionType, players, myId) {
    const grid = document.getElementById('targets');
    const extra = document.getElementById('extra-actions');
    const prompt = document.getElementById('action-prompt');

    grid.innerHTML = '';
    extra.innerHTML = '';

    if (actionType === 'wolf') {
        prompt.innerText = '请选择今晚击杀目标';
    } else if (actionType === 'seer') {
        prompt.innerText = '请选择要查验的玩家';
    } else if (actionType === 'hybrid_model') {
        prompt.innerText = '第一夜：请选择你的榜样';
    }

    players.forEach((p) => {
        if (!p.alive || !p.connected || p.id === myId) return;

        const btn = document.createElement('button');
        btn.className = 'target-btn';
        btn.innerText = `${p.id}号 ${p.name}`;
        btn.onclick = () => {
            if (actionType === 'wolf') {
                socket.emit('action', { type: 'kill', targetId: p.id });
                alert('已提交击杀目标');
            } else if (actionType === 'seer') {
                socket.emit('action', { type: 'check', targetId: p.id });
                alert('已提交查验目标');
            } else if (actionType === 'hybrid_model') {
                socket.emit('action', { type: 'hybrid_model', targetId: p.id });
                alert('已选择榜样');
            }
            btn.style.background = '#c0392b';
        };
        grid.appendChild(btn);
    });
}

function renderShootTargets(state, myId, shooterRole) {
    const grid = document.getElementById('targets');
    const extra = document.getElementById('extra-actions');
    const prompt = document.getElementById('action-prompt');

    grid.innerHTML = '';
    extra.innerHTML = '';
    prompt.innerText = shooterRole === 'hunter' ? '你是猎人，选择开枪目标' : '你是狼枪，选择开枪目标';

    state.players.forEach((p) => {
        if (!p.alive || !p.connected || p.id === myId) return;

        const btn = document.createElement('button');
        btn.className = 'target-btn';
        btn.innerText = `${p.id}号 ${p.name}`;
        btn.onclick = () => {
            socket.emit('action', { type: 'shoot', targetId: p.id });
            btn.style.background = '#c0392b';
            alert('已提交开枪目标');
        };
        grid.appendChild(btn);
    });
}

function renderWitchActions(state, myId) {
    const grid = document.getElementById('targets');
    const extra = document.getElementById('extra-actions');
    const actionPrompt = document.getElementById('action-prompt');

    grid.innerHTML = '';
    extra.innerHTML = '';

    const witchPrompt = state.witchPrompt || {};
    if (witchPrompt.wolfTargetName) {
        actionPrompt.innerText = `今晚被刀的是：${witchPrompt.wolfTargetName}`;
    } else {
        actionPrompt.innerText = '今晚暂无狼人击杀结果（或尚未提交）';
    }

    const saveBtn = document.createElement('button');
    saveBtn.innerText = witchPrompt.canSave ? '使用解药' : '解药已使用';
    saveBtn.disabled = !witchPrompt.canSave;
    saveBtn.onclick = () => {
        socket.emit('action', { type: 'save' });
        alert('已提交解药操作');
    };
    extra.appendChild(saveBtn);

    const poisonBtn = document.createElement('button');
    poisonBtn.innerText = witchPrompt.canPoison ? '使用毒药' : '毒药已使用';
    poisonBtn.disabled = !witchPrompt.canPoison;
    poisonBtn.onclick = () => {
        const target = prompt('输入要毒杀的玩家编号');
        const targetId = Number(target);
        if (!Number.isInteger(targetId)) {
            alert('编号无效');
            return;
        }
        if (targetId === myId) {
            alert('不能毒自己');
            return;
        }
        socket.emit('action', { type: 'poison', targetId });
    };
    extra.appendChild(poisonBtn);
}

function showGameOver(state) {
    const mask = document.getElementById('mask');
    const actionLayer = document.getElementById('action-layer');
    const dayLayer = document.getElementById('day-layer');

    mask.classList.add('hidden');
    actionLayer.classList.add('hidden');
    dayLayer.classList.remove('hidden');
    document.getElementById('day-result').innerText = winnerText(state.winner);
}

function handleGamePhase(phase, state) {
    const mask = document.getElementById('mask');
    const actionLayer = document.getElementById('action-layer');
    const dayLayer = document.getElementById('day-layer');

    mask.classList.remove('hidden');
    actionLayer.classList.add('hidden');
    dayLayer.classList.add('hidden');

    if (!me) return;

    if (phase === 'game_over') {
        showGameOver(state);
        return;
    }

    if (phase === 'shoot_phase') {
        const shooter = state.shootPhase || {};
        if (me.id === shooter.shooterId && !me.alive) {
            mask.classList.add('hidden');
            actionLayer.classList.remove('hidden');
            renderShootTargets(state, me.id, shooter.shooterRole);
        } else {
            setMaskText(shooter.shooterRole === 'hunter' ? '猎人正在开枪...' : '狼枪正在开枪...');
        }
        return;
    }

    if (phase === 'hybrid') {
        if (me.role === 'hybrid' && me.alive && !me.modelId) {
            mask.classList.add('hidden');
            actionLayer.classList.remove('hidden');
            renderTargets('hybrid_model', state.players, me.id);
        } else {
            setMaskText('混血儿正在选择榜样...');
        }
        return;
    }

    if (!me.alive && phase !== 'day_announce') {
        setMaskText('你已出局');
        return;
    }

    if (phase === 'day_announce') {
        mask.classList.add('hidden');
        dayLayer.classList.remove('hidden');

        const deadIds = (state.nightResult && state.nightResult.deadIds) || [];
        const deadNames = deadIds
            .map((id) => state.players.find((p) => p.id === id))
            .filter(Boolean)
            .map((p) => p.name)
            .join('、');

        const notice = state.publicNotice ? `\n${state.publicNotice}` : '';
        document.getElementById('day-result').innerText = (deadNames
            ? `昨晚死亡的是: ${deadNames}`
            : '昨晚是平安夜') + notice;
        return;
    }

    if (phase === 'wolf' && (me.role === 'wolf' || me.role === 'wolf_king')) {
        mask.classList.add('hidden');
        actionLayer.classList.remove('hidden');
        renderTargets('wolf', state.players, me.id);
        return;
    }

    if (phase === 'witch' && me.role === 'witch') {
        mask.classList.add('hidden');
        actionLayer.classList.remove('hidden');
        renderWitchActions(state, me.id);
        return;
    }

    if (phase === 'seer' && me.role === 'seer') {
        mask.classList.add('hidden');
        actionLayer.classList.remove('hidden');
        renderTargets('seer', state.players, me.id);
        return;
    }

    if (me.role === 'idiot' && me.isExposed) {
        setMaskText('你已翻牌（白痴），不能投票但可继续发言');
    } else if (me.role === 'spectator') {
        setMaskText('你是旁观身份');
    } else {
        setMaskText('请等待当前回合结束');
    }
}

function joinGame() {
    const name = document.getElementById('username').value.trim();
    if (!name) {
        alert('请输入名字');
        return;
    }

    isAdmin = false;
    joined = true;
    emitJoin(name);
    showScreen('lobby');
}

function initAdmin() {
    isAdmin = true;
    joined = true;
    localStorage.setItem(STORAGE_ADMIN, '1');
    socket.emit('admin-claim');
    showScreen('admin');
}

function askCount(label, defaultValue) {
    const v = Number(prompt(label, String(defaultValue)));
    if (!Number.isInteger(v) || v < 0) return defaultValue;
    return v;
}

function startGame() {
    const wolf = askCount('普通狼人数量（不含狼枪）', 1);
    const wolfKing = askCount('狼枪数量', 1);
    const witch = askCount('女巫数量', 1);
    const seer = askCount('预言家数量', 1);
    const hunter = askCount('猎人数量', 1);
    const idiot = askCount('白痴数量', 1);
    const hybrid = askCount('混血儿数量', 1);

    socket.emit('admin-start', {
        wolf,
        wolfKing,
        witch,
        seer,
        hunter,
        idiot,
        hybrid
    });
}

function nextPhase(phase) {
    socket.emit('admin-next-phase', phase);
}

function dayVoteOut() {
    const target = Number(prompt('输入白天票出玩家编号'));
    if (!Number.isInteger(target)) {
        alert('编号无效');
        return;
    }
    socket.emit('admin-day-vote', { targetId: target });
}

socket.on('connect', () => {
    const adminFlag = localStorage.getItem(STORAGE_ADMIN) === '1';

    if (adminFlag) {
        isAdmin = true;
        joined = true;
        socket.emit('admin-claim');
        showScreen('admin');
        return;
    }

    const savedName = localStorage.getItem(STORAGE_NAME);
    const savedToken = localStorage.getItem(STORAGE_TOKEN);
    if (savedName && savedToken) {
        isAdmin = false;
        joined = true;
        socket.emit('join', { name: savedName, token: savedToken });
        showScreen('lobby');
    }
});

socket.on('join-ack', (payload) => {
    if (payload && payload.token) {
        localStorage.setItem(STORAGE_TOKEN, payload.token);
    }
    if (payload && payload.name) {
        localStorage.setItem(STORAGE_NAME, payload.name);
    }
});

socket.on('update', (state) => {
    me = state.me;
    renderPlayerList(state);

    if (!joined) return;

    if (state.phase === 'waiting') {
        showScreen(isAdmin ? 'admin' : 'lobby');
        return;
    }

    if (isAdmin) {
        showScreen('admin');
        if (lastPhase !== state.phase) {
            announcePhase(state.phase);
            lastPhase = state.phase;
        }
        return;
    }

    showScreen('game');
    const exposedText = me && me.role === 'idiot' && me.isExposed ? '（已翻牌）' : '';
    document.getElementById('my-role-display').innerText = me
        ? `我的身份: ${roleName(me.role)} ${exposedText}`.trim()
        : '我的身份: 未知';

    if (state.publicNotice && state.phase !== 'day_announce') {
        setMaskText(state.publicNotice);
    }

    handleGamePhase(state.phase, state);
});

socket.on('admin-log', (message) => {
    if (isAdmin) {
        appendAdminLog(message);
    }
});

socket.on('seer-result', (res) => {
    alert(`查验结果：${res.name} 是 ${res.isGood ? '好人' : '狼人'}`);
});
