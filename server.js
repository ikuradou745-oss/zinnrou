import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { initializeApp, getApps } from 'firebase/app';
import { getFirestore, collection, doc, getDoc, getDocs, setDoc, deleteDoc, updateDoc } from 'firebase/firestore';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Server-side Firebase Firestore connection
const firebaseConfigFile = path.join(__dirname, 'firebase-applet-config.json');
let firestoreDb = null;
if (fs.existsSync(firebaseConfigFile)) {
  try {
    const fbConfig = JSON.parse(fs.readFileSync(firebaseConfigFile, 'utf8'));
    const fbApp = getApps().length === 0 ? initializeApp(fbConfig) : getApps()[0];
    firestoreDb = getFirestore(fbApp, fbConfig.firestoreDatabaseId);
    console.log('[jinrou-online] Server-side Firebase Firestore connected:', fbConfig.firestoreDatabaseId);
  } catch (err) {
    console.warn('[jinrou-online] Server Firebase init failed:', err.message);
  }
}

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

function ensureGameBundle() {
  const bundlePath = path.join(__dirname, 'game.js');
  if (!fs.existsSync(bundlePath)) {
    console.log('[jinrou-online] Bundling src/main.js with esbuild...');
    try {
      execSync('npx esbuild src/main.js --bundle --outfile=game.js --format=esm', {
        cwd: __dirname,
        stdio: 'inherit'
      });
      console.log('[jinrou-online] Successfully bundled game.js');
    } catch (e) {
      console.error('[jinrou-online] Failed to build game.js:', e);
    }
  }
}
ensureGameBundle();

app.use(express.json());
app.use(express.text({ type: ['text/plain', 'text/*'] }));
app.use((req, res, next) => {
  if (typeof req.body === 'string') {
    try {
      req.body = JSON.parse(req.body);
    } catch (e) {}
  }
  next();
});

// Enable CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Cache control
app.use((req, res, next) => {
  if (req.path === '/game.js' || req.path === '/' || req.path === '/index.html') {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

app.get('/favicon.ico', (req, res) => res.status(204).end());

app.get('/game.js', (req, res) => {
  const bundlePath = path.join(__dirname, 'game.js');
  if (fs.existsSync(bundlePath)) {
    res.setHeader('Content-Type', 'application/javascript; charset=UTF-8');
    res.sendFile(bundlePath);
  } else {
    ensureGameBundle();
    if (fs.existsSync(bundlePath)) {
      res.setHeader('Content-Type', 'application/javascript; charset=UTF-8');
      res.sendFile(bundlePath);
    } else {
      res.status(500).send('console.error("game.js bundle failed to build");');
    }
  }
});

app.use(express.static(__dirname));

// --- In-Memory Room Management ---
const rooms = new Map();

function generateRoomCode() {
  let code;
  do {
    code = Math.floor(1000 + Math.random() * 9000).toString();
  } while (rooms.has(code));
  return code;
}

async function getActiveRoomsSummary() {
  const roomsMap = new Map();

  // 1. In-memory active rooms
  for (const room of rooms.values()) {
    roomsMap.set(room.code, {
      code: room.code,
      name: room.name || `${room.hostNickname || 'ホスト'}の部屋`,
      hostNickname: room.hostNickname || 'ホスト',
      playerCount: room.players.size,
      maxPlayers: room.maxPlayers || 5,
      roleMode: room.roleMode || 'normal',
      discussionTime: room.discussionTime || 60,
      status: room.status || 'waiting'
    });
  }

  // 2. Merge with Firestore rooms across both collections (jinrou_rooms and rooms)
  if (firestoreDb) {
    const targetCollections = ['jinrou_rooms', 'rooms'];
    for (const col of targetCollections) {
      try {
        const snap = await getDocs(collection(firestoreDb, col));
        snap.forEach((docSnap) => {
          const data = docSnap.data();
          if (!data) return;
          const code = String(data.code ?? data.roomCode ?? data.id ?? docSnap.id).replace(/^[#＃\s]/g, '').trim();
          if (!code) return;

          const rawStatus = (data.status || 'waiting').toString().toLowerCase();
          if (rawStatus === 'finished' || rawStatus === 'ended' || rawStatus === 'closed') return;

          let count = 1;
          if (data.players && typeof data.players === 'object') {
            count = Array.isArray(data.players) ? data.players.length : Object.keys(data.players).length;
          } else if (Array.isArray(data.members)) {
            count = data.members.length;
          } else if (typeof data.playerCount === 'number') {
            count = data.playerCount;
          }

          if (count === 0) return;

          const hostNickname = data.hostNickname || data.hostName || data.host || data.owner || data.creator || 'ホスト';
          const roomName = (data.name || data.roomName || `${hostNickname}の部屋`).toString().slice(0, 8);
          const maxPlayers = Number(data.maxPlayers || data.max || data.capacity) || 5;
          const roleMode = (data.roleMode || 'normal') === 'original' ? 'original' : 'normal';
          const discussionTime = Number(data.discussionTime || data.time || data.discussion) || 60;
          const status = (rawStatus === 'in_game' || rawStatus === 'playing') ? 'in_game' : 'waiting';

          if (!roomsMap.has(code) || roomsMap.get(code).playerCount < count) {
            roomsMap.set(code, {
              code,
              name: roomName,
              hostNickname,
              playerCount: count,
              maxPlayers,
              roleMode,
              discussionTime,
              status
            });
          }
        });
      } catch (err) {
        console.warn(`[Server Firestore Active Rooms ${col}]`, err.message);
      }
    }
  }

  return Array.from(roomsMap.values());
}

async function broadcastActiveRoomsList() {
  const activeRooms = await getActiveRoomsSummary();
  const payload = JSON.stringify({
    type: 'ACTIVE_ROOMS_UPDATE',
    payload: { rooms: activeRooms }
  });
  if (typeof wss !== 'undefined' && wss && wss.clients) {
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try { client.send(payload); } catch (e) {}
      }
    }
  }
}

function generateBotAvatar(name) {
  const char = (name || 'B').trim().charAt(0);
  const colors = ['%23059669', '%230284c7', '%237c3aed', '%23d97706', '%23e11d48'];
  const col = colors[Math.abs((name || '').charCodeAt(0) || 0) % colors.length];
  return `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><circle cx="20" cy="20" r="20" fill="${col}"/><text x="20" y="26" font-size="18" text-anchor="middle" fill="white" font-weight="bold">${encodeURIComponent(char)}</text></svg>`;
}

function getRoomSnapshot(room) {
  if (!room) return null;
  const playersObj = {};
  for (const [id, p] of room.players.entries()) {
    playersObj[id] = {
      id: p.id,
      nickname: p.nickname || 'プレイヤー',
      avatarIcon: p.avatarIcon || '',
      isHost: !!p.isHost,
      isAlive: p.isAlive !== false,
      isVcOn: p.isVcOn !== false,
      isMuted: !!p.isMuted,
      isSpeaking: !!p.isSpeaking,
      hasVoted: room.game ? !!room.game.votes[id] : false,
      joinedAt: p.joinedAt || Date.now()
    };
  }
  const pendingRequestsArr = room.pendingRequests ? Array.from(room.pendingRequests.values()).map(r => ({
    requesterId: r.requesterId,
    nickname: r.nickname,
    timestamp: r.timestamp
  })) : [];

  return {
    code: room.code,
    name: room.name || `${room.hostNickname || 'ホスト'}の部屋`,
    hostId: room.hostId,
    hostNickname: room.hostNickname || 'ホスト',
    status: room.status || 'waiting',
    maxPlayers: room.maxPlayers || 5,
    discussionTime: room.discussionTime || 60,
    roleMode: room.roleMode || 'normal',
    rolesConfig: room.rolesConfig || {},
    rolesList: room.rolesList || [],
    players: playersObj,
    playerCount: room.players.size,
    pendingRequests: pendingRequestsArr,
    chatHistory: (room.chatHistory || []).slice(-30),
    game: room.game ? {
      phase: room.game.phase,
      phaseTitle: room.game.phaseTitle,
      dayCount: room.game.dayCount,
      timerSec: room.game.timerSec,
      lastExiled: room.game.lastExiled,
      lastVictim: room.game.lastVictim,
      revealedTraitor: room.game.revealedTraitor,
      hunterRevengeTarget: room.game.hunterRevengeTarget,
      winner: room.game.winner,
      winnerTitle: room.game.winnerTitle,
      allRolesRevealed: room.game.allRolesRevealed || null
    } : null
  };
}

function broadcastToRoom(roomCode, message, excludeWs = null) {
  const cleanCode = (roomCode || '').toString().replace(/^[#＃\s]/g, '').trim();
  const room = rooms.get(cleanCode);
  const payload = typeof message === 'string' ? message : JSON.stringify(message);
  const sentSockets = new Set();

  if (room && room.sockets) {
    for (const client of room.sockets.values()) {
      if (client && client.readyState === WebSocket.OPEN && client !== excludeWs) {
        try {
          client.send(payload);
          sentSockets.add(client);
        } catch (e) {}
      }
    }
  }

  // Also check wss.clients to ensure no reconnected socket is missed
  if (typeof wss !== 'undefined' && wss && wss.clients) {
    for (const client of wss.clients) {
      if (client && client.readyState === WebSocket.OPEN && client !== excludeWs && !sentSockets.has(client)) {
        if (client._roomCode === cleanCode) {
          try {
            client.send(payload);
            sentSockets.add(client);
          } catch (e) {}
        }
      }
    }
  }
}

function sendToPlayer(roomCode, playerId, message) {
  const room = rooms.get(roomCode);
  if (!room) return;
  const ws = room.sockets.get(playerId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    const payload = typeof message === 'string' ? message : JSON.stringify(message);
    try { ws.send(payload); } catch (e) {}
  }
}

// Role distribution helper (Guarantees at least 2 players and 1 Werewolf)
function assignRoles(playerIds, configuredRolesList) {
  const shuffledIds = [...playerIds].sort(() => Math.random() - 0.5);
  let pool = [...(configuredRolesList || [])];

  if (pool.length < shuffledIds.length) {
    const count = shuffledIds.length;
    if (count <= 2) {
      pool = ['werewolf', 'seer'];
    } else if (count === 3) {
      pool = ['werewolf', 'seer', 'villager'];
    } else if (count === 4) {
      pool = ['werewolf', 'seer', 'hunter_guard', 'villager'];
    } else if (count === 5) {
      pool = ['werewolf', 'traitor', 'seer', 'hunter_guard', 'villager'];
    } else if (count === 6) {
      pool = ['werewolf', 'werewolf', 'seer', 'hunter_guard', 'medium', 'villager'];
    } else {
      pool = ['werewolf', 'werewolf', 'traitor', 'seer', 'hunter_guard', 'medium'];
      while (pool.length < count) {
        pool.push('villager');
      }
    }
  }

  // Ensure there is at least one werewolf
  if (!pool.includes('werewolf')) {
    pool[0] = 'werewolf';
  }

  const shuffledRoles = [...pool].sort(() => Math.random() - 0.5);
  const assignments = {};
  shuffledIds.forEach((pid, idx) => {
    assignments[pid] = shuffledRoles[idx] || 'villager';
  });
  return assignments;
}

// REST Endpoints
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', app: 'jinrou-online', activeRooms: rooms.size });
});

app.get('/api/jinrou/rooms', async (req, res) => {
  const roomsList = await getActiveRoomsSummary();
  res.json({ rooms: roomsList });
});

app.get('/api/jinrou/rooms/:code', async (req, res) => {
  const cleanCode = (req.params.code || '').toString().replace(/^[#＃]/, '').trim();
  const room = await ensureRoomInMemory(cleanCode);
  if (!room) return res.status(404).json({ error: `部屋（#${cleanCode}）が見つかりませんでした` });
  res.json(getRoomSnapshot(room));
});

app.post('/api/jinrou/rooms', (req, res) => {
  const data = req.body || {};
  const code = (data.code || generateRoomCode()).toString().replace(/^[#＃]/, '').trim();
  const hostId = data.hostId || 'host_' + Date.now();
  const hostNickname = data.hostNickname || 'ホスト';
  const roomName = (data.name || data.roomName || `${hostNickname}の部屋`).toString().slice(0, 8);

  let room = rooms.get(code);
  if (!room) {
    room = {
      code,
      name: roomName,
      hostId,
      hostNickname,
      status: 'waiting',
      maxPlayers: Number(data.maxPlayers) || 5,
      discussionTime: Number(data.discussionTime) || 60,
      roleMode: data.roleMode || 'normal',
      rolesConfig: data.rolesConfig || {},
      rolesList: data.rolesList || [],
      players: new Map(),
      sockets: new Map(),
      pendingRequests: new Map(),
      chatHistory: [],
      game: null,
      timerInterval: null
    };
    rooms.set(code, room);
  } else {
    room.name = roomName;
    room.hostId = hostId;
    room.hostNickname = hostNickname;
    if (data.maxPlayers) room.maxPlayers = Number(data.maxPlayers);
    if (data.discussionTime) room.discussionTime = Number(data.discussionTime);
    if (data.roleMode) room.roleMode = data.roleMode;
    if (data.rolesConfig) room.rolesConfig = data.rolesConfig;
    if (data.rolesList) room.rolesList = data.rolesList;
    if (!room.pendingRequests) room.pendingRequests = new Map();
  }

  room.players.set(hostId, {
    id: hostId,
    nickname: hostNickname,
    avatarIcon: data.avatarIcon || '',
    isHost: true,
    isAlive: true,
    isVcOn: true,
    isMuted: false,
    isSpeaking: false,
    joinedAt: Date.now()
  });

  const snap = getRoomSnapshot(room);
  broadcastToRoom(code, { type: 'ROOM_UPDATE', payload: snap });
  broadcastActiveRoomsList();
  res.json(snap);
});

async function ensureRoomInMemory(code, roomData = null) {
  const cleanCode = (code || '').toString().replace(/^[#＃\s]/g, '').trim();
  let room = rooms.get(cleanCode);
  if (room) return room;

  let data = roomData;

  // If not provided in payload, check Firestore across both collections!
  if (!data && firestoreDb) {
    const targetCollections = ['jinrou_rooms', 'rooms'];
    for (const col of targetCollections) {
      try {
        const snap = await getDoc(doc(firestoreDb, col, cleanCode));
        if (snap && snap.exists()) {
          data = snap.data();
          break;
        }
      } catch (e) {
        console.warn(`[Server Firestore check ${col}/${cleanCode}]`, e.message);
      }
    }

    if (!data) {
      for (const col of targetCollections) {
        try {
          const snap = await getDocs(collection(firestoreDb, col));
          for (const d of snap.docs) {
            const docData = d.data();
            const docCode = String(docData.code ?? docData.roomCode ?? docData.id ?? d.id).replace(/^[#＃\s]/g, '').trim();
            if (docCode === cleanCode || d.id === cleanCode || d.id === `#${cleanCode}`) {
              data = docData;
              break;
            }
          }
          if (data) break;
        } catch (e) {}
      }
    }
  }

  if (data) {
    const hostNickname = data.hostNickname || data.hostName || data.host || data.owner || data.creator || 'ホスト';
    const roomName = (data.name || data.roomName || `${hostNickname}の部屋`).toString().slice(0, 8);
    const hostId = data.hostId || data.ownerId || ('host_' + cleanCode);
    const rawStatus = (data.status || 'waiting').toString().toLowerCase();
    const status = (rawStatus === 'in_game' || rawStatus === 'playing') ? 'in_game' : (rawStatus === 'finished' ? 'finished' : 'waiting');

    room = {
      code: cleanCode,
      name: roomName,
      hostId,
      hostNickname,
      status,
      maxPlayers: Number(data.maxPlayers || data.max || data.capacity) || 5,
      discussionTime: Number(data.discussionTime || data.time || data.discussion) || 60,
      roleMode: (data.roleMode || 'normal') === 'original' ? 'original' : 'normal',
      rolesConfig: data.rolesConfig || {},
      rolesList: data.rolesList || [],
      players: new Map(),
      sockets: new Map(),
      pendingRequests: new Map(),
      chatHistory: [],
      game: null,
      timerInterval: null
    };

    if (data.players && typeof data.players === 'object') {
      if (Array.isArray(data.players)) {
        data.players.forEach((p, idx) => {
          const pId = (p && p.id) ? String(p.id) : `p_${idx}`;
          room.players.set(pId, {
            id: pId,
            nickname: (typeof p === 'object' && p) ? (p.nickname || p.name || `プレイヤー${idx + 1}`) : String(p),
            avatarIcon: (typeof p === 'object' && p && p.avatarIcon) ? p.avatarIcon : '',
            isHost: (typeof p === 'object' && p) ? (p.isHost ?? (idx === 0)) : (idx === 0),
            isAlive: (typeof p === 'object' && p) ? (p.isAlive !== false) : true,
            isVcOn: (typeof p === 'object' && p) ? (p.isVcOn !== false) : true,
            isMuted: false,
            isSpeaking: false,
            joinedAt: (typeof p === 'object' && p && p.joinedAt) || Date.now()
          });
        });
      } else {
        for (const [pId, pInfo] of Object.entries(data.players)) {
          if (pInfo && typeof pInfo === 'object') {
            room.players.set(pId, {
              id: pId,
              nickname: pInfo.nickname || pInfo.name || 'プレイヤー',
              avatarIcon: pInfo.avatarIcon || '',
              isHost: !!pInfo.isHost || (hostId === pId),
              isAlive: pInfo.isAlive !== false,
              isVcOn: pInfo.isVcOn !== false,
              isMuted: !!pInfo.isMuted,
              isSpeaking: false,
              joinedAt: pInfo.joinedAt || Date.now()
            });
          }
        }
      }
    }

    if (room.players.size === 0) {
      room.players.set(hostId, {
        id: hostId,
        nickname: hostNickname,
        avatarIcon: data.avatarIcon || '',
        isHost: true,
        isAlive: true,
        isVcOn: true,
        isMuted: false,
        isSpeaking: false,
        joinedAt: Date.now()
      });
    }

    rooms.set(cleanCode, room);
    return room;
  }
  return null;
}

app.post('/api/jinrou/rooms/:code/join', async (req, res) => {
  const cleanCode = (req.params.code || '').toString().replace(/^[#＃]/, '').trim();
  const { playerId, playerNickname, isVcOn, roomData, avatarIcon } = req.body;
  const room = await ensureRoomInMemory(cleanCode, roomData);

  if (!room) return res.status(404).json({ error: `部屋（#${cleanCode}）が見つかりませんでした。コードをご確認ください。` });
  if (room.status !== 'waiting') return res.status(400).json({ error: 'ゲームが既に開始されているか終了しています。' });
  if (room.players.size >= (room.maxPlayers || 12) && !room.players.has(playerId)) {
    return res.status(400).json({ error: `部屋が満員です（定員: ${room.maxPlayers}人）` });
  }

  room.players.set(playerId, {
    id: playerId,
    nickname: playerNickname || 'プレイヤー',
    avatarIcon: avatarIcon || (roomData?.players?.[playerId]?.avatarIcon) || '',
    isHost: room.hostId === playerId,
    isAlive: true,
    isVcOn: isVcOn !== false,
    isMuted: false,
    isSpeaking: false,
    joinedAt: Date.now()
  });

  const snap = getRoomSnapshot(room);
  broadcastToRoom(cleanCode, { type: 'ROOM_UPDATE', payload: snap });
  broadcastActiveRoomsList();
  res.json(snap);
});

app.post('/api/jinrou/rooms/:code/leave', async (req, res) => {
  const cleanCode = (req.params.code || '').toString().replace(/^[#＃\s]/g, '').trim();
  const playerId = (req.body && req.body.playerId) || req.query.playerId;
  const isHost = (req.body && req.body.isHost) || req.query.isHost === 'true';
  if (cleanCode) {
    await handleLeave(null, cleanCode, playerId, true, isHost);
  }
  res.json({ success: true });
});

app.get('/api/jinrou/rooms/:code/leave', async (req, res) => {
  const cleanCode = (req.params.code || '').toString().replace(/^[#＃\s]/g, '').trim();
  const playerId = req.query.playerId;
  const isHost = req.query.isHost === 'true';
  if (cleanCode) {
    await handleLeave(null, cleanCode, playerId, true, isHost);
  }
  res.json({ success: true });
});

// REST Fallback for Chat (Dual-path delivery guarantee)
app.post('/api/jinrou/rooms/:code/chat', async (req, res) => {
  const cleanCode = (req.params.code || '').toString().replace(/^[#＃\s]/g, '').trim();
  const room = await ensureRoomInMemory(cleanCode);
  if (!room) return res.status(404).json({ error: '部屋が見つかりません' });
  const { id, senderId, senderName, text } = req.body || {};
  let rawText = String(text || '').trim();
  if (!rawText) return res.status(400).json({ error: 'メッセージが空です' });
  if (rawText.length > 20) rawText = rawText.slice(0, 20);

  const senderAvatar = (req.body && req.body.senderAvatar) || (room.players.get(senderId)?.avatarIcon) || '';
  const chatMsg = {
    id: id || ('msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6)),
    senderId: senderId || 'anon',
    senderName: senderName || (room.players.get(senderId)?.nickname) || 'プレイヤー',
    senderAvatar,
    text: rawText,
    timestamp: Date.now()
  };

  room.chatHistory = room.chatHistory || [];
  room.chatHistory.push(chatMsg);
  if (room.chatHistory.length > 50) room.chatHistory.shift();

  broadcastToRoom(cleanCode, {
    type: 'CHAT_MESSAGE',
    payload: chatMsg
  });

  res.json({ success: true, chatMsg });
});

app.post('/api/jinrou/rooms/:code/add-dummy', async (req, res) => {
  const cleanCode = (req.params.code || '').toString().replace(/^[#＃\s]/g, '').trim();
  const room = await ensureRoomInMemory(cleanCode);
  if (!room || room.status !== 'waiting') {
    return res.status(400).json({ error: '部屋が見つからないかゲーム中です' });
  }
  const dummyNames = ['タロウ', 'ハナコ', 'ケンジ', 'ユキ', 'シンジ', 'サクラ', 'レン', 'ミホ'];
  const count = room.players.size;
  if (count >= room.maxPlayers) {
    return res.status(400).json({ error: '満員です' });
  }
  const dummyId = 'dummy_' + Date.now() + '_' + Math.random().toString(36).substring(2, 5);
  const dummyName = dummyNames[(count - 1) % dummyNames.length] + ' (Bot)';
  room.players.set(dummyId, {
    id: dummyId,
    nickname: dummyName,
    isHost: false,
    isAlive: true,
    isVcOn: false,
    isMuted: true,
    isSpeaking: false,
    joinedAt: Date.now()
  });
  const snap = getRoomSnapshot(room);
  broadcastToRoom(cleanCode, { type: 'ROOM_UPDATE', payload: snap });
  broadcastActiveRoomsList();
  res.json(snap);
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let clientRoomCode = null;
  let clientPlayerId = null;

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const { type, payload } = msg;

      switch (type) {
        case 'GET_ACTIVE_ROOMS': {
          const activeRooms = await getActiveRoomsSummary();
          ws.send(JSON.stringify({
            type: 'ACTIVE_ROOMS_UPDATE',
            payload: { rooms: activeRooms }
          }));
          break;
        }

        case 'CREATE_ROOM': {
          const code = (payload.code || generateRoomCode()).toString().replace(/^[#＃]/, '').trim();
          const hostNickname = payload.nickname || 'ホスト';
          const roomName = (payload.name || payload.roomName || `${hostNickname}の部屋`).toString().slice(0, 8);
          clientRoomCode = code;
          clientPlayerId = payload.playerId;
          ws._roomCode = code;
          ws._playerId = payload.playerId;

          let room = rooms.get(code);
          if (!room) {
            room = {
              code,
              name: roomName,
              hostId: payload.playerId,
              hostNickname,
              status: 'waiting',
              maxPlayers: Number(payload.maxPlayers) || 5,
              discussionTime: Number(payload.discussionTime) || 60,
              roleMode: payload.roleMode || 'normal',
              rolesConfig: payload.rolesConfig || {},
              rolesList: payload.rolesList || [],
              players: new Map(),
              sockets: new Map(),
              pendingRequests: new Map(),
              chatHistory: [],
              game: null,
              timerInterval: null
            };
            rooms.set(code, room);
          } else {
            room.name = roomName;
            room.hostId = payload.playerId;
            room.hostNickname = hostNickname;
            if (payload.maxPlayers) room.maxPlayers = Number(payload.maxPlayers);
            if (payload.discussionTime) room.discussionTime = Number(payload.discussionTime);
            if (payload.roleMode) room.roleMode = payload.roleMode;
            if (payload.rolesConfig) room.rolesConfig = payload.rolesConfig;
            if (payload.rolesList) room.rolesList = payload.rolesList;
            if (!room.pendingRequests) room.pendingRequests = new Map();
          }

          room.players.set(payload.playerId, {
            id: payload.playerId,
            nickname: hostNickname,
            avatarIcon: payload.avatarIcon || '',
            isHost: true,
            isAlive: true,
            isVcOn: payload.isVcOn !== false,
            isMuted: false,
            isSpeaking: false,
            joinedAt: Date.now()
          });
          room.sockets.set(payload.playerId, ws);

          const snap = getRoomSnapshot(room);
          ws.send(JSON.stringify({
            type: 'ROOM_CREATED',
            payload: snap
          }));
          broadcastToRoom(code, { type: 'ROOM_UPDATE', payload: snap });
          broadcastActiveRoomsList();
          break;
        }

        case 'ADD_DUMMY_PLAYER': {
          const code = (payload.code || payload.roomCode || clientRoomCode || '').toString().replace(/^[#＃\s]/g, '').trim();
          const room = rooms.get(code);
          if (!room || room.status !== 'waiting') break;
          const dummyNames = ['タロウ', 'ハナコ', 'ケンジ', 'ユキ', 'シンジ', 'サクラ', 'レン', 'ミホ'];
          const count = room.players.size;
          if (count >= room.maxPlayers) break;
          const dummyId = 'dummy_' + Date.now() + '_' + Math.random().toString(36).substring(2, 5);
          const dummyName = dummyNames[(count - 1) % dummyNames.length] + ' (Bot)';
          room.players.set(dummyId, {
            id: dummyId,
            nickname: dummyName,
            avatarIcon: generateBotAvatar(dummyName),
            isHost: false,
            isAlive: true,
            isVcOn: false,
            isMuted: true,
            isSpeaking: false,
            joinedAt: Date.now()
          });
          const snap = getRoomSnapshot(room);
          broadcastToRoom(code, { type: 'ROOM_UPDATE', payload: snap });
          broadcastActiveRoomsList();
          break;
        }

        case 'JOIN_ROOM': {
          const code = (payload.code || '').toString().replace(/^[#＃]/, '').trim();
          const room = await ensureRoomInMemory(code, payload.roomData);
          if (!room) {
            return ws.send(JSON.stringify({
              type: 'ERROR',
              payload: { message: `部屋（#${code}）が見つかりません。` }
            }));
          }
          if (room.status !== 'waiting') {
            return ws.send(JSON.stringify({
              type: 'ERROR',
              payload: { message: 'ゲームが既に開始されているか終了しています。' }
            }));
          }
          if (room.players.size >= (room.maxPlayers || 12) && !room.players.has(payload.playerId)) {
            return ws.send(JSON.stringify({
              type: 'ERROR',
              payload: { message: `部屋が満員です（定員: ${room.maxPlayers}人）` }
            }));
          }

          clientRoomCode = code;
          clientPlayerId = payload.playerId;
          ws._roomCode = code;
          ws._playerId = payload.playerId;

          room.players.set(payload.playerId, {
            id: payload.playerId,
            nickname: payload.nickname || 'プレイヤー',
            avatarIcon: payload.avatarIcon || '',
            isHost: room.hostId === payload.playerId,
            isAlive: true,
            isVcOn: payload.isVcOn !== false,
            isMuted: false,
            isSpeaking: false,
            joinedAt: Date.now()
          });
          room.sockets.set(payload.playerId, ws);
          if (room.pendingRequests) room.pendingRequests.delete(payload.playerId);

          const snap = getRoomSnapshot(room);
          ws.send(JSON.stringify({ type: 'ROOM_JOINED', payload: snap }));
          broadcastToRoom(code, { type: 'ROOM_UPDATE', payload: snap }, ws);

          broadcastToRoom(code, {
            type: 'PEER_JOINED',
            payload: {
              peerId: payload.playerId,
              nickname: payload.nickname,
              isVcOn: payload.isVcOn !== false
            }
          }, ws);
          broadcastActiveRoomsList();
          break;
        }

        // --- Real-Time Join Room Flow (Direct, instant entry without host approval needed) ---
        case 'REQUEST_JOIN_ROOM': {
          const code = (payload.roomCode || payload.code || '').toString().replace(/^[#＃\s]/g, '').trim();
          const requesterId = payload.requesterId || payload.playerId;
          const requesterNickname = payload.requesterNickname || payload.nickname || 'プレイヤー';
          const isVcOn = payload.isVcOn !== false;

          const room = await ensureRoomInMemory(code, payload.roomData);
          if (!room) {
            return ws.send(JSON.stringify({
              type: 'JOIN_REQUEST_ERROR',
              payload: { message: `部屋（#${code}）が見つかりません。` }
            }));
          }
          if (room.status !== 'waiting') {
            return ws.send(JSON.stringify({
              type: 'JOIN_REQUEST_ERROR',
              payload: { message: 'この部屋は既にゲームが開始されているか終了しています。' }
            }));
          }
          if (room.players.size >= (room.maxPlayers || 12) && !room.players.has(requesterId)) {
            return ws.send(JSON.stringify({
              type: 'JOIN_REQUEST_ERROR',
              payload: { message: `部屋が満員です（定員: ${room.maxPlayers}人）` }
            }));
          }

          // Direct immediate join (ユーザー指示: コード入力の時招待はいらない、即入室)
          clientRoomCode = code;
          clientPlayerId = requesterId;
          ws._roomCode = code;
          ws._playerId = requesterId;
          room.players.set(requesterId, {
            id: requesterId,
            nickname: requesterNickname,
            avatarIcon: payload.avatarIcon || '',
            isHost: room.hostId === requesterId,
            isAlive: true,
            isVcOn,
            isMuted: false,
            isSpeaking: false,
            joinedAt: Date.now()
          });
          room.sockets.set(requesterId, ws);
          if (room.pendingRequests) room.pendingRequests.delete(requesterId);

          const snap = getRoomSnapshot(room);
          ws.send(JSON.stringify({ type: 'JOIN_REQUEST_APPROVED', payload: snap }));
          ws.send(JSON.stringify({ type: 'ROOM_JOINED', payload: snap }));
          broadcastToRoom(code, { type: 'ROOM_UPDATE', payload: snap }, ws);
          broadcastToRoom(code, {
            type: 'PEER_JOINED',
            payload: {
              peerId: requesterId,
              nickname: requesterNickname,
              isVcOn
            }
          }, ws);
          broadcastActiveRoomsList();
          break;
        }

        case 'RESPOND_JOIN_REQUEST': {
          const code = (payload.roomCode || clientRoomCode || '').toString().replace(/^[#＃]/, '').trim();
          const room = rooms.get(code);
          if (!room) return;

          if (room.hostId !== clientPlayerId) {
            return ws.send(JSON.stringify({
              type: 'ERROR',
              payload: { message: '参加申請を操作できるのはホストのみです。' }
            }));
          }

          const { requesterId, approved } = payload;
          if (!room.pendingRequests || !room.pendingRequests.has(requesterId)) return;

          const req = room.pendingRequests.get(requesterId);
          room.pendingRequests.delete(requesterId);

          if (approved) {
            if (room.players.size >= (room.maxPlayers || 12)) {
              if (req.ws && req.ws.readyState === WebSocket.OPEN) {
                req.ws.send(JSON.stringify({
                  type: 'JOIN_REQUEST_ERROR',
                  payload: { message: '部屋が満員になったため入室できませんでした。' }
                }));
              }
              broadcastToRoom(code, { type: 'ROOM_UPDATE', payload: getRoomSnapshot(room) });
              return;
            }

            room.players.set(requesterId, {
              id: requesterId,
              nickname: req.nickname || 'プレイヤー',
              isHost: false,
              isAlive: true,
              isVcOn: req.isVcOn !== false,
              isMuted: false,
              isSpeaking: false,
              joinedAt: Date.now()
            });

            if (req.ws && req.ws.readyState === WebSocket.OPEN) {
              room.sockets.set(requesterId, req.ws);
              req.ws._clientRoomCode = code;
              req.ws._clientPlayerId = requesterId;

              const snap = getRoomSnapshot(room);
              req.ws.send(JSON.stringify({
                type: 'JOIN_REQUEST_APPROVED',
                payload: snap
              }));
            }

            const snap = getRoomSnapshot(room);
            broadcastToRoom(code, { type: 'ROOM_UPDATE', payload: snap });
            broadcastToRoom(code, {
              type: 'PEER_JOINED',
              payload: {
                peerId: requesterId,
                nickname: req.nickname,
                isVcOn: req.isVcOn !== false
              }
            });
            broadcastActiveRoomsList();
          } else {
            if (req.ws && req.ws.readyState === WebSocket.OPEN) {
              req.ws.send(JSON.stringify({
                type: 'JOIN_REQUEST_REJECTED',
                payload: {
                  roomCode: code,
                  message: `ホスト（${room.hostNickname || 'ホスト'}）によって入室が見送られました。`
                }
              }));
            }
            broadcastToRoom(code, { type: 'ROOM_UPDATE', payload: getRoomSnapshot(room) });
          }
          break;
        }

        case 'CANCEL_JOIN_REQUEST': {
          const code = (payload.roomCode || '').toString().replace(/^[#＃]/, '').trim();
          const requesterId = payload.requesterId || clientPlayerId;
          const room = rooms.get(code);
          if (room && room.pendingRequests && room.pendingRequests.has(requesterId)) {
            room.pendingRequests.delete(requesterId);
            broadcastToRoom(code, { type: 'ROOM_UPDATE', payload: getRoomSnapshot(room) });
          }
          break;
        }

        // --- Start Game (Requires at least 3 players) ---
        case 'START_GAME': {
          if (!clientRoomCode) return;
          const room = rooms.get(clientRoomCode);
          if (!room) return;

          if (room.hostId !== clientPlayerId) {
            return ws.send(JSON.stringify({
              type: 'ERROR',
              payload: { message: 'ゲームを開始できるのはホストのみです。' }
            }));
          }

          // Minimum 2 players required to start (3+ players recommended)
          const currentCount = room.players.size;
          if (currentCount < 2) {
            return ws.send(JSON.stringify({
              type: 'ERROR',
              payload: {
                message: `ゲームを開始するには最低2人のプレイヤーが必要です（現在: ${currentCount}人）。「Bot追加」ボタンで練習用プレイヤーを追加できます。`
              }
            }));
          }

          // Assign secret roles
          const playerIds = Array.from(room.players.keys());
          const roleAssignments = assignRoles(playerIds, room.rolesList);

          for (const [pid, p] of room.players.entries()) {
            p.role = roleAssignments[pid] || 'villager';
            p.isAlive = true;
            p.usedArcher = false;
            p.usedMedic = false;
          }

          room.status = 'in_game';
          broadcastActiveRoomsList();
          room.game = {
            phase: 'role_reveal', // 1. Secret role announcement first
            phaseTitle: '📜 役職告知・確認',
            dayCount: 1,
            timerSec: 10, // 10 seconds for initial role reveal
            votes: {}, // voterId -> targetId
            nightActions: {}, // role -> targetId
            lastExiled: null,
            lastVictim: null,
            revealedTraitor: null,
            hunterRevengeTarget: null,
            winner: null,
            winnerTitle: null
          };

          // Start server authoritative phase timer
          startRoomTimer(room);

          // Broadcast game started with secret personal role
          for (const [pid, client] of room.sockets.entries()) {
            if (client && client.readyState === WebSocket.OPEN) {
              const myRole = roleAssignments[pid] || 'villager';
              client.send(JSON.stringify({
                type: 'GAME_STARTED',
                payload: {
                  ...getRoomSnapshot(room),
                  myRole
                }
              }));
            }
          }
          break;
        }

        // --- Game Actions ---
        case 'GAME_ACTION': {
          if (!clientRoomCode || !clientPlayerId) return;
          const room = rooms.get(clientRoomCode);
          if (!room || !room.game) return;

          const { action, targetId } = payload;
          const p = room.players.get(clientPlayerId);
          if (!p) return;

          handlePlayerGameAction(room, p, action, targetId, ws);
          break;
        }

        // --- Profile (Nickname / Avatar Icon) Updates ---
        case 'UPDATE_PROFILE': {
          const pId = payload.playerId || clientPlayerId;
          const code = (payload.roomCode || clientRoomCode || ws._roomCode || '').toString().replace(/^[#＃\s]/g, '').trim();
          if (code && rooms.has(code)) {
            const room = rooms.get(code);
            if (room.players.has(pId)) {
              const p = room.players.get(pId);
              if (payload.nickname) p.nickname = payload.nickname.slice(0, 8);
              if (payload.avatarIcon !== undefined) p.avatarIcon = payload.avatarIcon;
              if (p.isHost && payload.nickname) room.hostNickname = payload.nickname.slice(0, 8);
              const snap = getRoomSnapshot(room);
              broadcastToRoom(code, { type: 'ROOM_UPDATE', payload: snap });
              broadcastActiveRoomsList();
            }
          }
          break;
        }

        // --- Top-Left Chat Messages (Max 20 chars, format: [User]: [Content]) ---
        case 'CHAT_MESSAGE': {
          const code = (payload.roomCode || clientRoomCode || ws._roomCode || '').toString().replace(/^[#＃\s]/g, '').trim();
          if (!code) return;
          const room = rooms.get(code) || await ensureRoomInMemory(code);
          if (!room) return;

          clientRoomCode = code;
          ws._roomCode = code;
          if (payload.senderId) {
            clientPlayerId = payload.senderId;
            ws._playerId = payload.senderId;
            room.sockets.set(clientPlayerId, ws);
          }

          let rawText = String(payload.text || '').trim();
          if (!rawText) return;
          if (rawText.length > 20) {
            rawText = rawText.slice(0, 20); // Strict 20 char max
          }

          const senderAvatar = payload.senderAvatar || (room.players.get(clientPlayerId)?.avatarIcon) || '';
          const senderName = payload.senderName || (room.players.get(clientPlayerId)?.nickname) || 'プレイヤー';
          const chatMsg = {
            id: payload.id || ('msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6)),
            senderId: payload.senderId || clientPlayerId,
            senderName,
            senderAvatar,
            text: rawText,
            timestamp: Date.now()
          };

          room.chatHistory = room.chatHistory || [];
          room.chatHistory.push(chatMsg);
          if (room.chatHistory.length > 50) room.chatHistory.shift();

          broadcastToRoom(code, {
            type: 'CHAT_MESSAGE',
            payload: chatMsg
          });
          break;
        }

        // --- WebRTC Audio Signaling ---
        case 'WEBRTC_SIGNAL': {
          if (!clientRoomCode) return;
          const room = rooms.get(clientRoomCode);
          if (!room) return;

          const { targetId, signal } = payload;
          if (targetId) {
            sendToPlayer(clientRoomCode, targetId, {
              type: 'WEBRTC_SIGNAL',
              payload: {
                senderId: clientPlayerId,
                senderName: room.players.get(clientPlayerId)?.nickname || 'プレイヤー',
                signal
              }
            });
          } else {
            broadcastToRoom(clientRoomCode, {
              type: 'WEBRTC_SIGNAL',
              payload: {
                senderId: clientPlayerId,
                senderName: room.players.get(clientPlayerId)?.nickname || 'プレイヤー',
                signal
              }
            }, ws);
          }
          break;
        }

        case 'VOICE_STATE': {
          if (!clientRoomCode || !clientPlayerId) return;
          const room = rooms.get(clientRoomCode);
          if (!room) return;

          const p = room.players.get(clientPlayerId);
          if (p) {
            if (payload.isVcOn !== undefined) p.isVcOn = !!payload.isVcOn;
            if (payload.isMuted !== undefined) p.isMuted = !!payload.isMuted;
            if (payload.isSpeaking !== undefined) p.isSpeaking = !!payload.isSpeaking;

            broadcastToRoom(clientRoomCode, {
              type: 'VOICE_STATE_UPDATE',
              payload: {
                playerId: clientPlayerId,
                isVcOn: p.isVcOn,
                isMuted: p.isMuted,
                isSpeaking: p.isSpeaking
              }
            }, ws);
          }
          break;
        }

        case 'LEAVE_ROOM': {
          handleLeave(ws, clientRoomCode, clientPlayerId, true);
          clientRoomCode = null;
          clientPlayerId = null;
          break;
        }
      }
    } catch (err) {
      console.error('[WS Error]', err);
    }
  });

  ws.on('close', () => {
    handleLeave(ws, clientRoomCode, clientPlayerId, false);
  });
});

async function handleLeave(ws, roomCode, playerId, isExplicitLeave = false, forceHost = false) {
  // If this socket was waiting on a pending join request in any room, cancel it
  if (ws && ws._pendingRoomCode && ws._pendingRequesterId) {
    const pRoom = rooms.get(ws._pendingRoomCode);
    if (pRoom && pRoom.pendingRequests && pRoom.pendingRequests.has(ws._pendingRequesterId)) {
      pRoom.pendingRequests.delete(ws._pendingRequesterId);
      broadcastToRoom(ws._pendingRoomCode, { type: 'ROOM_UPDATE', payload: getRoomSnapshot(pRoom) });
    }
  }

  const cleanCode = (roomCode || '').toString().replace(/^[#＃\s]/g, '').trim();
  if (!cleanCode) return;

  const room = rooms.get(cleanCode);
  if (!room) {
    // If room is not in memory, delete from Firestore if host left
    if (forceHost && firestoreDb) {
      for (const col of ['jinrou_rooms', 'rooms']) {
        try {
          await deleteDoc(doc(firestoreDb, col, cleanCode));
        } catch (e) {}
      }
    }
    broadcastActiveRoomsList();
    return;
  }

  if (playerId) {
    room.sockets.delete(playerId);
    room.players.delete(playerId);
  }

  if (room.pendingRequests && playerId) {
    room.pendingRequests.delete(playerId);
  }

  // If no real players remain OR if the host leaves:
  const realPlayersLeft = Array.from(room.players.keys()).filter(id => !id.startsWith('dummy_')).length;
  const isHostLeaving = (room.hostId === playerId || forceHost);
  const shouldDeleteRoom = (room.players.size === 0) || (realPlayersLeft === 0) || isHostLeaving;

  if (shouldDeleteRoom) {
    if (room.timerInterval) clearInterval(room.timerInterval);
    if (room._cleanupTimer) clearTimeout(room._cleanupTimer);

    // Notify any remaining sockets that room was dissolved
    broadcastToRoom(cleanCode, {
      type: 'ROOM_CLOSED',
      payload: { message: 'ホストが退出したため部屋は解散されました。' }
    });

    rooms.delete(cleanCode);
    console.log(`[jinrou-online] Room #${cleanCode} deleted and closed.`);
    broadcastActiveRoomsList();

    if (firestoreDb) {
      for (const col of ['jinrou_rooms', 'rooms']) {
        try {
          await deleteDoc(doc(firestoreDb, col, cleanCode));
        } catch (e) {}
      }
    }
  } else {
    if (room.hostId === playerId) {
      const nextHostId = room.players.keys().next().value;
      if (nextHostId) {
        room.hostId = nextHostId;
        const nextHost = room.players.get(nextHostId);
        if (nextHost) {
          nextHost.isHost = true;
          room.hostNickname = nextHost.nickname;
        }
      }
    }
    broadcastToRoom(cleanCode, {
      type: 'PEER_LEFT',
      payload: { peerId: playerId }
    });
    const snap = getRoomSnapshot(room);
    broadcastToRoom(cleanCode, { type: 'ROOM_UPDATE', payload: snap });
    broadcastActiveRoomsList();

    if (firestoreDb) {
      for (const col of ['jinrou_rooms', 'rooms']) {
        try {
          const roomRef = doc(firestoreDb, col, cleanCode);
          const fsnap = await getDoc(roomRef);
          if (fsnap && fsnap.exists()) {
            const data = fsnap.data();
            const players = { ...(data.players || {}) };
            delete players[playerId];
            const remainingIds = Object.keys(players);
            if (remainingIds.length === 0) {
              await deleteDoc(roomRef);
            } else {
              let hId = data.hostId;
              if (hId === playerId) hId = room.hostId;
              const updatedMembers = remainingIds.map(id => ({
                id,
                nickname: players[id]?.nickname || 'プレイヤー',
                isHost: (id === hId),
                isOnline: true
              }));
              await updateDoc(roomRef, {
                hostId: hId,
                hostNickname: room.hostNickname,
                players,
                members: updatedMembers,
                playerCount: remainingIds.length
              });
            }
          }
        } catch (e) {}
      }
    }
  }
}

// --- Authoritative Game Timer & State Machine ---
function startRoomTimer(room) {
  if (room.timerInterval) clearInterval(room.timerInterval);

  room.timerInterval = setInterval(() => {
    if (!room.game || room.game.phase === 'game_over') {
      clearInterval(room.timerInterval);
      return;
    }

    room.game.timerSec = (room.game.timerSec || 1) - 1;

    // Send tick every second to keep clocks synchronized
    broadcastToRoom(room.code, {
      type: 'TIMER_TICK',
      payload: { timerSec: room.game.timerSec, phase: room.game.phase }
    });

    if (room.game.timerSec <= 0) {
      advanceGamePhase(room);
    }
  }, 1000);
}

// Helper: Check if specific role is alive in room
function hasAliveRole(room, roleName) {
  for (const p of room.players.values()) {
    if (p.isAlive && p.role === roleName) return true;
  }
  return false;
}

// Helper: Determine next night sub-phase (Skip roles not present or dead)
// ユーザー指定順序: 狩人が動いた後に人狼、その後に占い師や霊媒師やメディ
function getNextNightSubPhase(room, currentPhase) {
  const order = ['night_guard', 'night_werewolf', 'night_seer', 'night_medium', 'night_medic', 'night_archer'];
  const startIndex = currentPhase ? order.indexOf(currentPhase) + 1 : 0;

  for (let i = startIndex; i < order.length; i++) {
    const phaseKey = order[i];
    if (phaseKey === 'night_guard' && hasAliveRole(room, 'hunter_guard')) return phaseKey;
    if (phaseKey === 'night_werewolf' && hasAliveRole(room, 'werewolf')) return phaseKey;
    if (phaseKey === 'night_seer' && hasAliveRole(room, 'seer')) return phaseKey;
    if (phaseKey === 'night_medium' && hasAliveRole(room, 'medium')) return phaseKey;
    if (phaseKey === 'night_medic') {
      const medic = Array.from(room.players.values()).find(p => p.isAlive && p.role === 'medic' && !p.usedMedic);
      if (medic) return phaseKey;
    }
    if (phaseKey === 'night_archer') {
      const archer = Array.from(room.players.values()).find(p => p.isAlive && p.role === 'archer' && !p.usedArcher);
      if (archer) return phaseKey;
    }
  }
  return 'morning_result';
}

function simulateBotActions(room) {
  if (!room || !room.game) return;
  const g = room.game;
  const alivePlayers = Array.from(room.players.values()).filter(p => p.isAlive);
  const bots = alivePlayers.filter(p => p.id.startsWith('dummy_'));
  if (bots.length === 0) return;

  setTimeout(() => {
    if (!room.game || room.game.phase !== g.phase) return;

    if (g.phase === 'morning_voting') {
      bots.forEach(bot => {
        if (!g.votes[bot.id]) {
          const others = alivePlayers.filter(p => p.id !== bot.id);
          if (others.length > 0) {
            const pick = others[Math.floor(Math.random() * others.length)];
            g.votes[bot.id] = pick.id;
          }
        }
      });
      broadcastToRoom(room.code, {
        type: 'VOTE_RECORDED',
        payload: { totalVotes: Object.keys(g.votes).length }
      });
      if (Object.keys(g.votes).length >= alivePlayers.length) {
        advanceGamePhase(room);
      }
    } else if (g.phase === 'night_guard') {
      const botGuard = bots.find(b => b.role === 'hunter_guard');
      if (botGuard && !g.nightActions.hunter_guard) {
        const others = alivePlayers.filter(p => p.id !== botGuard.id);
        const pick = others[Math.floor(Math.random() * others.length)] || botGuard;
        g.nightActions.hunter_guard = pick.id;
        advanceGamePhase(room);
      }
    } else if (g.phase === 'night_werewolf') {
      const botWolf = bots.find(b => b.role === 'werewolf');
      if (botWolf && !g.nightActions.werewolf) {
        const targets = alivePlayers.filter(p => p.role !== 'werewolf');
        if (targets.length > 0) {
          const pick = targets[Math.floor(Math.random() * targets.length)];
          g.nightActions.werewolf = pick.id;
        }
        advanceGamePhase(room);
      }
    } else if (g.phase === 'night_seer') {
      const botSeer = bots.find(b => b.role === 'seer');
      if (botSeer) {
        advanceGamePhase(room);
      }
    } else if (g.phase === 'night_medic') {
      const botMedic = bots.find(b => b.role === 'medic' && !b.usedMedic);
      if (botMedic) {
        botMedic.usedMedic = true;
        advanceGamePhase(room);
      }
    }
  }, 1800);
}

// State Machine transitions
function advanceGamePhase(room) {
  if (!room || !room.game) return;
  const g = room.game;

  switch (g.phase) {
    case 'role_reveal': {
      // Role reveal ends -> Morning Discussion begins!
      g.phase = 'morning_discussion';
      g.phaseTitle = `☀️ ${g.dayCount}日目 朝の話し合い`;
      g.timerSec = room.discussionTime || 60; // ユーザー設定時間 (10s〜90s)
      break;
    }

    case 'morning_discussion': {
      // ユーザー指定: 朝（部屋を作る時指定した時間話し合いをしたあと、20秒間誰を追放するか選ぶ）
      g.phase = 'morning_voting';
      g.phaseTitle = '🗳️ 追放投票タイム（誰を追放するか選んでください）';
      g.timerSec = 20; // 厳密に20秒間
      g.votes = {};
      simulateBotActions(room);
      break;
    }

    case 'morning_voting': {
      // Voting ends -> Tally and Exclude
      const voteCounts = {};
      for (const targetId of Object.values(g.votes)) {
        if (targetId) voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
      }

      let maxVotes = 0;
      let exiledId = null;
      for (const [tId, count] of Object.entries(voteCounts)) {
        if (count > maxVotes) {
          maxVotes = count;
          exiledId = tId;
        }
      }

      const exiled = exiledId ? room.players.get(exiledId) : null;
      if (exiled) {
        exiled.isAlive = false;
        g.lastExiled = { id: exiled.id, nickname: exiled.nickname, role: exiled.role };
      } else {
        g.lastExiled = null;
      }

      g.phase = 'morning_execution';
      g.phaseTitle = '⚖️ 追放結果の発表';
      g.timerSec = 8;

      // Special Death Abilities: Mayor (村長)
      if (exiled && exiled.role === 'mayor') {
        const traitor = Array.from(room.players.values()).find(p => p.role === 'traitor');
        if (traitor) {
          g.revealedTraitor = { id: traitor.id, nickname: traitor.nickname };
        }
      }

      // Check Victory Condition immediately after exile!
      // ユーザー指定:（この時に市民チームが二人以下だったら人狼の勝ち）
      const winResult = checkWinConditions(room);
      if (winResult) {
        g.phase = 'game_over';
        g.winner = winResult.winner;
        g.winnerTitle = winResult.title;
        revealAllRoles(room);
      }
      break;
    }

    case 'morning_execution': {
      // If Hunter (道連れ) was exiled, allow revenge
      if (g.lastExiled && g.lastExiled.role === 'hunter_avenger' && !g.winner) {
        g.phase = 'hunter_revenge';
        g.phaseTitle = '🎯 ハンターの最後の道連れ射撃！';
        g.timerSec = 15;
        break;
      }

      // If game is over, stop
      if (g.winner) return;

      // Otherwise, transition to Night!
      g.nightActions = {};
      const nextNight = getNextNightSubPhase(room, null);
      setNightSubPhase(room, nextNight);
      break;
    }

    case 'hunter_revenge': {
      // Hunter revenge resolved -> Proceed to night or victory check
      const winResult = checkWinConditions(room);
      if (winResult) {
        g.phase = 'game_over';
        g.winner = winResult.winner;
        g.winnerTitle = winResult.title;
        revealAllRoles(room);
        break;
      }
      g.nightActions = {};
      const nextNight = getNextNightSubPhase(room, null);
      setNightSubPhase(room, nextNight);
      break;
    }

    // --- Night Turns in specified order: Hunter Guard -> Werewolf -> Seer -> Medium -> Archer -> Medic ---
    case 'night_guard':
    case 'night_werewolf':
    case 'night_seer':
    case 'night_medium':
    case 'night_archer':
    case 'night_medic': {
      const nextSub = getNextNightSubPhase(room, g.phase);
      if (nextSub === 'morning_result') {
        // Resolve Night Actions!
        resolveNightEvents(room);
      } else {
        setNightSubPhase(room, nextSub);
      }
      break;
    }

    case 'morning_result': {
      // If Hunter died at night, allow revenge
      if (g.lastVictim && g.lastVictim.role === 'hunter_avenger' && !g.winner) {
        g.phase = 'hunter_revenge';
        g.phaseTitle = '🎯 ハンターの道連れ反撃！';
        g.timerSec = 15;
        break;
      }

      // Check Victory Condition!
      const winResult = checkWinConditions(room);
      if (winResult) {
        g.phase = 'game_over';
        g.winner = winResult.winner;
        g.winnerTitle = winResult.title;
        revealAllRoles(room);
        break;
      }

      // Next Day Morning Discussion!
      g.dayCount += 1;
      g.phase = 'morning_discussion';
      g.phaseTitle = `☀️ ${g.dayCount}日目 朝の話し合い`;
      g.timerSec = room.discussionTime || 60;
      g.votes = {};
      g.lastExiled = null;
      g.lastVictim = null;
      break;
    }
  }

  broadcastToRoom(room.code, {
    type: 'PHASE_CHANGED',
    payload: getRoomSnapshot(room)
  });
}

function setNightSubPhase(room, phaseKey) {
  const g = room.game;
  g.phase = phaseKey;

  switch (phaseKey) {
    case 'night_guard':
      g.phaseTitle = '🛡️ 狩人のターン（守る人を1人選択）';
      g.timerSec = 15;
      break;
    case 'night_werewolf':
      g.phaseTitle = '🐺 人狼のターン（襲撃する人を1人選択）';
      g.timerSec = 20;
      break;
    case 'night_seer':
      g.phaseTitle = '🔮 占い師のターン（占う人を1人選択）';
      g.timerSec = 15;
      break;
    case 'night_medium':
      g.phaseTitle = '🕯️ 霊媒師のターン（追放者の魂と対話）';
      g.timerSec = 10;
      // Send medium result to alive medium
      if (g.lastExiled) {
        for (const [pid, p] of room.players.entries()) {
          if (p.isAlive && p.role === 'medium') {
            sendToPlayer(room.code, pid, {
              type: 'MEDIUM_RESULT',
              payload: {
                exiledNickname: g.lastExiled.nickname,
                exiledRole: g.lastExiled.role,
                isWerewolf: g.lastExiled.role === 'werewolf'
              }
            });
          }
        }
      }
      break;
    case 'night_medic':
      g.phaseTitle = '💉 メディのターン（復活させる味方を選択）';
      g.timerSec = 15;
      break;
    case 'night_archer':
      g.phaseTitle = '🏹 アーチャーのターン（狙撃するか選択）';
      g.timerSec = 15;
      break;
  }
  simulateBotActions(room);
}

// Night Actions Resolution
function resolveNightEvents(room) {
  const g = room.game;
  const actions = g.nightActions || {};

  const guardTargetId = actions.hunter_guard;
  const werewolfTargetId = actions.werewolf;
  const archerTargetId = actions.archer;
  const medicTargetId = actions.medic;

  let victimPlayer = null;

  // 1. Werewolf Attack (Protected if guarded)
  if (werewolfTargetId && werewolfTargetId !== guardTargetId) {
    victimPlayer = room.players.get(werewolfTargetId);
  }

  // 2. Archer shot (Direct kill)
  if (archerTargetId) {
    const archerVictim = room.players.get(archerTargetId);
    if (archerVictim) {
      archerVictim.isAlive = false;
      // If werewolf also killed them or someone else, archer shot kills them
      if (!victimPlayer) victimPlayer = archerVictim;
    }
  }

  // 3. Apply Werewolf death
  if (victimPlayer) {
    victimPlayer.isAlive = false;
    g.lastVictim = { id: victimPlayer.id, nickname: victimPlayer.nickname, role: victimPlayer.role };
  } else {
    g.lastVictim = null;
  }

  // 4. Medic Revive
  if (medicTargetId) {
    const revivedPlayer = room.players.get(medicTargetId);
    if (revivedPlayer) {
      revivedPlayer.isAlive = true;
      if (g.lastVictim && g.lastVictim.id === medicTargetId) {
        g.lastVictim = null; // Saved!
      }
    }
  }

  // Mayor killed at night
  if (victimPlayer && victimPlayer.role === 'mayor') {
    const traitor = Array.from(room.players.values()).find(p => p.role === 'traitor');
    if (traitor) {
      g.revealedTraitor = { id: traitor.id, nickname: traitor.nickname };
    }
  }

  g.phase = 'morning_result';
  g.phaseTitle = '🌅 昨夜の出来事・結果発表';
  g.timerSec = 8;
}

// Victory Condition Checker (Strictly follows user rules):
// 1. "人狼を追放できたらその場で村人チームの勝ち" (All werewolves dead -> Villager team wins!)
// 2. "市民チームが2人以下しかいなくなったら人狼チームの勝ち" (Citizen team members count <= 2 -> Werewolf team wins!)
function checkWinConditions(room) {
  const alivePlayers = Array.from(room.players.values()).filter(p => p.isAlive);
  const aliveWolves = alivePlayers.filter(p => p.role === 'werewolf');
  // Citizen team members (roles that belong to villager camp: villager, seer, hunter_guard, medium, mayor, medic, hunter_avenger, archer)
  const aliveCitizens = alivePlayers.filter(p => p.role !== 'werewolf' && p.role !== 'traitor');

  // Condition 1: All Werewolves eliminated
  if (aliveWolves.length === 0) {
    return {
      winner: 'villager',
      title: '🎉 人狼がすべて討ち取られました！村人チームの勝利！'
    };
  }

  // Condition 2: Citizen team <= 2 members left (ユーザー指定: この時に市民チームが二人以下だったら人狼の勝ち)
  if (room.players.size >= 4) {
    if (aliveCitizens.length <= 2) {
      return {
        winner: 'werewolf',
        title: '🐺 市民チームが2人以下になりました！人狼チームの完全勝利！'
      };
    }
  } else {
    // 2-3 player test games
    if (aliveCitizens.length <= 1 || aliveCitizens.length <= aliveWolves.length) {
      return {
        winner: 'werewolf',
        title: '🐺 市民チームが壊滅しました！人狼チームの完全勝利！'
      };
    }
  }

  return null;
}

function revealAllRoles(room) {
  const roles = {};
  for (const [pid, p] of room.players.entries()) {
    roles[pid] = {
      nickname: p.nickname,
      role: p.role,
      isAlive: p.isAlive
    };
  }
  room.game.allRolesRevealed = roles;
}

// Handling player actions
function handlePlayerGameAction(room, player, action, targetId, ws) {
  const g = room.game;
  if (!g) return;

  // 1. Voting
  if (action === 'CAST_VOTE' && g.phase === 'morning_voting' && player.isAlive) {
    g.votes[player.id] = targetId;
    broadcastToRoom(room.code, {
      type: 'VOTE_RECORDED',
      payload: { voterId: player.id, totalVotes: Object.keys(g.votes).length }
    });

    // If all alive players have voted, advance immediately!
    const aliveCount = Array.from(room.players.values()).filter(p => p.isAlive).length;
    if (Object.keys(g.votes).length >= aliveCount) {
      advanceGamePhase(room);
    }
  }

  // 2. Hunter Guard Action
  else if (action === 'GUARD_TARGET' && g.phase === 'night_guard' && player.role === 'hunter_guard' && player.isAlive) {
    g.nightActions.hunter_guard = targetId;
    ws.send(JSON.stringify({ type: 'ACTION_CONFIRMED', payload: { action: 'guard', targetId } }));
    advanceGamePhase(room);
  }

  // 3. Werewolf Attack Action
  else if (action === 'WEREWOLF_KILL' && g.phase === 'night_werewolf' && player.role === 'werewolf' && player.isAlive) {
    g.nightActions.werewolf = targetId;
    ws.send(JSON.stringify({ type: 'ACTION_CONFIRMED', payload: { action: 'werewolf_kill', targetId } }));
    advanceGamePhase(room);
  }

  // 4. Seer Divination Action
  else if (action === 'SEER_DIVINE' && g.phase === 'night_seer' && player.role === 'seer' && player.isAlive) {
    const targetPlayer = room.players.get(targetId);
    const isWolf = targetPlayer && targetPlayer.role === 'werewolf';
    ws.send(JSON.stringify({
      type: 'SEER_RESULT',
      payload: {
        targetId,
        targetNickname: targetPlayer ? targetPlayer.nickname : '対象',
        isWerewolf: isWolf
      }
    }));
    advanceGamePhase(room);
  }

  // 5. Archer Shot Action
  else if (action === 'ARCHER_SHOT' && g.phase === 'night_archer' && player.role === 'archer' && player.isAlive && !player.usedArcher) {
    player.usedArcher = true;
    g.nightActions.archer = targetId;
    ws.send(JSON.stringify({ type: 'ACTION_CONFIRMED', payload: { action: 'archer_shot', targetId } }));
    advanceGamePhase(room);
  }

  // 6. Medic Revive Action
  else if (action === 'MEDIC_REVIVE' && g.phase === 'night_medic' && player.role === 'medic' && player.isAlive && !player.usedMedic) {
    player.usedMedic = true;
    g.nightActions.medic = targetId;
    ws.send(JSON.stringify({ type: 'ACTION_CONFIRMED', payload: { action: 'medic_revive', targetId } }));
    advanceGamePhase(room);
  }

  // 7. Hunter Avenger Revenge Action (道連れ)
  else if (action === 'HUNTER_REVENGE' && g.phase === 'hunter_revenge') {
    const revengeTarget = room.players.get(targetId);
    if (revengeTarget) {
      revengeTarget.isAlive = false;
      g.hunterRevengeTarget = { id: revengeTarget.id, nickname: revengeTarget.nickname, role: revengeTarget.role };
    }
    advanceGamePhase(room);
  }

  // 8. Skip phase button for Host
  else if (action === 'HOST_SKIP_PHASE' && room.hostId === player.id) {
    advanceGamePhase(room);
  }
}

server.listen(PORT, HOST, () => {
  console.log(`[jinrou-online] Server running on http://${HOST}:${PORT}`);
});
