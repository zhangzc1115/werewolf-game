const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const os = require('os');

// 托管静态文件
app.use(express.static(path.join(__dirname, 'public')));

// 游戏状态
let gameState = {
    phase: 'waiting', // waiting, night, day
    players: [], // {id, name, role, alive, socketId}
    actions: {}  // 存储晚上的操作
};

// 获取本机局域网IP
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

io.on('connection', (socket) => {
    console.log('新玩家连接:', socket.id);

    // 玩家加入
    socket.on('join', (name) => {
        const existing = gameState.players.find(p => p.socketId === socket.id);
        if (!existing) {
            gameState.players.push({
                id: gameState.players.length + 1,
                name: name || `玩家${gameState.players.length + 1}`,
                role: '❓ 未分配',
                alive: true,
                socketId: socket.id
            });
        }
        io.emit('update', gameState);
    });

    // 上帝开始游戏/发牌
    socket.on('admin-start', (rolesConfig) => {
        // 洗牌逻辑
        let roles = [...rolesConfig]; // ['狼人','女巫'...]
        // Fisher-Yates Shuffle
        for (let i = roles.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [roles[i], roles[j]] = [roles[j], roles[i]];
        }
        
        // 分配给活着的玩家
        gameState.players.forEach((p, i) => {
            if (roles[i]) p.role = roles[i];
        });
        gameState.phase = 'night';
        gameState.actions = {};
        io.emit('update', gameState);
    });

    // 接收玩家行动
    socket.on('action', (data) => {
        // data: { type: 'kill', targetId: 1 }
        const player = gameState.players.find(p => p.socketId === socket.id);
        if (!player || !player.alive) return;

        console.log(`${player.name} 执行了 ${data.type} 针对 ${data.targetId}`);
        gameState.actions[player.role] = data; // 简单存储：狼人杀谁，女巫毒谁
        
        // 反馈给上帝端
        io.emit('admin-log', `${player.role} 执行了操作`);
    });

    // 上帝结算天亮
    socket.on('admin-day', () => {
        gameState.phase = 'day';
        // 这里可以添加复杂的结算逻辑，简单起见，由上帝口头宣布结果，只同步状态
        io.emit('update', gameState);
    });
    
    // 断开连接
    socket.on('disconnect', () => {
        gameState.players = gameState.players.filter(p => p.socketId !== socket.id);
        io.emit('update', gameState);
    });
});

const PORT = 3000;
http.listen(PORT, () => {
    console.log(`\n>>> 游戏服务器已启动! <<<`);
    console.log(`请让大家连接 Wi-Fi，并在手机浏览器输入: http://${getLocalIP()}:${PORT}\n`);
});
