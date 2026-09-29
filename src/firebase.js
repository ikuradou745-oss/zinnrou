import { initializeApp, getApps, getApp } from "firebase/app";
import { 
  getFirestore, 
  collection, 
  doc, 
  setDoc, 
  getDoc, 
  getDocs,
  onSnapshot, 
  serverTimestamp,
  updateDoc,
  deleteDoc,
  getDocFromServer
} from "firebase/firestore";
import firebaseConfig from "../firebase-applet-config.json";

// Initialize Firebase App
export const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

// Initialize Firestore with the provisioned database ID
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);

// Test connection on boot
async function testConnection() {
  try {
    await getDocFromServer(doc(db, "test", "connection"));
  } catch (error) {
    if (error instanceof Error && error.message.includes("the client is offline")) {
      console.warn("[Firebase] Client is offline or check configuration.");
    }
  }
}
testConnection();

// Standard Error Handler
export const OperationType = {
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  LIST: 'list',
  GET: 'get',
  WRITE: 'write',
};

export function handleFirestoreError(error, operationType, path) {
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: null,
      email: null,
      emailVerified: null,
      isAnonymous: true,
      tenantId: null,
      providerInfo: []
    },
    operationType,
    path
  };
  console.warn('Firestore Error: ', JSON.stringify(errInfo));
  return errInfo;
}

// Local In-Memory & Storage Fallback for Instant Zero-Lag Reliability
const localRoomsMemory = new Map();

// Cross-tab broadcast channel for local peer sync
let roomBroadcastChannel = null;
if (typeof window !== "undefined" && window.BroadcastChannel) {
  try {
    roomBroadcastChannel = new BroadcastChannel("jinrou_rooms_channel");
  } catch (e) {
    roomBroadcastChannel = null;
  }
}

// Helper: sync room state to localStorage
export function saveRoomLocally(roomData) {
  if (!roomData || !roomData.code) return;
  localRoomsMemory.set(roomData.code, roomData);
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(`jinrou_room_${roomData.code}`, JSON.stringify(roomData));
    } catch (e) {}
  }
  if (roomBroadcastChannel) {
    try {
      roomBroadcastChannel.postMessage({ type: "ROOM_UPDATED", room: roomData });
    } catch (e) {}
  }
}

// Helper: retrieve room from local cache
export function getRoomLocally(code) {
  if (localRoomsMemory.has(code)) return localRoomsMemory.get(code);
  if (typeof localStorage !== "undefined") {
    try {
      const saved = localStorage.getItem(`jinrou_room_${code}`);
      if (saved) {
        const parsed = JSON.parse(saved);
        localRoomsMemory.set(code, parsed);
        return parsed;
      }
    } catch (e) {}
  }
  return null;
}

// User Profile Helpers
export async function savePlayerProfile(playerId, nickname, vcVolume = 100, coins = 0, unlockedRoles = [], avatarIcon = '') {
  if (!playerId || !nickname) return;
  try {
    const userRef = doc(db, "players", playerId);
    await setDoc(userRef, {
      nickname: nickname.trim(),
      vcVolume: Number(vcVolume) || 100,
      coins: typeof coins === 'number' ? coins : 0,
      unlockedRoles: Array.isArray(unlockedRoles) ? unlockedRoles : [],
      avatarIcon: avatarIcon || '',
      updatedAt: serverTimestamp()
    }, { merge: true });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `players/${playerId}`);
  }
}

export async function fetchPlayerProfile(playerId) {
  if (!playerId) return null;
  try {
    const userRef = doc(db, "players", playerId);
    const snap = await getDoc(userRef);
    if (snap && snap.exists()) {
      return snap.data();
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, `players/${playerId}`);
  }
  return null;
}

// --- Online Werewolf Room Management Helpers ---

export function normalizeRoomData(data, docId, collectionName = 'jinrou_rooms') {
  if (!data) return null;
  const rawCode = data.code ?? data.roomCode ?? data.id ?? docId;
  const code = String(rawCode).replace(/^[#＃\s]/g, '').trim();

  const hostNickname = data.hostNickname || data.hostName || data.host || data.owner || data.creator || 'ホスト';
  const name = (data.name || data.roomName || `${hostNickname}の部屋`).toString().slice(0, 8);
  const hostId = data.hostId || data.ownerId || ('host_' + code);

  const rawStatus = (data.status || 'waiting').toString().toLowerCase();
  let status = 'waiting';
  if (rawStatus === 'in_game' || rawStatus === 'playing' || rawStatus === 'started') {
    status = 'in_game';
  } else if (rawStatus === 'finished' || rawStatus === 'ended' || rawStatus === 'closed') {
    status = 'finished';
  }

  const maxPlayers = Number(data.maxPlayers || data.max || data.capacity) || 5;
  const discussionTime = Number(data.discussionTime || data.time || data.discussion) || 60;
  const roleMode = (data.roleMode || 'normal') === 'original' ? 'original' : 'normal';

  // Normalize players dictionary
  let players = {};
  if (data.players && typeof data.players === 'object') {
    if (Array.isArray(data.players)) {
      data.players.forEach((p, idx) => {
        const pId = (p && p.id) ? String(p.id) : `p_${idx}`;
        players[pId] = (typeof p === 'object' && p !== null) ? {
          id: pId,
          nickname: p.nickname || p.name || `プレイヤー${idx + 1}`,
          isHost: p.isHost ?? (idx === 0),
          isLeader: p.isLeader ?? (idx === 0),
          role: p.role || null,
          isAlive: p.isAlive !== false,
          isOnline: p.isOnline !== false,
          isVcOn: p.isVcOn !== false,
          isMuted: !!p.isMuted,
          isSpeaking: !!p.isSpeaking,
          joinedAt: p.joinedAt || Date.now()
        } : {
          id: pId,
          nickname: String(p),
          isHost: idx === 0,
          isLeader: idx === 0,
          role: null,
          isAlive: true,
          isOnline: true,
          isVcOn: true,
          isMuted: false,
          isSpeaking: false,
          joinedAt: Date.now()
        };
      });
    } else {
      for (const [pId, p] of Object.entries(data.players)) {
        if (p && typeof p === 'object') {
          players[pId] = {
            id: pId,
            nickname: p.nickname || p.name || 'プレイヤー',
            avatarIcon: p.avatarIcon || '',
            isHost: p.isHost ?? (pId === hostId),
            isLeader: p.isLeader ?? (pId === hostId),
            role: p.role || null,
            isAlive: p.isAlive !== false,
            isOnline: p.isOnline !== false,
            isVcOn: p.isVcOn !== false,
            isMuted: !!p.isMuted,
            isSpeaking: !!p.isSpeaking,
            joinedAt: p.joinedAt || Date.now()
          };
        }
      }
    }
  }

  // Ensure host exists in players
  if (Object.keys(players).length === 0) {
    players[hostId] = {
      id: hostId,
      nickname: hostNickname,
      isHost: true,
      isLeader: true,
      role: null,
      isAlive: true,
      isOnline: true,
      isVcOn: true,
      isMuted: false,
      isSpeaking: false,
      joinedAt: Date.now()
    };
  }

  const members = Object.values(players).map(p => ({
    id: p.id,
    nickname: p.nickname,
    isHost: !!p.isHost,
    isOnline: p.isOnline !== false
  }));

  const playerCount = Object.keys(players).length;

  return {
    ...data,
    code,
    name,
    docId: docId || code,
    collectionName,
    hostId,
    hostNickname,
    status,
    maxPlayers,
    discussionTime,
    roleMode,
    rolesConfig: data.rolesConfig || {},
    rolesList: data.rolesList || [],
    players,
    members,
    playerCount
  };
}

export async function findFirestoreRoom(roomCode) {
  const cleanCode = (roomCode || '').toString().replace(/^[#＃\s]/g, '').trim();
  if (!cleanCode) return null;

  const targetCollections = ['jinrou_rooms', 'rooms'];

  // 1. Direct doc lookup by ID in both collections
  for (const col of targetCollections) {
    try {
      const snap = await getDoc(doc(db, col, cleanCode));
      if (snap && snap.exists()) {
        const norm = normalizeRoomData(snap.data(), snap.id, col);
        if (norm) return norm;
      }
    } catch (e) {
      console.warn(`[findFirestoreRoom] getDoc ${col}/${cleanCode}:`, e.message);
    }
  }

  // 2. Scan documents in both collections (handles any custom doc ID or fields created via Firebase Console)
  for (const col of targetCollections) {
    try {
      const snap = await getDocs(collection(db, col));
      for (const d of snap.docs) {
        const norm = normalizeRoomData(d.data(), d.id, col);
        if (norm && (norm.code === cleanCode || d.id === cleanCode || d.id === `#${cleanCode}`)) {
          return norm;
        }
      }
    } catch (e) {
      console.warn(`[findFirestoreRoom] scan ${col}:`, e.message);
    }
  }

  // 3. Fallback: check Express Server API
  try {
    const res = await fetch(`/api/jinrou/rooms/${cleanCode}`);
    if (res.ok) {
      const srvData = await res.json();
      return normalizeRoomData(srvData, cleanCode, 'server');
    }
  } catch (e) {}

  // 4. Fallback: check local memory
  const localData = getRoomLocally(cleanCode);
  if (localData) {
    return normalizeRoomData(localData, cleanCode, 'local');
  }

  return null;
}

export async function createFirestoreRoom(roomCode, hostId, hostNickname, settings = {}) {
  const cleanCode = (roomCode || '').toString().replace(/^[#＃\s]/g, '').trim();
  const roomName = (settings.name || settings.roomName || `${hostNickname}の部屋`).toString().slice(0, 8);
  const maxPlayers = Number(settings.maxPlayers) || 5;
  const roleMode = settings.roleMode || 'normal';
  const rolesConfig = settings.rolesConfig || {};
  const rolesList = settings.rolesList || [];
  const discussionTime = Number(settings.discussionTime) || 60;

  const now = Date.now();
  const hostPlayer = {
    id: hostId,
    nickname: hostNickname,
    avatarIcon: settings.avatarIcon || '',
    isHost: true,
    isLeader: true,
    role: null,
    isAlive: true,
    isOnline: true,
    isVcOn: true,
    isMuted: false,
    isSpeaking: false,
    joinedAt: now,
    lastActive: now
  };

  const roomData = {
    code: cleanCode,
    name: roomName,
    hostId,
    hostNickname,
    maxPlayers,
    discussionTime,
    roleMode,
    rolesConfig,
    rolesList,
    status: "waiting", // waiting | in_game | finished
    phase: "day", // day | vote | night
    dayCount: 1,
    createdAt: now,
    updatedAt: now,
    players: {
      [hostId]: hostPlayer
    },
    members: [
      { id: hostId, nickname: hostNickname, isHost: true, isOnline: true }
    ],
    playerCount: 1
  };

  // 1. Immediately store in local memory & storage so UI is instantaneous
  saveRoomLocally(roomData);

  // 2. Synchronously notify Express server API
  try {
    fetch('/api/jinrou/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(roomData)
    }).catch(e => console.warn("[Server Sync] Notice on room create:", e.message));
  } catch (e) {}

  // 3. Save to Firebase Firestore (write to both jinrou_rooms and rooms for total console compatibility)
  const targetCollections = ['jinrou_rooms', 'rooms'];
  for (const col of targetCollections) {
    try {
      const roomRef = doc(db, col, cleanCode);
      await setDoc(roomRef, {
        ...roomData,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      console.log(`[Firebase] Room created successfully in Firestore: ${col}/${cleanCode}`);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `${col}/${cleanCode}`);
    }
  }

  return roomData;
}

export async function joinFirestoreRoom(roomCode, playerId, playerNickname, isVcOn = true, avatarIcon = '') {
  const cleanCode = (roomCode || '').toString().replace(/^[#＃\s]/g, '').trim();
  const roomData = await findFirestoreRoom(cleanCode);

  if (!roomData) {
    throw new Error(`部屋（#${cleanCode}）が見つかりませんでした。コードをご確認いただくか、新しく部屋を作成してください。`);
  }

  if (roomData.status !== "waiting") {
    throw new Error("この部屋は既にゲームが開始されているか、終了しています。");
  }

  const currentPlayers = roomData.players || {};
  const playerEntries = Object.keys(currentPlayers);
  const maxAllowed = roomData.maxPlayers || 12;
  if (playerEntries.length >= maxAllowed && !currentPlayers[playerId]) {
    throw new Error(`部屋が満員です（定員: ${maxAllowed}人）`);
  }

  const now = Date.now();
  const isHost = (roomData.hostId === playerId);

  const updatedPlayers = {
    ...currentPlayers,
    [playerId]: {
      id: playerId,
      nickname: playerNickname,
      avatarIcon: avatarIcon || currentPlayers[playerId]?.avatarIcon || '',
      isHost,
      isLeader: isHost,
      role: null,
      isAlive: true,
      isOnline: true,
      isVcOn: isVcOn !== false,
      isMuted: false,
      isSpeaking: false,
      joinedAt: currentPlayers[playerId]?.joinedAt || now,
      lastActive: now
    }
  };

  const updatedMembers = Object.values(updatedPlayers).map(p => ({
    id: p.id,
    nickname: p.nickname,
    isHost: !!p.isHost,
    isOnline: p.isOnline !== false
  }));

  const updatedRoom = {
    ...roomData,
    code: cleanCode,
    players: updatedPlayers,
    members: updatedMembers,
    playerCount: Object.keys(updatedPlayers).length,
    updatedAt: now
  };

  // Save locally
  saveRoomLocally(updatedRoom);

  // Sync to Express Server API
  try {
    fetch(`/api/jinrou/rooms/${cleanCode}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId, playerNickname, isVcOn, roomData: updatedRoom })
    }).catch(() => {});
  } catch (e) {}

  // Sync to Firebase Firestore (write to both jinrou_rooms and rooms if present)
  const targetCollections = ['jinrou_rooms', 'rooms'];
  for (const col of targetCollections) {
    try {
      const docId = (roomData.collectionName === col && roomData.docId) ? roomData.docId : cleanCode;
      const roomRef = doc(db, col, docId);
      await setDoc(roomRef, {
        players: updatedPlayers,
        members: updatedMembers,
        playerCount: Object.keys(updatedPlayers).length,
        updatedAt: serverTimestamp()
      }, { merge: true });
      console.log(`[Firebase] Player joined room in Firestore: ${col}/${docId}`);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `${col}/${cleanCode}`);
    }
  }

  return updatedRoom;
}

export async function fetchActiveFirestoreRooms() {
  const roomsMap = new Map();
  const targetCollections = ['jinrou_rooms', 'rooms'];

  for (const col of targetCollections) {
    try {
      const snapshot = await getDocs(collection(db, col));
      snapshot.forEach((docSnap) => {
        const norm = normalizeRoomData(docSnap.data(), docSnap.id, col);
        if (norm && norm.code && norm.status !== 'finished') {
          if (!roomsMap.has(norm.code) || roomsMap.get(norm.code).playerCount < norm.playerCount) {
            roomsMap.set(norm.code, {
              code: norm.code,
              name: norm.name || `${norm.hostNickname || 'ホスト'}の部屋`,
              docId: norm.docId,
              collectionName: norm.collectionName,
              hostNickname: norm.hostNickname || 'ホスト',
              playerCount: norm.playerCount,
              maxPlayers: norm.maxPlayers || 5,
              roleMode: norm.roleMode || 'normal',
              discussionTime: norm.discussionTime || 60,
              status: norm.status || 'waiting'
            });
          }
        }
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.LIST, col);
    }
  }

  return Array.from(roomsMap.values());
}

// Real-Time subscription for all active rooms in Firestore (listens to both jinrou_rooms and rooms)
export function subscribeToActiveRooms(onUpdate, onError) {
  let isUnsubscribed = false;
  const colRoomsMap = new Map(); // col => Map of code => roomSummary

  function emitCombined() {
    if (isUnsubscribed) return;
    const combined = new Map();
    for (const [, roomMap] of colRoomsMap.entries()) {
      for (const [code, item] of roomMap.entries()) {
        if (!combined.has(code) || combined.get(code).playerCount < item.playerCount) {
          combined.set(code, item);
        }
      }
    }
    onUpdate(Array.from(combined.values()));
  }

  const unsubs = [];
  const targetCollections = ['jinrou_rooms', 'rooms'];

  targetCollections.forEach((col) => {
    try {
      const q = collection(db, col);
      const unsub = onSnapshot(q, (snapshot) => {
        const colMap = new Map();
        snapshot.forEach((docSnap) => {
          const norm = normalizeRoomData(docSnap.data(), docSnap.id, col);
          if (norm && norm.code && norm.status !== 'finished') {
            colMap.set(norm.code, {
              code: norm.code,
              name: norm.name || `${norm.hostNickname || 'ホスト'}の部屋`,
              docId: norm.docId,
              collectionName: norm.collectionName,
              hostNickname: norm.hostNickname || 'ホスト',
              playerCount: norm.playerCount,
              maxPlayers: norm.maxPlayers || 5,
              roleMode: norm.roleMode || 'normal',
              discussionTime: norm.discussionTime || 60,
              status: norm.status || 'waiting'
            });
          }
        });
        colRoomsMap.set(col, colMap);
        emitCombined();
      }, (err) => {
        handleFirestoreError(err, OperationType.LIST, col);
        if (typeof onError === 'function') onError(err);
      });
      unsubs.push(unsub);
    } catch (err) {
      handleFirestoreError(err, OperationType.LIST, col);
    }
  });

  return () => {
    isUnsubscribed = true;
    unsubs.forEach((fn) => {
      try { fn(); } catch (e) {}
    });
  };
}

// Real-Time presence heartbeat for a player in a room
export async function updatePlayerHeartbeat(roomCode, playerId) {
  if (!roomCode || !playerId) return;
  const cleanCode = (roomCode || '').toString().replace(/^[#＃]/, '').trim();
  try {
    const roomRef = doc(db, "jinrou_rooms", cleanCode);
    await updateDoc(roomRef, {
      [`players.${playerId}.lastActive`]: Date.now(),
      [`players.${playerId}.isOnline`]: true,
      updatedAt: serverTimestamp()
    });
  } catch (e) {
    // Non-critical, ignore silent failures
  }
}

export function subscribeToRoom(roomCode, onUpdate, onError) {
  const cleanCode = (roomCode || '').toString().replace(/^[#＃\s]/g, '').trim();
  let isUnsubscribed = false;

  // 1. Initial fire from local cache
  const initialLocal = getRoomLocally(cleanCode);
  if (initialLocal) {
    onUpdate(initialLocal);
  }

  // 2. Listen to cross-tab BroadcastChannel
  const handleBroadcast = (evt) => {
    if (isUnsubscribed) return;
    if (evt.data && evt.data.type === "ROOM_UPDATED" && evt.data.room && evt.data.room.code === cleanCode) {
      onUpdate(evt.data.room);
    }
  };

  if (roomBroadcastChannel) {
    roomBroadcastChannel.addEventListener("message", handleBroadcast);
  }

  // 3. Periodic poll from Express server API as backup
  const pollTimer = setInterval(async () => {
    if (isUnsubscribed) return;
    try {
      const res = await fetch(`/api/jinrou/rooms/${cleanCode}`);
      if (res.ok) {
        const data = await res.json();
        const norm = normalizeRoomData(data, cleanCode, 'server');
        saveRoomLocally(norm);
        onUpdate(norm);
      }
    } catch (e) {}
  }, 2500);

  // 4. Firestore onSnapshot real-time subscription on both collections
  const unsubs = [];
  ['jinrou_rooms', 'rooms'].forEach(col => {
    try {
      const roomRef = doc(db, col, cleanCode);
      const unsub = onSnapshot(roomRef, (docSnap) => {
        if (isUnsubscribed) return;
        if (docSnap.exists()) {
          const norm = normalizeRoomData(docSnap.data(), docSnap.id, col);
          saveRoomLocally(norm);
          onUpdate(norm);
        }
      }, (error) => {
        handleFirestoreError(error, OperationType.GET, `${col}/${cleanCode}`);
      });
      unsubs.push(unsub);
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, `${col}/${cleanCode}`);
    }
  });

  return () => {
    isUnsubscribed = true;
    clearInterval(pollTimer);
    if (roomBroadcastChannel) {
      roomBroadcastChannel.removeEventListener("message", handleBroadcast);
    }
    unsubs.forEach(fn => {
      try { fn(); } catch (e) {}
    });
  };
}

export async function leaveFirestoreRoom(roomCode, playerId) {
  const cleanCode = (roomCode || '').toString().replace(/^[#＃\s]/g, '').trim();
  const room = getRoomLocally(cleanCode);
  const isHostLeavingLobby = room && room.hostId === playerId && (room.status === 'waiting' || !room.status);

  if (room && room.players) {
    delete room.players[playerId];
    const realRemaining = Object.keys(room.players).filter(id => !id.startsWith('dummy_'));
    if (realRemaining.length === 0 || isHostLeavingLobby) {
      localRoomsMemory.delete(cleanCode);
      if (typeof localStorage !== "undefined") {
        localStorage.removeItem(`jinrou_room_${cleanCode}`);
      }
      if (roomBroadcastChannel) {
        try { roomBroadcastChannel.postMessage({ type: "ROOM_DELETED", roomCode: cleanCode }); } catch (e) {}
      }
    } else {
      if (room.hostId === playerId) {
        const remaining = Object.keys(room.players);
        room.hostId = remaining[0];
        if (room.players[remaining[0]]) {
          room.players[remaining[0]].isHost = true;
          room.players[remaining[0]].isLeader = true;
        }
      }
      saveRoomLocally(room);
    }
  }

  // Call Express API with keepalive
  try {
    fetch(`/api/jinrou/rooms/${cleanCode}/leave`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId, isHost: isHostLeavingLobby }),
      keepalive: true
    }).catch(() => {});
  } catch (e) {}

  // Update in Firestore across both collections
  const targetCollections = ['jinrou_rooms', 'rooms'];
  for (const col of targetCollections) {
    try {
      const roomRef = doc(db, col, cleanCode);
      const snap = await getDoc(roomRef);
      if (snap && snap.exists()) {
        const data = snap.data();
        const players = { ...(data.players || {}) };
        delete players[playerId];
        const remainingIds = Object.keys(players);
        const realRemainingIds = remainingIds.filter(id => !id.startsWith('dummy_'));
        const shouldDelete = (remainingIds.length === 0) || (realRemainingIds.length === 0) || (data.hostId === playerId && (data.status === 'waiting' || !data.status));
        if (shouldDelete) {
          await deleteDoc(roomRef);
        } else {
          let hostId = data.hostId;
          if (hostId === playerId) {
            hostId = remainingIds[0];
            players[hostId].isHost = true;
            players[hostId].isLeader = true;
          }
          const updatedMembers = remainingIds.map(id => ({
            id,
            nickname: players[id].nickname,
            isHost: (id === hostId),
            isOnline: players[id].isOnline !== false
          }));
          await updateDoc(roomRef, {
            hostId,
            players,
            members: updatedMembers,
            playerCount: remainingIds.length,
            updatedAt: serverTimestamp()
          });
        }
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `${col}/${cleanCode}`);
    }
  }
}
