const WebSocket = require('ws');
const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

const rooms = {};
const clientLastMsg = new Map();
const RATE_LIMIT_MS = 200;
const randomID = () => Math.random().toString(36).slice(2, 6);

function encode(type, ...parts) {
    const totalLen = parts.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(totalLen + 1);
    out[0] = type;
    let offset = 1;
    for (let p of parts) {
        out.set(p, offset);
        offset += p.length;
    }
    return out;
}

function strBytes(s) {
    const b = new TextEncoder().encode(s);
    return new Uint8Array([b.length, ...b]);
}

function parseStr(buf, offset = 1) {
    const len = buf[offset];
    const str = new TextDecoder().decode(buf.slice(offset + 1, offset + 1 + len));
    return [str, offset + 1 + len];
}

wss.on('connection', (ws) => {
    const id = randomID();
    let room = null;

    ws.on('message', (msg) => {
        const type = msg[0];

        if (type === 0x01) {
            // handshake: join room
            const [roomName] = parseStr(msg);
            room = roomName;
            rooms[room] = rooms[room] || [];
            rooms[room].push([id, ws]);

            ws.send(encode(0x02, strBytes(id))); // ack
            broadcast(room, encode(0x03, strBytes(id)), id); // joined
        }

        if (type === 0x05 && room) {
            // ratelimit check
            const now = Date.now();
            const last = clientLastMsg.get(id) || 0;
            if (now - last < RATE_LIMIT_MS) return;
            clientLastMsg.set(id, now);

            // message: forward to all or one
            const [targetId, dataStart] = parseStr(msg);
            const payload = msg.slice(dataStart);

            if (targetId === 'all') {
                broadcast(room, encode(0x05, strBytes(id), payload), id);
            } else {
                const target = rooms[room]?.find(([cid]) => cid === targetId);
                if (target) target[1].send(encode(0x05, strBytes(id), payload));
            }
        }

        if (type === 0x06) {
            // pong back from client (optional)
            ws.send(encode(0x07));
        }
    });

    ws.on('close', () => {
        if (!room || !rooms[room]) return;
        rooms[room] = rooms[room].filter(([cid]) => cid !== id);
        broadcast(room, encode(0x04, strBytes(id)));
        if (rooms[room].length === 0) delete rooms[room];
    });
});

function broadcast(room, msg, exclude = null) {
    if (!rooms[room]) return;
    for (let [cid, ws] of rooms[room]) {
        if (cid !== exclude) ws.send(msg);
    }
}

// server pings all clients every 20s to keep sockets alive
setInterval(() => {
    for (const room in rooms) {
        for (const [cid, ws] of rooms[room]) {
            if (ws.readyState === WebSocket.OPEN) {
                try {
                    ws.send(encode(0x06)); // ping
                } catch { }
            }
        }
    }
}, 20000);
