const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const io = require('socket.io-client');

async function createClient(port) {
    const socket = io(`http://localhost:${port}`, {
        reconnectionDelay: 0,
        forceNew: true,
        transports: ['websocket'],
    });
    return new Promise((resolve) => {
        socket.on('connect', () => resolve(socket));
    });
}

test('Win Conditions: side-kill vs annihilation', async (t) => {
    const serverPort = 3000 + Math.floor(Math.random() * 1000);
    const server = spawn('node', ['server.js'], {
        env: { ...process.env, PORT: serverPort, WW_DISABLE_PERSIST: '1' },
    });

    // Wait for server to start
    await new Promise(resolve => setTimeout(resolve, 2000));

    const clients = [];
    // Need 4 players to start
    for (let i = 0; i < 4; i++) {
        const client = await createClient(serverPort);
        client.emit('join', `Player ${i + 1}`);
        clients.push(client);
    }

    // Wait for players to join
    await new Promise(resolve => setTimeout(resolve, 500));

    const admin = clients[0];
    admin.emit('admin-claim');

    const waitForState = (client, predicate) => {
        return new Promise(resolve => {
            const handler = (state) => {
                if (predicate(state)) {
                    client.off('update', handler);
                    resolve(state);
                }
            };
            client.on('update', handler);
        });
    };

    await t.test('Wolves win side-kill when all gods dead', async () => {
        // Start game with 1 wolf, 1 villager, 2 gods (witch, seer)
        admin.emit('admin-start', {
            rolesConfig: { wolf: 1, villager: 1, witch: 1, seer: 1, hunter: 0, idiot: 0, wolfKing: 0, hybrid: 0 },
            winCondition: 'side-kill'
        });

        let state = await waitForState(admin, s => s.phase !== 'waiting');
        
        // Find witch and seer and eliminate them
        const gods = state.players.filter(p => ['witch', 'seer'].includes(p.role));
        
        // Use admin-next-phase to move to day and then vote out
        admin.emit('admin-next-phase', 'day_announce');
        await waitForState(admin, s => s.phase === 'day_announce');

        // Eliminate god 1
        admin.emit('admin-day-vote', { targetId: gods[0].id });
        await waitForState(admin, s => s.players.find(p => p.id === gods[0].id).alive === false);

        // Move to next night and back to day to vote again
        admin.emit('admin-next-phase', 'wolf');
        admin.emit('admin-next-phase', 'day_announce');
        await waitForState(admin, s => s.phase === 'day_announce');

        // Eliminate god 2 -> should trigger wolf win because all gods are dead (side-kill)
        admin.emit('admin-day-vote', { targetId: gods[1].id });
        
        state = await waitForState(admin, s => s.phase === 'game_over');
        assert.strictEqual(state.winner.team, 'wolves');
        assert.ok(state.winner.reason.includes('gods eliminated'));
    });

    // Reset for next subtest
    admin.emit('hard-reset');
    await new Promise(resolve => setTimeout(resolve, 500));
    // Rejoin
    for (let i = 0; i < 4; i++) {
        clients[i].emit('join', `Player ${i + 1}`);
    }
    await new Promise(resolve => setTimeout(resolve, 500));
    admin.emit('admin-claim');

    await t.test('Wolves do NOT win annihilation when all gods dead but villager alive', async () => {
        admin.emit('admin-start', {
            rolesConfig: { wolf: 1, villager: 1, witch: 1, seer: 1, hunter: 0, idiot: 0, wolfKing: 0, hybrid: 0 },
            winCondition: 'annihilation'
        });

        let state = await waitForState(admin, s => s.phase !== 'waiting');
        const gods = state.players.filter(p => ['witch', 'seer'].includes(p.role));
        const villager = state.players.find(p => p.role === 'villager');

        // Eliminate god 1
        admin.emit('admin-next-phase', 'day_announce');
        admin.emit('admin-day-vote', { targetId: gods[0].id });
        await waitForState(admin, s => s.players.find(p => p.id === gods[0].id).alive === false);

        // Eliminate god 2
        admin.emit('admin-next-phase', 'wolf');
        admin.emit('admin-next-phase', 'day_announce');
        admin.emit('admin-day-vote', { targetId: gods[1].id });
        await waitForState(admin, s => s.players.find(p => p.id === gods[1].id).alive === false);

        // Check state - should NOT be game over yet because villager is alive
        state = await waitForState(admin, s => s.phase === 'day_announce');
        assert.notStrictEqual(state.phase, 'game_over');

        // Now eliminate villager -> should be game over
        admin.emit('admin-next-phase', 'wolf');
        admin.emit('admin-next-phase', 'day_announce');
        admin.emit('admin-day-vote', { targetId: villager.id });

        state = await waitForState(admin, s => s.phase === 'game_over');
        assert.strictEqual(state.winner.team, 'wolves');
    });

    // Cleanup
    for (const client of clients) {
        client.disconnect();
    }
    server.kill();
});
