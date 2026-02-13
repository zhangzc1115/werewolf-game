const socket = io();
let me = null;
let isAdmin = false;

// 语音合成配置
const synth = window.speechSynthesis;
function speak(text) {
    if (!isAdmin) return; // 只有上帝设备播放声音
    // 取消之前的播放，防止重叠
    synth.cancel(); 
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN'; 
    utterance.rate = 0.9; // 语速稍慢
    utterance.pitch = 1;
    synth.speak(utterance);
}

// 界面切换
function showScreen(id) {
    document.querySelectorAll('.screen').forEach(el => el.classList.add('hidden'));
    document.getElementById(id).classList.remove('hidden');
}

function joinGame() {
    const name = document.getElementById('username').value;
    if(!name) return alert("请输入名字");
    socket.emit('join', name);
    showScreen('lobby');
}

function initAdmin() {
    isAdmin = true;
    socket.emit('join', '上帝');
    showScreen('admin');
}

// 核心状态监听
socket.on('update', (state) => {
    // 更新大厅列表
    const list = document.getElementById('player-list');
    list.innerHTML = state.players.map(p => `<div>${p.name} ${p.socketId === socket.id ? '(我)' : ''}</div>`).join('');
    
    if(state.phase === 'waiting') return;

    // 进入游戏
    if(!isAdmin) {
        showScreen('game');
        me = state.players.find(p => p.socketId === socket.id);
        document.getElementById('my-role-display').innerText = `我的身份: ${roleName(me.role)}`;
        handleGamePhase(state.phase, me, state);
    } else {
        // 上帝端逻辑：只更新日志或状态
        // 自动语音播报逻辑
        if(lastPhase !== state.phase) {
            announcePhase(state.phase);
            lastPhase = state.phase;
        }
    }
});

let lastPhase = '';

// 只有上帝端会执行这个
function announcePhase(phase) {
    switch(phase) {
        case 'night_close': speak("天黑请闭眼，所有玩家请闭眼。"); break;
        case 'wolf': speak("狼人请睁眼，狼人请确认同伴并选择击杀目标。"); break;
        case 'witch': speak("狼人请闭眼。女巫请睁眼。"); break;
        case 'seer': speak("女巫请闭眼。预言家请睁眼，请查验身份。"); break;
        case 'day_announce': speak("预言家请闭眼。天亮了，所有玩家请睁眼。"); break;
    }
}

// 玩家端逻辑：处理“睁眼/闭眼”
function handleGamePhase(phase, me, state) {
    const mask = document.getElementById('mask');
    const actionLayer = document.getElementById('action-layer');
    const dayLayer = document.getElementById('day-layer');
    
    // 默认全遮住
    mask.classList.remove('hidden');
    actionLayer.classList.add('hidden');
    dayLayer.classList.add('hidden');

    // 死亡判断
    if (!me.alive && phase !== 'day_announce') {
        document.getElementById('action-prompt').innerText = "你已出局";
        return; 
    }

    if (phase === 'day_announce') {
        mask.classList.add('hidden');
        dayLayer.classList.remove('hidden');
        const deadNames = state.nightResult.map(id => {
            const p = state.players.find(pl => pl.id == id);
            return p ? p.name : '';
        }).join(', ');
        
        document.getElementById('day-result').innerText = deadNames ? `昨晚死亡的是: ${deadNames}` : "昨晚是平安夜";
        return;
    }

    // 狼人回合
    if (phase === 'wolf' && me.role === 'wolf') {
        mask.classList.add('hidden'); // 移除遮罩
        actionLayer.classList.remove('hidden');
        renderTargets('wolf', state.players);
    }
    
    // 女巫回合
    if (phase === 'witch' && me.role === 'witch') {
        mask.classList.add('hidden');
        actionLayer.classList.remove('hidden');
        // 这里为了简化，女巫界面显示两个按钮：救人/毒人
        // 实际逻辑里应该显示昨晚谁被杀了
        renderWitchActions(state);
    }

    // 预言家回合
    if (phase === 'seer' && me.role === 'seer') {
        mask.classList.add('hidden');
        actionLayer.classList.remove('hidden');
        renderTargets('seer', state.players);
    }
}

function renderTargets(actionType, players) {
    const grid = document.getElementById('targets');
    grid.innerHTML = '';
    document.getElementById('extra-actions').innerHTML = '';

    players.forEach(p => {
        if (!p.alive) return;
        const btn = document.createElement('button');
        btn.className = 'target-btn';
        btn.innerText = p.id + "号 " + p.name;
        btn.onclick = () => {
            socket.emit('action', { role: actionType, target: p.id, type: actionType === 'wolf' ? 'kill' : 'check' });
            btn.style.background = 'red';
            if(actionType === 'wolf') alert("已选择击杀");
        };
        grid.appendChild(btn);
    });
}

function renderWitchActions(state) {
    const div = document.getElementById('extra-actions');
    div.innerHTML = '';
    
    // 毒药
    const poisonBtn = document.createElement('button');
    poisonBtn.innerText = "使用毒药";
    poisonBtn.onclick = () => {
        const target = prompt("输入要毒的号码");
        if(target) socket.emit('action', { role: 'witch', target: target, type: 'poison' });
    };
    div.appendChild(poisonBtn);
    
    // 救药 (简单处理，直接盲救)
    const saveBtn = document.createElement('button');
    saveBtn.innerText = "使用解药";
    saveBtn.onclick = () => {
         socket.emit('action', { role: 'witch', type: 'save' });
         alert("已使用解药");
    };
    div.appendChild(saveBtn);
}

function roleName(r) {
    const map = { 'wolf': '🐺 狼人', 'villager': '🧑‍🌾 平民', 'witch': '🧪 女巫', 'seer': '🔮 预言家' };
    return map[r] || r;
}

// 上帝控制
function startGame() {
    socket.emit('admin-start', { wolf: 2, witch: true, seer: true });
}
function nextPhase(p) {
    socket.emit('admin-next-phase', p);
}

socket.on('seer-result', (res) => {
    alert(`查验结果：${res.name} 是 ${res.isGood ? '好人' : '狼人'}`);
});
