/* Modified by easyCube, 2026-09-24 through 2026-10-31. Distributed under AGPL-3.0. See MODIFICATIONS.md and AGPLv3.md. */
/*
VDO.Ninja Advanced Example
Copyright Steve Seguin
License: AGPLv3
&wss2=wss.yourdomain.com -- if testing via URL
session.wss = "wss://wss.yourdomain.com:443";
session.customWSS = false;
*/
const fs = require('fs');
const http = require('http');
const https = require('https');
const { randomUUID } = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const accessPolicy = JSON.parse(fs.readFileSync(process.env.ACCESS_POLICY || '/run/secrets/access-policy.json', 'utf8'));
if (!accessPolicy || accessPolicy.version !== 5 || !accessPolicy.accounts || !accessPolicy.rooms ||
    !/^[a-f0-9]{6}$/i.test(accessPolicy.wireStreamSuffix || '') ||
    !['test', 'staging', 'production'].every(name =>
        typeof accessPolicy.rooms[name]?.id === 'string' &&
        /^[a-f0-9]{16}$/i.test(accessPolicy.rooms[name]?.wireId || '') &&
        typeof accessPolicy.rooms[name]?.returnStream === 'string' &&
        /^ProdTalk[a-f0-9]{24}$/.test(accessPolicy.rooms[name]?.talkStream || ''))) {
    throw new Error('Access policy is missing or invalid');
}
if (new Set(Object.values(accessPolicy.rooms).map(room => room.wireId.toLowerCase())).size !== 3) {
    throw new Error('Room wire IDs must be distinct');
}
const talkStreams = Object.values(accessPolicy.rooms).map(room => room.talkStream);
if (new Set(talkStreams).size !== 3 || talkStreams.some(stream =>
    Object.values(accessPolicy.rooms).some(room => room.returnStream === stream) ||
    Object.values(accessPolicy.accounts).some(account => account.pushStream === stream))) {
    throw new Error('Production talk streams must be distinct');
}
if (accessPolicy.accounts.Production?.role !== 'director' ||
    accessPolicy.accounts.Production.pushStream || accessPolicy.accounts.Production.room ||
    !Array.isArray(accessPolicy.accounts.Production.rooms) ||
    new Set(accessPolicy.accounts.Production.rooms).size !== 3 ||
    !['test', 'staging', 'production'].every(name => accessPolicy.accounts.Production.rooms.includes(name)) ||
    !['test', 'staging', 'production'].every(name => {
        const account = accessPolicy.accounts[`${name[0].toUpperCase()}${name.slice(1)}Director`];
        return account?.role === 'codirector' && account.room === name &&
            account.pushStream === accessPolicy.rooms[name].returnStream;
    })) {
    throw new Error('Director policy is missing or invalid');
}

function createServer() {
    const certPath = process.env.SERVER_CERT || process.env.CERT_PATH; // "/etc/letsencrypt/live/wss.yourdomain.com/fullchain.pem";
    const keyPath = process.env.SERVER_KEY || process.env.KEY_PATH; // "/etc/letsencrypt/live/wss.yourdomain.com/privkey.pem";
    if (certPath && keyPath) {
        try {
            const cert = fs.readFileSync(certPath);
            const key = fs.readFileSync(keyPath);
            const server = https.createServer({ cert, key }, (_, res) => {
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end('Secure VDONinja server');
            });
            return { server, port: Number(process.env.PORT) || 443 };
        } catch (error) {
            console.error('TLS configuration failed, falling back to HTTP:', error.message);
        }
    }
    const server = http.createServer((_, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('VDONinja server');
    });
    return { server, port: Number(process.env.PORT) || 80 };
}

function readId(input) {
    return typeof input === 'string' ? input.trim() : '';
}

function wireStreamId(input) {
    return typeof input === 'string' && input ? input.slice(0, 64) + accessPolicy.wireStreamSuffix : null;
}

function safeSend(ws, payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        try {
            ws.send(payload);
        } catch (error) {
            ws.terminate();
        }
    }
}

const { server, port } = createServer();
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 262144, perMessageDeflate: false });
const clients = new Map();
const streams = new Map();
const streamIDs = new Map();
const callbackView = new Map();
const callbackCleanup = new Map();
const directors = new Map();
const myRooms = new Map();
const roomList = new Map();
const identities = new Map();
const mediaSubscriptions = new Map();

function isFixedParticipant(account) {
    return ['participant', 'creator', 'guest'].includes(account?.role);
}

function participantStreamInRoom(roomName, streamID) {
    if (wireStreamId(accessPolicy.rooms[roomName]?.talkStream) === streamID) return true;
    return Object.values(accessPolicy.accounts).some(item =>
        item.room === roomName && isFixedParticipant(item) &&
        wireStreamId(item.pushStream) === streamID);
}

function productionTalkRoom(streamID) {
    return Object.keys(accessPolicy.rooms).find(name =>
        wireStreamId(accessPolicy.rooms[name].talkStream) === streamID) || null;
}

function productionMaySeed(account, uuid, streamID) {
    if (account !== accessPolicy.accounts.Production) return false;
    const roomName = productionTalkRoom(streamID);
    if (!roomName) return false;
    const joined = myRooms.get(uuid);
    if (joined && directors.get(joined) === uuid) return false;
    return !joined || joined === accessPolicy.rooms[roomName].wireId.toLowerCase();
}

function allowMediaSignaling(viewerUUID, seederUUID) {
    if (!mediaSubscriptions.has(viewerUUID)) mediaSubscriptions.set(viewerUUID, new Set());
    mediaSubscriptions.get(viewerUUID).add(seederUUID);
}

function hasMediaSignaling(left, right) {
    return mediaSubscriptions.get(left)?.has(right) || mediaSubscriptions.get(right)?.has(left);
}

function assignedRoom(account) {
    return accessPolicy.rooms[account.room] || null;
}

function obsViewerAccount(username) {
    if (typeof username !== 'string' || !username.startsWith('obs-view:')) return null;
    const participant = accessPolicy.accounts[username.slice('obs-view:'.length)];
    if (!participant || !['participant', 'creator', 'guest'].includes(participant.role) ||
        !accessPolicy.rooms[participant.room] || typeof participant.pushStream !== 'string') return null;
    return { role: 'obs-viewer', room: participant.room, viewStream: participant.pushStream };
}

function mayEnterRoom(account, wireId) {
    if (account.role === 'director' && Array.isArray(account.rooms)) {
        return account.rooms.some(name => accessPolicy.rooms[name]?.wireId.toLowerCase() === wireId);
    }
    const room = assignedRoom(account);
    return Boolean(room && room.wireId.toLowerCase() === wireId);
}

function inSameRoom(left, right) {
    const room = myRooms.get(left);
    return Boolean(room && room === myRooms.get(right));
}

function offerQueued(streamID, seederUUID) {
    const watchers = callbackView.get(streamID);
    if (!watchers) return;
    const remaining = [];
    for (const viewer of watchers) {
        if (!clients.has(viewer)) continue;
        if (!inSameRoom(viewer, seederUUID)) {
            remaining.push(viewer);
            continue;
        }
        const pending = callbackCleanup.get(viewer);
        if (pending) {
            pending.delete(streamID);
            if (!pending.size) callbackCleanup.delete(viewer);
        }
        allowMediaSignaling(viewer, seederUUID);
        safeSend(clients.get(seederUUID), JSON.stringify({ request: 'offerSDP', UUID: viewer }));
    }
    if (remaining.length) callbackView.set(streamID, remaining);
    else callbackView.delete(streamID);
}

function removeFromCallback(uuid) {
    if (!callbackCleanup.has(uuid)) return;
    const pending = callbackCleanup.get(uuid);
    callbackCleanup.delete(uuid);
    pending.forEach(streamID => {
        if (!callbackView.has(streamID)) return;
        const list = callbackView.get(streamID);
        const index = list.indexOf(uuid);
        if (index !== -1) list.splice(index, 1);
        if (!list.length) callbackView.delete(streamID);
    });
}

function cleanupClient(uuid) {
    if (!clients.has(uuid)) return;
    clients.delete(uuid);
    identities.delete(uuid);
    mediaSubscriptions.delete(uuid);
    for (const peers of mediaSubscriptions.values()) peers.delete(uuid);
    if (streamIDs.has(uuid)) {
        const streamID = streamIDs.get(uuid);
        streamIDs.delete(uuid);
        if (streams.get(streamID) === uuid) streams.delete(streamID);
    }
    if (myRooms.has(uuid)) {
        const roomid = myRooms.get(uuid);
        myRooms.delete(uuid);
        if (directors.get(roomid) === uuid) directors.delete(roomid);
        if (roomList.has(roomid)) {
            const members = roomList.get(roomid);
            const index = members.indexOf(uuid);
            if (index !== -1) members.splice(index, 1);
            if (!members.length) roomList.delete(roomid);
        }
    }
    removeFromCallback(uuid);
}

function queueForStream(uuid, streamID) {
    if (!callbackView.has(streamID)) callbackView.set(streamID, []);
    const queue = callbackView.get(streamID);
    if (!queue.includes(uuid)) queue.push(uuid);
    if (!callbackCleanup.has(uuid)) callbackCleanup.set(uuid, new Set());
    callbackCleanup.get(uuid).add(streamID);
}

function notifyRoom(roomid, payload, skip) {
    if (!roomList.has(roomid)) return;
    const message = typeof payload === 'string' ? payload : JSON.stringify(payload);
    roomList.get(roomid).forEach(member => {
        if (skip && skip.includes(member)) return;
        const viewer = identities.get(member);
        if (viewer?.role === 'obs-viewer' &&
            (typeof payload !== 'object' || payload.streamID !== wireStreamId(viewer.viewStream))) return;
        safeSend(clients.get(member), message);
    });
}

wss.on('connection', (ws, request) => {
    const origin = request.headers.origin;
    if (origin && origin !== 'https://video.easy-cube.de') {
        ws.close(1008, 'Origin not allowed');
        return;
    }
    const username = request.headers['x-authenticated-user'];
    const account = typeof username === 'string' && Object.hasOwn(accessPolicy.accounts, username)
        ? accessPolicy.accounts[username] : obsViewerAccount(username);
    if (!account || !['director', 'codirector', 'participant', 'creator', 'guest', 'obs', 'obs-viewer'].includes(account.role)) {
        ws.close(1008, 'Authentication required');
        return;
    }
    // Treat the former creator role as a fixed participant during migration.
    const fixedParticipant = isFixedParticipant(account);
    const room = assignedRoom(account);
    if (clients.size >= 128) {
        ws.close(1013, 'Server busy');
        return;
    }
    const uuid = randomUUID();
    clients.set(uuid, ws);
    identities.set(uuid, account);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('close', () => cleanupClient(uuid));
    ws.on('error', () => cleanupClient(uuid));
    ws.on('message', raw => {
        let data;
        try {
            data = JSON.parse(raw);
        } catch (error) {
            return;
        }
        if (!data || typeof data !== 'object' || Array.isArray(data)) return;
        if (!data.request) {
            if (!data.UUID) return;
            const target = clients.get(data.UUID);
            if (!target) return;
            if (!inSameRoom(uuid, data.UUID)) return;
            const peer = identities.get(data.UUID);
            if (!peer || (fixedParticipant && isFixedParticipant(peer) &&
                !hasMediaSignaling(uuid, data.UUID))) return;
            if (account.role === 'obs-viewer' &&
                streamIDs.get(data.UUID) !== wireStreamId(account.viewStream)) return;
            if (peer.role === 'obs-viewer' &&
                streamIDs.get(uuid) !== wireStreamId(peer.viewStream)) return;
            data.UUID = uuid;
            safeSend(target, JSON.stringify(data));
            return;
        }
        const requester = clients.get(uuid);
        if (!requester) return;
        switch (data.request) {
            case 'play': {
                const streamID = readId(data.streamID);
                if (!streamID) return;
                if (account.role === 'obs-viewer' && streamID !== wireStreamId(account.viewStream)) {
                    safeSend(requester, JSON.stringify({ request: 'alert', message: 'This OBS link cannot view that stream.' }));
                    return;
                }
                if (fixedParticipant && streamID !== wireStreamId(room?.returnStream) &&
                    !participantStreamInRoom(account.room, streamID)) {
                    safeSend(requester, JSON.stringify({ request: 'alert', message: 'This guest link cannot view that stream.' }));
                    return;
                }
                if (account.role === 'obs' && streamID !== wireStreamId(room?.returnStream) &&
                    !participantStreamInRoom(account.room, streamID)) {
                    safeSend(requester, JSON.stringify({ request: 'alert', message: 'This source is not configured for OBS.' }));
                    return;
                }
                if (!streams.has(streamID)) {
                    queueForStream(uuid, streamID);
                    return;
                }
                const seederUUID = streams.get(streamID);
                if (seederUUID === uuid) return;
                const seeder = clients.get(seederUUID);
                if (!seeder || seeder.readyState !== WebSocket.OPEN) {
                    cleanupClient(seederUUID);
                    queueForStream(uuid, streamID);
                    return;
                }
                if (!inSameRoom(uuid, seederUUID)) {
                    queueForStream(uuid, streamID);
                    return;
                }
                allowMediaSignaling(uuid, seederUUID);
                safeSend(seeder, JSON.stringify({ request: 'offerSDP', UUID: uuid }));
                break;
            }
            case 'seed': {
                const streamID = readId(data.streamID);
                if (!streamID) return;
                if ((fixedParticipant && streamID !== wireStreamId(account.pushStream)) ||
                    (account.role === 'codirector' && streamID !== wireStreamId(room?.returnStream)) ||
                    account.role === 'obs' ||
                    (account.role === 'director' && !productionMaySeed(account, uuid, streamID)) ||
                    account.role === 'obs-viewer') {
                    safeSend(requester, JSON.stringify({ request: 'alert', message: 'This account cannot create that stream.' }));
                    return;
                }
                if (streams.has(streamID)) {
                    const existing = streams.get(streamID);
                    if (existing !== uuid) {
                        const existingWS = clients.get(existing);
                        if (existingWS && existingWS.readyState === WebSocket.OPEN) {
                            safeSend(requester, JSON.stringify({ request: 'alert', message: 'Stream ID is already in use.' }));
                            return;
                        }
                        cleanupClient(existing);
                    }
                }
                streams.set(streamID, uuid);
                streamIDs.set(uuid, streamID);
                if (myRooms.has(uuid)) {
                    const roomid = myRooms.get(uuid);
                    notifyRoom(roomid, { request: 'videoaddedtoroom', UUID: uuid, streamID }, [uuid]);
                }
                offerQueued(streamID, uuid);
                break;
            }
            case 'joinroom': {
                const input = readId(data.roomid).toLowerCase();
                if (!input || myRooms.has(uuid)) return;
                const preseededTalkRoom = account === accessPolicy.accounts.Production &&
                    streamIDs.has(uuid) ? productionTalkRoom(streamIDs.get(uuid)) : null;
                if (!mayEnterRoom(account, input) ||
                    (streamIDs.has(uuid) && account === accessPolicy.accounts.Production &&
                        accessPolicy.rooms[preseededTalkRoom]?.wireId.toLowerCase() !== input) ||
                    (data.claim && (account.role !== 'director' || streamIDs.has(uuid)))) {
                    safeSend(requester, JSON.stringify({ request: 'alert', message: 'This account cannot enter that room.' }));
                    return;
                }
                myRooms.set(uuid, input);
                let isDirector = false;
                const response = { request: 'listing', list: [] };
                if (data.claim) {
                    const currentDirector = directors.get(input);
                    if (!currentDirector || !clients.has(currentDirector)) {
                        directors.set(input, uuid);
                        response.claim = true;
                        isDirector = true;
                    } else {
                        response.claim = currentDirector === uuid;
                        if (!response.claim) response.director = currentDirector;
                    }
                } else if (directors.has(input)) {
                    response.director = directors.get(input);
                }
                if (!roomList.has(input)) roomList.set(input, []);
                const members = roomList.get(input);
                members.forEach(member => {
                    const entry = { UUID: member };
                    if (streamIDs.has(member)) entry.streamID = streamIDs.get(member);
                    if (account.role === 'obs-viewer' &&
                        entry.streamID !== wireStreamId(account.viewStream)) return;
                    response.list.push(entry);
                });
                safeSend(requester, JSON.stringify(response));
                const notice = { request: 'someonejoined', UUID: uuid };
                if (isDirector) notice.director = true;
                if (streamIDs.has(uuid)) notice.streamID = streamIDs.get(uuid);
                notifyRoom(input, notice, [uuid]);
                members.push(uuid);
                if (streamIDs.has(uuid)) offerQueued(streamIDs.get(uuid), uuid);
                break;
            }
            case 'migrate': {
                if (account.role !== 'director') return;
                const target = readId(data.target);
                const destination = readId(data.roomid).toLowerCase();
                if (!target || !destination) return;
                const targetAccount = identities.get(target);
                if (targetAccount?.room && destination !== assignedRoom(targetAccount)?.wireId.toLowerCase()) return;
                const directorRoom = myRooms.get(uuid);
                if (!directorRoom || directors.get(directorRoom) !== uuid) return;
                const sourceRoom = myRooms.get(target);
                if (!sourceRoom || sourceRoom !== directorRoom || target === uuid) return;
                const members = roomList.get(sourceRoom);
                if (!members) return;
                const index = members.indexOf(target);
                if (index === -1) return;
                members.splice(index, 1);
                if (!members.length) roomList.delete(sourceRoom);
                myRooms.set(target, destination);
                if (!roomList.has(destination)) roomList.set(destination, []);
                const destMembers = roomList.get(destination);
                const view = { request: 'transferred', list: [] };
                if (directors.has(destination)) view.director = directors.get(destination);
                destMembers.forEach(member => {
                    const entry = { UUID: member };
                    if (streamIDs.has(member)) entry.streamID = streamIDs.get(member);
                    view.list.push(entry);
                });
                safeSend(clients.get(target), JSON.stringify(view));
                notifyRoom(destination, { request: 'someonejoined', UUID: target, streamID: streamIDs.get(target) }, [target]);
                destMembers.push(target);
                break;
            }
        }
    });
});

setInterval(() => {
    for (const ws of clients.values()) {
        if (!ws.isAlive) {
            ws.terminate();
            continue;
        }
        ws.isAlive = false;
        ws.ping();
    }
}, 30000).unref();

server.listen(port, () => {
    console.log(`VDONinja WebSocket server listening on port ${port}`);
});
