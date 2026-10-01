import { WerewolfAudio } from './audio.js';
import { VoiceManager } from './voice.js';
import { 
  savePlayerProfile, 
  fetchPlayerProfile, 
  createFirestoreRoom, 
  joinFirestoreRoom, 
  leaveFirestoreRoom,
  subscribeToRoom,
  fetchActiveFirestoreRooms,
  subscribeToActiveRooms,
  updatePlayerHeartbeat
} from './firebase.js';

// --- State Variables ---
const sound = new WerewolfAudio();

// Use sessionStorage so each tab/window in the same browser has its own independent player ID,
// enabling multiple players on the same machine/browser without ID conflicts!
let localPlayerId = sessionStorage.getItem('jinrou_player_id');
if (!localPlayerId) {
  localPlayerId = 'usr_' + Math.random().toString(36).substring(2, 9) + Date.now().toString(36).substring(4);
  sessionStorage.setItem('jinrou_player_id', localPlayerId);
}
// Keep localStorage player ID synced as fallback
localStorage.setItem('jinrou_player_id', localPlayerId);

let localNickname = sessionStorage.getItem('jinrou_nickname') || localStorage.getItem('jinrou_nickname') || '';
let localAvatarIcon = sessionStorage.getItem('jinrou_avatar_icon') || localStorage.getItem('jinrou_avatar_icon') || '';

// Display format requirement: アイコン(名前)
export function formatPlayerDisplayName(nickname) {
  const name = (nickname || 'プレイヤー').trim();
  return `アイコン(${name})`;
}

export function generateDefaultAvatar(name) {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    const colors = ['#e11d48', '#2563eb', '#059669', '#d97706', '#7c3aed', '#0284c7'];
    let hash = 0;
    const str = (name || '人').trim();
    for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
    const color = colors[Math.abs(hash) % colors.length];

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(32, 32, 31, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 28px "Noto Sans JP", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(str.charAt(0) || '人', 32, 34);
    return canvas.toDataURL('image/png');
  } catch (e) {
    return 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><circle cx="20" cy="20" r="20" fill="%232563eb"/><text x="20" y="26" font-size="18" text-anchor="middle" fill="white" font-weight="bold">人</text></svg>';
  }
}

if (!localAvatarIcon && localNickname) {
  localAvatarIcon = generateDefaultAvatar(localNickname);
}
let vcVolume = parseInt(localStorage.getItem('jinrou_vc_volume'), 10);
if (isNaN(vcVolume) || vcVolume < 50 || vcVolume > 500) {
  vcVolume = 100;
}
sound.setVcVolume(vcVolume);

// Coin System (Initial 0, test add coins removed)
let userCoins = parseInt(localStorage.getItem('jinrou_coins'), 10);
if (isNaN(userCoins) || userCoins < 0 || userCoins === 500) {
  userCoins = 0;
  localStorage.setItem('jinrou_coins', '0');
}

// Unlocked Roles System
let unlockedRoles = [];
try {
  const saved = localStorage.getItem('jinrou_unlocked_roles');
  unlockedRoles = saved ? JSON.parse(saved) : [];
} catch (e) {
  unlockedRoles = [];
}

// Cross-tab broadcast channel for local peer instant sync
let roomBroadcastChannel = null;
if (typeof window !== "undefined" && window.BroadcastChannel) {
  try {
    roomBroadcastChannel = new BroadcastChannel("jinrou_rooms_channel");
  } catch (e) {
    roomBroadcastChannel = null;
  }
}
const displayedChatMsgIds = new Set();

// Active Room & Game State
let activeRoomCode = null;
let isHost = false;
let currentRoomData = null;
let mySecretRole = null;

// Room Creation Settings
let createRoomPlayerCount = 5;
let createRoomDiscussionTime = 60; // 10s to 90s, default 60s (1 min)
let createRoomMode = 'normal'; // 'normal' | 'original'
let originalRolesConfig = {
  werewolf: 1,
  traitor: 1,
  villager: 1,
  seer: 1,
  hunter_guard: 1,
  medium: 0,
  mayor: 0,
  medic: 0,
  hunter_avenger: 0,
  archer: 0
};

// --- Roles Definitions ---
const BASE_ROLES = [
  {
    id: 'werewolf',
    name: '人狼',
    icon: '🐺',
    camp: 'werewolf',
    campName: '人狼チーム',
    desc: '人狼チーム。夜の間に村人チームを襲撃して殺害できる。自分が追放されたら負け。',
    winCondition: '市民チームの生存者を2人以下に追い込む'
  },
  {
    id: 'villager',
    name: '村人',
    icon: '🧑‍🌾',
    camp: 'villager',
    campName: '村人チーム',
    desc: '村人チーム。特殊能力はありませんが、昼の議論と投票で人狼を見つけ出し追放を目指します。',
    winCondition: 'すべての人狼を追放する'
  },
  {
    id: 'medium',
    name: '霊媒師',
    icon: '🕯️',
    camp: 'villager',
    campName: '村人チーム',
    desc: '村人チーム。追放された人の役職が夜のターンにわかる。',
    winCondition: 'すべての人狼を追放する'
  },
  {
    id: 'seer',
    name: '占い師',
    icon: '🔮',
    camp: 'villager',
    campName: '村人チーム',
    desc: '村人チーム。夜の時に誰か1人が人狼か村人陣営かを占える。',
    winCondition: 'すべての人狼を追放する'
  },
  {
    id: 'hunter_guard',
    name: '狩人',
    icon: '🛡️',
    camp: 'villager',
    campName: '村人チーム',
    desc: '村人チーム。人狼が動く前に誰か1人を守ることができる。',
    winCondition: 'すべての人狼を追放する'
  },
  {
    id: 'traitor',
    name: '裏切り者',
    icon: '🎭',
    camp: 'werewolf',
    campName: '人狼チーム',
    desc: '人狼チーム。人狼が誰かは分かりませんが、人狼チームの勝利を目指して村を混乱させます。',
    winCondition: '人狼チームが勝利する'
  }
];

const SHOP_ROLES = [
  {
    id: 'mayor',
    name: '村長',
    icon: '🎖️',
    cost: 100,
    camp: 'villager',
    campName: '村人チーム',
    desc: '死亡時に裏切り者が誰かが暴かれます。村の指導者。',
    winCondition: 'すべての人狼を追放する'
  },
  {
    id: 'medic',
    name: 'メディ',
    icon: '💉',
    cost: 300,
    camp: 'villager',
    campName: '村人チーム',
    desc: '2日目以降の夜のターンに一度だけ味方を一人復活できる。',
    winCondition: 'すべての人狼を追放する'
  },
  {
    id: 'hunter_avenger',
    name: 'ハンター',
    icon: '🎯',
    cost: 100,
    camp: 'villager',
    campName: '村人チーム',
    desc: '自分が死亡した時に誰か一人を道連れにして死亡させることができる。',
    winCondition: 'すべての人狼を追放する'
  },
  {
    id: 'archer',
    name: 'アーチャー',
    icon: '🏹',
    cost: 200,
    camp: 'villager',
    campName: '村人チーム',
    desc: '夜のターンに一度だけ誰かを狙撃（殺害）できる。',
    winCondition: 'すべての人狼を追放する'
  }
];

const ALL_ROLES_MAP = {};
BASE_ROLES.forEach(r => { ALL_ROLES_MAP[r.id] = r; });
SHOP_ROLES.forEach(r => { ALL_ROLES_MAP[r.id] = r; });

const WEREWOLF_TEAM_ROLE_IDS = ['werewolf', 'traitor'];

// Normal preset generation
function getNormalRolesConfig(count) {
  const c = Math.max(3, Math.min(12, count));
  if (c === 3) return { werewolf: 1, seer: 1, villager: 1 };
  if (c === 4) return { werewolf: 1, seer: 1, hunter_guard: 1, villager: 1 };
  if (c === 5) return { werewolf: 1, traitor: 1, seer: 1, hunter_guard: 1, villager: 1 };
  if (c === 6) return { werewolf: 2, seer: 1, hunter_guard: 1, medium: 1, villager: 1 };
  if (c === 7) return { werewolf: 2, traitor: 1, seer: 1, hunter_guard: 1, medium: 1, villager: 1 };
  if (c === 8) return { werewolf: 2, traitor: 1, seer: 1, hunter_guard: 1, medium: 1, villager: 2 };
  if (c === 9) return { werewolf: 2, traitor: 1, seer: 1, hunter_guard: 1, medium: 1, mayor: 1, villager: 2 };
  if (c === 10) return { werewolf: 3, traitor: 1, seer: 1, hunter_guard: 1, medium: 1, hunter_avenger: 1, villager: 2 };
  if (c === 11) return { werewolf: 3, traitor: 1, seer: 1, hunter_guard: 1, medium: 1, medic: 1, villager: 3 };
  return { werewolf: 3, traitor: 1, seer: 1, hunter_guard: 1, medium: 1, archer: 1, medic: 1, villager: 3 };
}

function expandRolesList(config) {
  const list = [];
  for (const [rId, cnt] of Object.entries(config)) {
    for (let i = 0; i < cnt; i++) list.push(rId);
  }
  return list;
}

// --- DOM References ---
const topNicknameChip = document.getElementById('topNicknameChip');
const topNicknameText = document.getElementById('topNicknameText');
const topCoinsChip = document.getElementById('topCoinsChip');
const topCoinsDisplay = document.getElementById('topCoinsDisplay');
const btnOpenSettings = document.getElementById('btnOpenSettings');

// Modals
const initialNicknameModal = document.getElementById('initialNicknameModal');
const initialNicknameInput = document.getElementById('initialNicknameInput');
const initialCharCounter = document.getElementById('initialCharCounter');
const initialErrorMsg = document.getElementById('initialErrorMsg');
const btnConfirmInitialNickname = document.getElementById('btnConfirmInitialNickname');

const settingsModal = document.getElementById('settingsModal');
const btnCloseSettings = document.getElementById('btnCloseSettings');
const btnFinishSettings = document.getElementById('btnFinishSettings');
const settingsNicknameInput = document.getElementById('settingsNicknameInput');
const settingsCharCounter = document.getElementById('settingsCharCounter');
const settingsErrorMsg = document.getElementById('settingsErrorMsg');
const btnSaveNickname = document.getElementById('btnSaveNickname');
const vcVolumeSlider = document.getElementById('vcVolumeSlider');
const vcVolumeDisplay = document.getElementById('vcVolumeDisplay');
const btnTestVolume = document.getElementById('btnTestVolume');
const presetPills = document.querySelectorAll('.preset-pill[data-preset]');

const btnSettingsVcOn = document.getElementById('btnSettingsVcOn');
const btnSettingsVcOff = document.getElementById('btnSettingsVcOff');
const btnSettingsMicOn = document.getElementById('btnSettingsMicOn');
const btnSettingsMicOff = document.getElementById('btnSettingsMicOff');

// Avatar & Drawing Canvas Elements
const topAvatarImg = document.getElementById('topAvatarImg');
const settingsAvatarPreview = document.getElementById('settingsAvatarPreview');
const settingsAvatarDisplayLabel = document.getElementById('settingsAvatarDisplayLabel');
const avatarCanvas = document.getElementById('avatarCanvas');
const btnToolPencil = document.getElementById('btnToolPencil');
const btnToolLine = document.getElementById('btnToolLine');
const btnToolCircle = document.getElementById('btnToolCircle');
const btnToolFill = document.getElementById('btnToolFill');
const btnToolEraser = document.getElementById('btnToolEraser');
const avatarColorPicker = document.getElementById('avatarColorPicker');
const canvasColorPalette = document.getElementById('canvasColorPalette');
const canvasSizeGroup = document.getElementById('canvasSizeGroup');
const btnAvatarUndo = document.getElementById('btnAvatarUndo');
const btnAvatarClear = document.getElementById('btnAvatarClear');
const btnAvatarSampleWolf = document.getElementById('btnAvatarSampleWolf');
const btnSaveAvatar = document.getElementById('btnSaveAvatar');

// Main Menu Actions
const btnOnlinePlay = document.getElementById('btnOnlinePlay');
const btnRoleGuide = document.getElementById('btnRoleGuide');
const btnOpenShop = document.getElementById('btnOpenShop');

// Role Guide & Shop
const roleGuideModal = document.getElementById('roleGuideModal');
const btnCloseRoleGuide = document.getElementById('btnCloseRoleGuide');
const btnFinishRoleGuide = document.getElementById('btnFinishRoleGuide');
const rolesList = document.getElementById('rolesList');
const tabRoleAll = document.getElementById('tabRoleAll');
const tabRoleVillager = document.getElementById('tabRoleVillager');
const tabRoleWerewolf = document.getElementById('tabRoleWerewolf');
const tabRoleShop = document.getElementById('tabRoleShop');

const shopModal = document.getElementById('shopModal');
const btnCloseShop = document.getElementById('btnCloseShop');
const btnFinishShop = document.getElementById('btnFinishShop');
const shopCoinsDisplay = document.getElementById('shopCoinsDisplay');
const shopItemsList = document.getElementById('shopItemsList');

// Online Play Views
const onlinePlayModal = document.getElementById('onlinePlayModal');
const btnCloseOnlinePlay = document.getElementById('btnCloseOnlinePlay');
const onlineHubView = document.getElementById('onlineHubView');
const onlineJoinRoomView = document.getElementById('onlineJoinRoomView');
const onlineCreateRoomView = document.getElementById('onlineCreateRoomView');
const onlineLobbyView = document.getElementById('onlineLobbyView');
const btnCardCreateRoom = document.getElementById('btnCardCreateRoom');
const btnCardShowJoinInput = document.getElementById('btnCardShowJoinInput');
const realtimeRoomsList = document.getElementById('realtimeRoomsList');
const btnRefreshRoomsList = document.getElementById('btnRefreshRoomsList');
const btnBackFromJoinRoom = document.getElementById('btnBackFromJoinRoom');
const roomCodeInput = document.getElementById('roomCodeInput');
const btnJoinRoomSubmit = document.getElementById('btnJoinRoomSubmit');
const joinRoomErrorMsg = document.getElementById('joinRoomErrorMsg');

// GUI Mode Switching Elements
const btnGuiPc = document.getElementById('btnGuiPc');
const btnGuiMobile = document.getElementById('btnGuiMobile');
const btnSettingsGuiPc = document.getElementById('btnSettingsGuiPc');
const btnSettingsGuiMobile = document.getElementById('btnSettingsGuiMobile');

// Join Request Prompt & Waiting Modals
const joinRequestPromptModal = document.getElementById('joinRequestPromptModal');
const promptRequesterNickname = document.getElementById('promptRequesterNickname');
const btnPromptApprove = document.getElementById('btnPromptApprove');
const btnPromptReject = document.getElementById('btnPromptReject');

const joinRequestWaitingModal = document.getElementById('joinRequestWaitingModal');
const joinRequestWaitingDesc = document.getElementById('joinRequestWaitingDesc');
const btnCancelJoinRequest = document.getElementById('btnCancelJoinRequest');

const lobbyPendingRequestsSection = document.getElementById('lobbyPendingRequestsSection');
const lobbyPendingCount = document.getElementById('lobbyPendingCount');
const lobbyPendingRequestsList = document.getElementById('lobbyPendingRequestsList');

let activeRoomsList = [];
let pendingRequestRoomCode = null;
let currentPromptRequest = null;
let roomsPollingInterval = null;

// Create Room Settings
const roomNameInput = document.getElementById('roomNameInput');
const roomNameCharCounter = document.getElementById('roomNameCharCounter');
const roomNameErrorMsg = document.getElementById('roomNameErrorMsg');
const roomPlayerCountSlider = document.getElementById('roomPlayerCountSlider');
const playerCountDisplay = document.getElementById('playerCountDisplay');
const roomDiscussionTimeSlider = document.getElementById('roomDiscussionTimeSlider');
const discussionTimeDisplay = document.getElementById('discussionTimeDisplay');
const btnModeNormal = document.getElementById('btnModeNormal');
const btnModeOriginal = document.getElementById('btnModeOriginal');
const normalModeContainer = document.getElementById('normalModeContainer');
const normalRolesPreviewList = document.getElementById('normalRolesPreviewList');
const originalModeContainer = document.getElementById('originalModeContainer');
const originalRolesSteppersList = document.getElementById('originalRolesSteppersList');
const originalValidationBox = document.getElementById('originalValidationBox');
const originalTotalCountNotice = document.getElementById('originalTotalCountNotice');
const originalRatioNotice = document.getElementById('originalRatioNotice');
const btnConfirmCreateRoom = document.getElementById('btnConfirmCreateRoom');
const btnCancelCreateRoom = document.getElementById('btnCancelCreateRoom');

// Lobby View
const lobbyRoomNameText = document.getElementById('lobbyRoomNameText');
const lobbyRoomCodeText = document.getElementById('lobbyRoomCodeText');
const btnCopyRoomCode = document.getElementById('btnCopyRoomCode');
const lobbyPlayerCount = document.getElementById('lobbyPlayerCount');
const lobbyPlayerMax = document.getElementById('lobbyPlayerMax');
const lobbyPlayerRoster = document.getElementById('lobbyPlayerRoster');
const btnLobbyStartGame = document.getElementById('btnLobbyStartGame');
const btnLeaveRoom = document.getElementById('btnLeaveRoom');
const btnInviteShare = document.getElementById('btnInviteShare');
const lobbyInvitePreviewText = document.getElementById('lobbyInvitePreviewText');
const lobbyMinPlayerWarning = document.getElementById('lobbyMinPlayerWarning');
const lobbyMinPlayerNoticeText = document.getElementById('lobbyMinPlayerNoticeText');

const btnLobbyVcToggle = document.getElementById('btnLobbyVcToggle');
const lobbyVcIcon = document.getElementById('lobbyVcIcon');
const lobbyVcLabel = document.getElementById('lobbyVcLabel');
const btnLobbyMicToggle = document.getElementById('btnLobbyMicToggle');
const lobbyMicIcon = document.getElementById('lobbyMicIcon');
const lobbyMicLabel = document.getElementById('lobbyMicLabel');
const lobbySpeakingRing = document.getElementById('lobbySpeakingRing');
const btnLobbyAddDummy = document.getElementById('btnLobbyAddDummy');

// Dedicated Room Waiting Screen Elements
const mainScreenView = document.getElementById('mainScreenView');
const roomWaitingScreenView = document.getElementById('roomWaitingScreenView');
const waitingRoomNameText = document.getElementById('waitingRoomNameText');
const waitingRoomCodeText = document.getElementById('waitingRoomCodeText');
const btnWaitingCopyCode = document.getElementById('btnWaitingCopyCode');
const waitingPlayerCapChip = document.getElementById('waitingPlayerCapChip');
const waitingTimeChip = document.getElementById('waitingTimeChip');
const waitingModeChip = document.getElementById('waitingModeChip');
const btnWaitingVcToggle = document.getElementById('btnWaitingVcToggle');
const waitingVcIcon = document.getElementById('waitingVcIcon');
const waitingVcLabel = document.getElementById('waitingVcLabel');
const btnWaitingMicToggle = document.getElementById('btnWaitingMicToggle');
const waitingMicIcon = document.getElementById('waitingMicIcon');
const waitingMicLabel = document.getElementById('waitingMicLabel');
const btnWaitingForceVc = document.getElementById('btnWaitingForceVc');
const waitingPlayerCount = document.getElementById('waitingPlayerCount');
const waitingMaxCount = document.getElementById('waitingMaxCount');
const btnWaitingAddDummy = document.getElementById('btnWaitingAddDummy');
const waitingMinPlayerWarning = document.getElementById('waitingMinPlayerWarning');
const waitingMinNotice = document.getElementById('waitingMinNotice');
const waitingPlayerRoster = document.getElementById('waitingPlayerRoster');
const btnWaitingStartGame = document.getElementById('btnWaitingStartGame');
const btnWaitingLeaveRoom = document.getElementById('btnWaitingLeaveRoom');

// Embedded Chat Elements (Waiting Screen & Game Screen)
const waitingChatMessagesBox = document.getElementById('waitingChatMessagesBox');
const waitingChatInput = document.getElementById('waitingChatInput');
const waitingChatCounter = document.getElementById('waitingChatCounter');
const btnWaitingSendChat = document.getElementById('btnWaitingSendChat');
const gameChatMessagesBox = document.getElementById('gameChatMessagesBox');
const gameChatInput = document.getElementById('gameChatInput');
const gameChatCounter = document.getElementById('gameChatCounter');
const btnGameSendChat = document.getElementById('btnGameSendChat');

// Master Screen State Switcher
function switchScreen(state) {
  // state: 'main' | 'waiting' | 'game'
  if (state === 'main') {
    if (mainScreenView) mainScreenView.style.display = 'flex';
    if (roomWaitingScreenView) roomWaitingScreenView.style.display = 'none';
    if (gameView) gameView.style.display = 'none';
    closeModal(onlinePlayModal);
    closeModal(roleAnnouncementModal);
    if (topLeftChatContainer) topLeftChatContainer.style.display = 'none';
  } else if (state === 'waiting') {
    if (mainScreenView) mainScreenView.style.display = 'none';
    if (roomWaitingScreenView) roomWaitingScreenView.style.display = 'flex';
    if (gameView) gameView.style.display = 'none';
    closeModal(onlinePlayModal);
    closeModal(roleAnnouncementModal);
    if (topLeftChatContainer) topLeftChatContainer.style.display = 'block';
  } else if (state === 'game') {
    if (mainScreenView) mainScreenView.style.display = 'none';
    if (roomWaitingScreenView) roomWaitingScreenView.style.display = 'none';
    if (gameView) gameView.style.display = 'flex';
    closeModal(onlinePlayModal);
    if (topLeftChatContainer) topLeftChatContainer.style.display = 'block';
  }
}

// Top-Left Chat
const topLeftChatContainer = document.getElementById('topLeftChatContainer');
const chatModeBadge = document.getElementById('chatModeBadge');
const chatModeText = document.getElementById('chatModeText');
const btnChatToggle = document.getElementById('btnChatToggle');
const chatExpandableArea = document.getElementById('chatExpandableArea');
const chatMessagesBox = document.getElementById('chatMessagesBox');
const chatInput = document.getElementById('chatInput');
const chatCharCounter = document.getElementById('chatCharCounter');
const btnSendChat = document.getElementById('btnSendChat');

// Role Announcement Modal
const roleAnnouncementModal = document.getElementById('roleAnnouncementModal');
const revealRoleIcon = document.getElementById('revealRoleIcon');
const revealRoleName = document.getElementById('revealRoleName');
const revealRoleBadge = document.getElementById('revealRoleBadge');
const revealRoleDesc = document.getElementById('revealRoleDesc');
const revealRoleWinCondition = document.getElementById('revealRoleWinCondition');
const btnConfirmMyRole = document.getElementById('btnConfirmMyRole');

// Game View
const gameView = document.getElementById('gameView');
const gameRoomNameText = document.getElementById('gameRoomNameText');
const gameDayCountText = document.getElementById('gameDayCountText');
const gamePhaseBadge = document.getElementById('gamePhaseBadge');
const gamePhaseIcon = document.getElementById('gamePhaseIcon');
const gamePhaseText = document.getElementById('gamePhaseText');
const gameCutsceneBanner = document.getElementById('gameCutsceneBanner');
const cutsceneTitle = document.getElementById('cutsceneTitle');
const cutsceneBody = document.getElementById('cutsceneBody');
const myRoleCampBadge = document.getElementById('myRoleCampBadge');
const myRoleIcon = document.getElementById('myRoleIcon');
const myRoleName = document.getElementById('myRoleName');
const myRoleDesc = document.getElementById('myRoleDesc');
const gameActionPrompt = document.getElementById('gameActionPrompt');
const gamePlayersGrid = document.getElementById('gamePlayersGrid');
const btnHostNextPhase = document.getElementById('btnHostNextPhase');
const btnReturnToLobby = document.getElementById('btnReturnToLobby');
const btnGameVcToggle = document.getElementById('btnGameVcToggle');
const btnGameMicToggle = document.getElementById('btnGameMicToggle');
const gameVcLabel = document.getElementById('gameVcLabel');
const gameMicLabel = document.getElementById('gameMicLabel');

const globalToast = document.getElementById('globalToast');

// Force VC & Device Settings Elements
const forceVcModal = document.getElementById('forceVcModal');
const btnCloseForceVc = document.getElementById('btnCloseForceVc');
const forceVcPermBadge = document.getElementById('forceVcPermBadge');
const forceVcInputSelect = document.getElementById('forceVcInputSelect');
const forceVcOutputSelect = document.getElementById('forceVcOutputSelect');
const btnForceVcTestSpeaker = document.getElementById('btnForceVcTestSpeaker');
const forceVcMeterBar = document.getElementById('forceVcMeterBar');
const forceVcMeterVal = document.getElementById('forceVcMeterVal');
const forceVcMeterNotice = document.getElementById('forceVcMeterNotice');
const btnExecuteForceVc = document.getElementById('btnExecuteForceVc');
const btnSettingsForceVc = document.getElementById('btnSettingsForceVc');
const btnLobbyForceVc = document.getElementById('btnLobbyForceVc');
const btnGameForceVc = document.getElementById('btnGameForceVc');

// --- Voice Manager (WebRTC) ---
const voiceManager = new VoiceManager({
  onSpeakingChange: (isSpeaking) => {
    updateSpeakingRing(isSpeaking);
    updateSpeakingIndicators(localPlayerId, isSpeaking);
  },
  onPeerVoiceState: (peerId, voiceState) => {
    updateSpeakingIndicators(peerId, voiceState.isSpeaking);
  },
  onRemoteTrack: (peerId, stream) => {},
  onVolumeLevel: (level) => {
    if (forceVcModal && forceVcModal.classList.contains('active')) {
      if (forceVcMeterBar) forceVcMeterBar.style.width = `${level}%`;
      if (forceVcMeterVal) forceVcMeterVal.textContent = `${level}%`;
      if (forceVcMeterNotice) {
        if (level > 18) {
          forceVcMeterNotice.textContent = '🔊 音声を正常に検知しています！';
          forceVcMeterNotice.style.color = 'var(--emerald)';
        } else {
          forceVcMeterNotice.textContent = '※ マイクに向かって話してバーが伸びるか確認してください';
          forceVcMeterNotice.style.color = 'var(--text-muted)';
        }
      }
    }
  },
  onLog: (msg) => showToast(msg)
});
voiceManager.setVolume(vcVolume);

// --- WebSocket Connection ---
let socket = null;

function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;
  try {
    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      console.log('[WS] Connected');
      socket.send(JSON.stringify({ type: 'GET_ACTIVE_ROOMS' }));
      if (activeRoomCode) {
        socket.send(JSON.stringify({
          type: 'JOIN_ROOM',
          payload: {
            code: activeRoomCode,
            playerId: localPlayerId,
            nickname: localNickname,
            avatarIcon: localAvatarIcon || generateDefaultAvatar(localNickname),
            isVcOn: voiceManager.isVcEnabled
          }
        }));
      }
    };

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleSocketMessage(msg);
      } catch (e) {}
    };

    socket.onclose = () => setTimeout(initWebSocket, 2000);

    voiceManager.setSignalSender((signalMsg) => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(signalMsg));
      }
    }, localPlayerId, activeRoomCode);
  } catch (err) {}
}
initWebSocket();

function sendWs(type, payload) {
  const msgStr = JSON.stringify({ type, payload });
  if (socket && socket.readyState === WebSocket.OPEN) {
    try { socket.send(msgStr); } catch (e) {}
    return;
  }
  if (socket && socket.readyState === WebSocket.CONNECTING) {
    socket.addEventListener('open', () => {
      try { socket.send(msgStr); } catch (e) {}
    }, { once: true });
    return;
  }
  initWebSocket();
  if (socket) {
    socket.addEventListener('open', () => {
      try { socket.send(msgStr); } catch (e) {}
    }, { once: true });
  }
}

function handleSocketMessage(msg) {
  const { type, payload } = msg;

  switch (type) {
    case 'ROOM_CREATED':
    case 'ROOM_JOINED':
    case 'ROOM_UPDATE': {
      currentRoomData = payload;
      if (payload && payload.code) {
        activeRoomCode = payload.code;
        isHost = (payload.hostId === localPlayerId);
        if (payload.status === 'in_game' && payload.game) {
          if (!gameView || gameView.style.display !== 'flex') {
            switchScreen('game');
            updateGamePhaseUI(payload);
          }
        } else {
          if (!roomWaitingScreenView || roomWaitingScreenView.style.display !== 'flex') {
            enterLobbyView(payload.code, payload);
          }
        }
      }
      if (payload && Array.isArray(payload.chatHistory)) {
        payload.chatHistory.forEach(m => {
          appendChatMessage(m.senderName, m.text, m.senderId === localPlayerId ? 'me' : 'other', m.id);
        });
      }
      updateLobbyUI(payload);
      break;
    }
    case 'ROOM_CLOSED': {
      showToast(payload.message || 'ホストが退出したため部屋は解散されました');
      activeRoomCode = null;
      isHost = false;
      currentRoomData = null;
      switchScreen('main');
      loadActiveRooms();
      break;
    }
    case 'PEER_JOINED': {
      if (payload.peerId !== localPlayerId) {
        voiceManager.handlePeerJoined(payload.peerId, true);
        appendChatMessage('システム', `「${payload.nickname || 'プレイヤー'}」が入室しました`, 'system');
      }
      break;
    }
    case 'PEER_LEFT': {
      if (payload.peerId !== localPlayerId) {
        voiceManager.handlePeerLeft(payload.peerId);
      }
      break;
    }
    case 'WEBRTC_SIGNAL': {
      voiceManager.handleSignal(payload.senderId, payload.signal);
      break;
    }
    case 'VOICE_STATE_UPDATE': {
      updateSpeakingIndicators(payload.playerId, payload.isSpeaking);
      break;
    }
    case 'CHAT_MESSAGE': {
      const isMe = payload.senderId === localPlayerId;
      appendChatMessage(payload.senderName, payload.text, isMe ? 'me' : 'other', payload.id, payload.senderAvatar);
      if (!isMe) {
        sound.playBellSound ? sound.playBellSound() : sound.playClick();
      }
      break;
    }
    case 'GAME_STARTED': {
      currentRoomData = payload;
      mySecretRole = payload.myRole || 'villager';
      showRoleAnnouncement(mySecretRole, payload);
      break;
    }
    case 'TIMER_TICK': {
      if (currentRoomData && currentRoomData.game) {
        currentRoomData.game.timerSec = payload.timerSec;
        updateTimerBadge(payload.timerSec);
      }
      break;
    }
    case 'PHASE_CHANGED': {
      currentRoomData = payload;
      closeModal(roleAnnouncementModal);
      if (payload && payload.status === 'in_game' && payload.game) {
        if (!gameView || gameView.style.display !== 'flex') {
          switchScreen('game');
        }
      }
      updateGamePhaseUI(payload);
      break;
    }
    case 'SEER_RESULT': {
      sound.playSuccess();
      const verdict = payload.isWerewolf ? '【人狼】🐺' : '【村人陣営】🧑‍🌾';
      showToast(`🔮 占い結果: ${payload.targetNickname} さんは ${verdict} です！`);
      appendChatMessage('占い結果', `${payload.targetNickname}さんは${verdict}でした`, 'system');
      break;
    }
    case 'MEDIUM_RESULT': {
      sound.playSuccess();
      const verdict = payload.isWerewolf ? '【人狼】🐺' : '【村人陣営】🧑‍🌾';
      showToast(`🕯️ 霊媒結果: 追放された ${payload.exiledNickname} さんは ${verdict} でした！`);
      appendChatMessage('霊媒結果', `${payload.exiledNickname}さんは${verdict}でした`, 'system');
      break;
    }
    case 'ACTION_CONFIRMED': {
      sound.playClick();
      showToast('行動を選択しました');
      break;
    }
    case 'ACTIVE_ROOMS_UPDATE': {
      if (Array.isArray(payload.rooms)) {
        mergeActiveRooms(payload.rooms);
      }
      break;
    }
    case 'JOIN_REQUEST_PENDING': {
      pendingRequestRoomCode = payload.roomCode;
      if (joinRequestWaitingDesc) {
        joinRequestWaitingDesc.innerHTML = `ホスト（<strong>${payload.hostNickname || 'ホスト'}</strong>）に部屋「#${payload.roomCode}」への参加申請を送信しました。<br>ホストが許可すると自動で部屋に入室します。`;
      }
      openModal(joinRequestWaitingModal);
      renderRealtimeRoomsList();
      break;
    }
    case 'JOIN_REQUEST_RECEIVED': {
      sound.playClick();
      currentPromptRequest = payload;
      if (promptRequesterNickname) {
        promptRequesterNickname.textContent = payload.requesterNickname || 'プレイヤー';
      }
      openModal(joinRequestPromptModal);
      break;
    }
    case 'JOIN_REQUEST_APPROVED': {
      pendingRequestRoomCode = null;
      if (joinRequestWaitingModal) closeModal(joinRequestWaitingModal);
      sound.playSuccess();
      showToast(`🎉 部屋 #${payload.code} に合流しました！`);
      activeRoomCode = payload.code;
      isHost = (payload.hostId === localPlayerId);
      currentRoomData = payload;
      enterLobbyView(payload.code, payload);
      updateLobbyUI(payload);
      break;
    }
    case 'JOIN_REQUEST_REJECTED': {
      pendingRequestRoomCode = null;
      closeModal(joinRequestWaitingModal);
      sound.playClick();
      showToast(payload.message || '⚠️ ホストによって参加が見送られました');
      renderRealtimeRoomsList();
      break;
    }
    case 'JOIN_REQUEST_ERROR': {
      pendingRequestRoomCode = null;
      closeModal(joinRequestWaitingModal);
      sound.playClick();
      showToast(`⚠️ ${payload.message || '入室エラー'}`);
      renderRealtimeRoomsList();
      break;
    }
    case 'ERROR': {
      showToast(payload.message || 'エラー');
      break;
    }
  }
}

// --- Helper Functions ---
function showToast(msg) {
  if (!globalToast) return;
  globalToast.textContent = msg;
  globalToast.classList.add('show');
  clearTimeout(globalToast._timer);
  globalToast._timer = setTimeout(() => globalToast.classList.remove('show'), 2800);
}

function openModal(modal) { if (modal) modal.classList.add('active'); }
function closeModal(modal) { if (modal) modal.classList.remove('active'); }

function validateNickname(name) {
  const trimmed = (name || '').trim();
  return trimmed.length >= 2 && trimmed.length <= 8;
}

function applyNickname(nick) {
  localNickname = nick.trim();
  localStorage.setItem('jinrou_nickname', localNickname);
  sessionStorage.setItem('jinrou_nickname', localNickname);
  if (topNicknameText) topNicknameText.textContent = formatPlayerDisplayName(localNickname);
  if (settingsAvatarDisplayLabel) settingsAvatarDisplayLabel.textContent = formatPlayerDisplayName(localNickname);
  if (!localAvatarIcon) {
    localAvatarIcon = generateDefaultAvatar(localNickname);
    localStorage.setItem('jinrou_avatar_icon', localAvatarIcon);
  }
  if (topAvatarImg) topAvatarImg.src = localAvatarIcon;
  if (settingsAvatarPreview) settingsAvatarPreview.src = localAvatarIcon;
  scheduleProfileSync();

  if (activeRoomCode) {
    sendWs('UPDATE_PROFILE', {
      playerId: localPlayerId,
      nickname: localNickname,
      avatarIcon: localAvatarIcon,
      roomCode: activeRoomCode
    });
  }
}

function updateCoinsDisplay() {
  topCoinsDisplay.textContent = userCoins;
  shopCoinsDisplay.textContent = userCoins;
  localStorage.setItem('jinrou_coins', userCoins.toString());
}

function updateVcVolumeUI(vol) {
  vcVolume = Math.max(50, Math.min(500, vol));
  localStorage.setItem('jinrou_vc_volume', vcVolume.toString());
  vcVolumeSlider.value = vcVolume;
  vcVolumeDisplay.textContent = vcVolume;
  sound.setVcVolume(vcVolume);
  voiceManager.setVolume(vcVolume);
  presetPills.forEach(pill => {
    pill.classList.toggle('active', parseInt(pill.getAttribute('data-preset'), 10) === vcVolume);
  });
}

function scheduleProfileSync() {
  if (!localPlayerId || !localNickname) return;
  savePlayerProfile(localPlayerId, localNickname, vcVolume, userCoins, unlockedRoles, localAvatarIcon);
}

// Cross-tab message listener for instant local multi-tab sync
if (roomBroadcastChannel) {
  roomBroadcastChannel.addEventListener('message', (evt) => {
    if (evt.data) {
      if (evt.data.type === 'ROOM_CHAT_SYNC' && evt.data.chatMsg) {
        const m = evt.data.chatMsg;
        if (!activeRoomCode || !evt.data.roomCode || activeRoomCode === evt.data.roomCode) {
          if (m.senderId !== localPlayerId) {
            appendChatMessage(m.senderName, m.text, 'other', m.id, m.senderAvatar);
            if (sound.playBellSound) sound.playBellSound(); else sound.playClick();
          }
        }
      } else if (evt.data.type === 'ROOM_DELETED') {
        if (activeRoomCode && activeRoomCode === evt.data.roomCode) {
          showToast('ホストが退出したため部屋が解散されました');
          activeRoomCode = null;
          isHost = false;
          currentRoomData = null;
          switchScreen('main');
          loadActiveRooms();
        }
      }
    }
  });
}

// --- Multi-Surface Real-Time Chat ---
function appendChatMessage(senderName, text, type = 'other', msgId = null, senderAvatar = '') {
  if (msgId && displayedChatMsgIds.has(msgId)) return;
  if (msgId) displayedChatMsgIds.add(msgId);

  const isMe = type === 'me';
  const isSys = type === 'system';
  const targetBoxes = [chatMessagesBox, waitingChatMessagesBox, gameChatMessagesBox];

  const avatarSrc = senderAvatar || (isMe ? localAvatarIcon : '') || generateDefaultAvatar(senderName);

  targetBoxes.forEach((box) => {
    if (!box) return;
    const item = document.createElement('div');
    item.className = 'chat-message-item';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'chat-sender-name' + (isMe ? ' is-me' : isSys ? ' is-system' : '');
    
    if (isSys) {
      nameSpan.textContent = `[システム]:`;
    } else {
      nameSpan.innerHTML = `
        <img class="chat-avatar-img" src="${avatarSrc}" alt="" />
        <span>${formatPlayerDisplayName(senderName)}:</span>
      `;
    }

    const textSpan = document.createElement('span');
    textSpan.className = 'chat-content-text';
    textSpan.textContent = ` ${text}`;

    item.appendChild(nameSpan);
    item.appendChild(textSpan);
    box.appendChild(item);
    box.scrollTop = box.scrollHeight;
  });

  if (chatExpandableArea) chatExpandableArea.style.display = 'block';
  if (btnChatToggle) btnChatToggle.textContent = '▼';
}

function sendCurrentChat(explicitText = null) {
  let val = '';
  if (explicitText !== null && explicitText !== undefined && String(explicitText).trim().length > 0) {
    val = String(explicitText).trim();
  } else {
    const wVal = (waitingChatInput ? waitingChatInput.value : '').trim();
    const gVal = (gameChatInput ? gameChatInput.value : '').trim();
    const cVal = (chatInput ? chatInput.value : '').trim();
    val = wVal || gVal || cVal || '';
  }

  if (!val) return;
  if (val.length > 20) val = val.slice(0, 20); // strict 20 chars

  const msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
  const myName = localNickname || '自分';
  const myAvatar = localAvatarIcon || generateDefaultAvatar(myName);
  const cleanCode = (activeRoomCode || '').toString().replace(/^[#＃\s]/g, '').trim();

  // 1. Instantly display on sender's screen across all active chat boxes!
  appendChatMessage(myName, val, 'me', msgId, myAvatar);
  sound.playClick();

  // 2. BroadcastChannel for instant local peer tab sync
  if (roomBroadcastChannel) {
    try {
      roomBroadcastChannel.postMessage({
        type: 'ROOM_CHAT_SYNC',
        roomCode: cleanCode,
        chatMsg: {
          id: msgId,
          senderId: localPlayerId,
          senderName: myName,
          senderAvatar: myAvatar,
          text: val,
          timestamp: Date.now()
        }
      });
    } catch (e) {}
  }

  // 3. Send over WebSocket if in a room
  if (cleanCode) {
    sendWs('CHAT_MESSAGE', {
      id: msgId,
      roomCode: cleanCode,
      senderId: localPlayerId,
      senderName: myName,
      senderAvatar: myAvatar,
      text: val
    });

    // 4. REST endpoint fallback
    fetch(`/api/jinrou/rooms/${encodeURIComponent(cleanCode)}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: msgId,
        senderId: localPlayerId,
        senderName: myName,
        senderAvatar: myAvatar,
        text: val
      })
    }).catch(() => {});
  }

  // Clear all chat inputs & counters
  if (chatInput) chatInput.value = '';
  if (chatCharCounter) chatCharCounter.textContent = '0/20';
  if (waitingChatInput) waitingChatInput.value = '';
  if (waitingChatCounter) waitingChatCounter.textContent = '0/20';
  if (gameChatInput) gameChatInput.value = '';
  if (gameChatCounter) gameChatCounter.textContent = '0/20';
}

// 1. Top-Left Floating Chat Events
if (chatInput) {
  chatInput.addEventListener('input', (e) => {
    let val = e.target.value;
    if (val.length > 20) { e.target.value = val.slice(0, 20); val = e.target.value; }
    if (chatCharCounter) chatCharCounter.textContent = `${val.length}/20`;
  });
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendCurrentChat(chatInput.value);
  });
}
if (btnSendChat) btnSendChat.addEventListener('click', () => sendCurrentChat(chatInput ? chatInput.value : ''));

// 2. Waiting Screen Embedded Chat Events
if (waitingChatInput) {
  waitingChatInput.addEventListener('input', (e) => {
    let val = e.target.value;
    if (val.length > 20) { e.target.value = val.slice(0, 20); val = e.target.value; }
    if (waitingChatCounter) waitingChatCounter.textContent = `${val.length}/20`;
  });
  waitingChatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendCurrentChat(waitingChatInput.value);
  });
}
if (btnWaitingSendChat) btnWaitingSendChat.addEventListener('click', () => sendCurrentChat(waitingChatInput ? waitingChatInput.value : ''));

// 3. Game Screen Embedded Chat Events
if (gameChatInput) {
  gameChatInput.addEventListener('input', (e) => {
    let val = e.target.value;
    if (val.length > 20) { e.target.value = val.slice(0, 20); val = e.target.value; }
    if (gameChatCounter) gameChatCounter.textContent = `${val.length}/20`;
  });
  gameChatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendCurrentChat(gameChatInput.value);
  });
}
if (btnGameSendChat) btnGameSendChat.addEventListener('click', () => sendCurrentChat(gameChatInput ? gameChatInput.value : ''));

if (btnChatToggle) {
  btnChatToggle.addEventListener('click', () => {
    if (chatExpandableArea.style.display === 'none') {
      chatExpandableArea.style.display = 'block';
      btnChatToggle.textContent = '▼';
    } else {
      chatExpandableArea.style.display = 'none';
      btnChatToggle.textContent = '▲';
    }
  });
}

// --- VC & Mic Control Functions ---
function setVcState(enabled) {
  voiceManager.setVcEnabled(enabled);
  if (enabled) {
    chatModeBadge.className = 'chat-mode-badge vc-on';
    chatModeBadge.innerHTML = '<span>🎙️</span><span>VC: ON (通話可能)</span>';
    lobbyVcIcon.textContent = '🔊';
    lobbyVcLabel.textContent = 'VC: ON';
    btnLobbyVcToggle.classList.add('active');
    btnLobbyVcToggle.classList.remove('muted');
    if (gameVcLabel) gameVcLabel.textContent = '🔊 VC: ON';
  } else {
    chatModeBadge.className = 'chat-mode-badge vc-off';
    chatModeBadge.innerHTML = '<span>💬</span><span>チャットモード (VC: OFF)</span>';
    lobbyVcIcon.textContent = '🔇';
    lobbyVcLabel.textContent = 'VC: OFF';
    btnLobbyVcToggle.classList.remove('active');
    btnLobbyVcToggle.classList.add('muted');
    if (gameVcLabel) gameVcLabel.textContent = '🔇 VC: OFF';
    chatExpandableArea.style.display = 'block';
    btnChatToggle.textContent = '▼';
    chatInput.focus();
  }
  btnSettingsVcOn.style.background = enabled ? 'var(--emerald-light)' : '#f1f5f9';
  btnSettingsVcOff.style.background = !enabled ? 'var(--sky-light)' : '#f1f5f9';
}

function setMicState(muted) {
  voiceManager.setMicMuted(muted);
  if (muted) {
    lobbyMicIcon.textContent = '🔇';
    lobbyMicLabel.textContent = 'マイク: OFF';
    btnLobbyMicToggle.classList.remove('active');
    btnLobbyMicToggle.classList.add('muted');
    if (gameMicLabel) gameMicLabel.textContent = '🔇 マイクOFF';
  } else {
    lobbyMicIcon.textContent = '🎙️';
    lobbyMicLabel.textContent = 'マイク: ON';
    btnLobbyMicToggle.classList.add('active');
    btnLobbyMicToggle.classList.remove('muted');
    if (gameMicLabel) gameMicLabel.textContent = '🎙️ マイクON';
  }
  btnSettingsMicOn.style.background = !muted ? 'var(--emerald-light)' : '#f1f5f9';
  btnSettingsMicOff.style.background = muted ? 'var(--crimson-light)' : '#f1f5f9';
}

btnLobbyVcToggle.addEventListener('click', () => setVcState(!voiceManager.isVcEnabled));
btnLobbyMicToggle.addEventListener('click', () => setMicState(!voiceManager.isMicMuted));
if (btnGameVcToggle) btnGameVcToggle.addEventListener('click', () => setVcState(!voiceManager.isVcEnabled));
if (btnGameMicToggle) btnGameMicToggle.addEventListener('click', () => setMicState(!voiceManager.isMicMuted));

btnSettingsVcOn.addEventListener('click', () => setVcState(true));
btnSettingsVcOff.addEventListener('click', () => setVcState(false));
btnSettingsMicOn.addEventListener('click', () => setMicState(false));
btnSettingsMicOff.addEventListener('click', () => setMicState(true));

function updateSpeakingIndicators(playerId, isSpeaking) {
  if (playerId === localPlayerId && lobbySpeakingRing) {
    lobbySpeakingRing.classList.toggle('speaking', isSpeaking);
  }
  const rosterItem = document.getElementById(`roster_${playerId}`);
  if (rosterItem) {
    const ring = rosterItem.querySelector('.speaking-indicator-ring');
    if (ring) ring.classList.toggle('speaking', isSpeaking);
  }
  const gameCard = document.getElementById(`game_player_${playerId}`);
  if (gameCard) {
    gameCard.classList.toggle('speaking', isSpeaking);
  }
}

// --- Create Room Settings (Fix: Mode switch, Role Preview, Discussion Time 10~90s) ---
function updateCreateRoomUI() {
  playerCountDisplay.textContent = `${createRoomPlayerCount}人`;
  discussionTimeDisplay.textContent = `${createRoomDiscussionTime}秒 (${Math.floor(createRoomDiscussionTime / 60)}分${createRoomDiscussionTime % 60 ? (createRoomDiscussionTime % 60) + '秒' : ''})`;

  if (createRoomMode === 'normal') {
    normalModeContainer.style.display = 'block';
    originalModeContainer.style.display = 'none';
    btnModeNormal.classList.add('active');
    btnModeOriginal.classList.remove('active');

    // Populate normal roles preview
    const preset = getNormalRolesConfig(createRoomPlayerCount);
    normalRolesPreviewList.innerHTML = '';
    for (const [rId, cnt] of Object.entries(preset)) {
      if (cnt > 0 && ALL_ROLES_MAP[rId]) {
        const r = ALL_ROLES_MAP[rId];
        const chip = document.createElement('div');
        chip.className = 'role-preview-chip';
        chip.innerHTML = `<span>${r.icon}</span> <span>${r.name}</span> <strong style="color: var(--crimson);">× ${cnt}</strong>`;
        normalRolesPreviewList.appendChild(chip);
      }
    }
    btnConfirmCreateRoom.disabled = false;
  } else {
    normalModeContainer.style.display = 'none';
    originalModeContainer.style.display = 'block';
    btnModeNormal.classList.remove('active');
    btnModeOriginal.classList.add('active');

    renderOriginalSteppers();
    validateOriginalRoles();
  }
}

function renderOriginalSteppers() {
  originalRolesSteppersList.innerHTML = '';
  const availableRoles = [...BASE_ROLES, ...SHOP_ROLES.filter(r => unlockedRoles.includes(r.id))];

  availableRoles.forEach(r => {
    const count = originalRolesConfig[r.id] || 0;
    const isWolf = WEREWOLF_TEAM_ROLE_IDS.includes(r.id);

    const item = document.createElement('div');
    item.className = 'role-stepper-item';
    item.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px;">
        <span style="font-size: 1.2rem;">${r.icon}</span>
        <span style="font-weight: 800; font-size: 0.9rem;">${r.name}</span>
        <span class="role-badge ${isWolf ? 'werewolf' : 'villager'}" style="font-size: 0.65rem;">
          ${isWolf ? '人狼' : '市民'}
        </span>
      </div>
      <div class="role-stepper-ctrl">
        <button class="btn-stepper btn-minus" data-id="${r.id}">−</button>
        <span class="stepper-count" id="count_${r.id}">${count}</span>
        <button class="btn-stepper btn-plus" data-id="${r.id}">＋</button>
      </div>
    `;

    item.querySelector('.btn-minus').addEventListener('click', () => {
      sound.playClick();
      if ((originalRolesConfig[r.id] || 0) > 0) {
        originalRolesConfig[r.id]--;
        document.getElementById(`count_${r.id}`).textContent = originalRolesConfig[r.id];
        validateOriginalRoles();
      }
    });

    item.querySelector('.btn-plus').addEventListener('click', () => {
      sound.playClick();
      originalRolesConfig[r.id] = (originalRolesConfig[r.id] || 0) + 1;
      document.getElementById(`count_${r.id}`).textContent = originalRolesConfig[r.id];
      validateOriginalRoles();
    });

    originalRolesSteppersList.appendChild(item);
  });
}

function validateOriginalRoles() {
  let total = 0;
  let wolfTeam = 0;
  for (const [rId, c] of Object.entries(originalRolesConfig)) {
    total += c;
    if (WEREWOLF_TEAM_ROLE_IDS.includes(rId)) wolfTeam += c;
  }

  const citizenTeam = total - wolfTeam;
  const ratio = total > 0 ? wolfTeam / total : 0;
  const target = createRoomPlayerCount;

  const isCountValid = total === target;
  const isRatioValid = wolfTeam >= 1 && ratio >= 0.12 && ratio <= 0.4;
  const isValid = isCountValid && isRatioValid;

  originalTotalCountNotice.textContent = `合計役職数: ${total} / ${target}人 ${isCountValid ? '✅' : '⚠️ 定員に合わせてください'}`;

  const wolfPercent = Math.round(ratio * 100);
  const citizenPercent = 100 - wolfPercent;

  if (!isRatioValid) {
    originalRatioNotice.innerHTML = `⚠️ 陣営比率: 人狼陣営 ${wolfTeam}人 : 市民陣営 ${citizenTeam}人 (${wolfPercent}% : ${citizenPercent}%)<br><span style="font-size: 0.72rem; opacity: 0.9;">※ 人狼チームと市民チームの比率が約 <strong>2 : 8</strong> になるようにしてください</span>`;
    originalValidationBox.className = 'ratio-indicator-box invalid';
    btnConfirmCreateRoom.disabled = true;
  } else {
    originalRatioNotice.innerHTML = `✅ 陣営比率: 人狼陣営 ${wolfTeam}人 : 市民陣営 ${citizenTeam}人 (${wolfPercent}% : ${citizenPercent}%) 良好！`;
    originalValidationBox.className = 'ratio-indicator-box valid';
    btnConfirmCreateRoom.disabled = !isCountValid;
  }
}

roomPlayerCountSlider.addEventListener('input', (e) => {
  createRoomPlayerCount = parseInt(e.target.value, 10);
  updateCreateRoomUI();
});

roomDiscussionTimeSlider.addEventListener('input', (e) => {
  createRoomDiscussionTime = parseInt(e.target.value, 10);
  updateCreateRoomUI();
});

btnModeNormal.addEventListener('click', () => {
  sound.playClick();
  createRoomMode = 'normal';
  updateCreateRoomUI();
});

btnModeOriginal.addEventListener('click', () => {
  sound.playClick();
  createRoomMode = 'original';
  const normalPreset = getNormalRolesConfig(createRoomPlayerCount);
  originalRolesConfig = {
    werewolf: normalPreset.werewolf || 1,
    traitor: normalPreset.traitor || 0,
    villager: normalPreset.villager || 0,
    seer: normalPreset.seer || 0,
    hunter_guard: normalPreset.hunter_guard || 0,
    medium: normalPreset.medium || 0,
    mayor: 0,
    medic: 0,
    hunter_avenger: 0,
    archer: 0
  };
  updateCreateRoomUI();
});

// --- Lobby & Waiting Screen View ---
function updateLobbyUI(room) {
  if (!room) return;
  activeRoomCode = room.code;
  if (lobbyRoomCodeText) lobbyRoomCodeText.textContent = `#${room.code}`;
  if (waitingRoomCodeText) waitingRoomCodeText.textContent = `#${room.code}`;
  if (gameRoomCodeText) gameRoomCodeText.textContent = `#${room.code}`;

  const displayName = room.name || `${room.hostNickname || 'ホスト'}の部屋`;
  if (lobbyRoomNameText) lobbyRoomNameText.textContent = displayName;
  if (waitingRoomNameText) waitingRoomNameText.textContent = displayName;
  if (gameRoomNameText) gameRoomNameText.textContent = displayName;

  const players = Object.values(room.players || {});
  const playerCount = players.length;
  const maxPlayers = room.maxPlayers || 5;

  if (lobbyPlayerCount) lobbyPlayerCount.textContent = playerCount;
  if (lobbyPlayerMax) lobbyPlayerMax.textContent = maxPlayers;
  if (waitingPlayerCount) waitingPlayerCount.textContent = playerCount;
  if (waitingMaxCount) waitingMaxCount.textContent = maxPlayers;

  if (waitingPlayerCapChip) waitingPlayerCapChip.textContent = `👥 定員: ${maxPlayers}人 (最低3人)`;
  if (waitingTimeChip) waitingTimeChip.textContent = `⏳ 話し合い: ${room.discussionTime || 60}秒`;
  if (waitingModeChip) waitingModeChip.textContent = (room.roleMode === 'original' ? '🎭 カスタム配役' : '🎭 ノーマル配役');

  const hostNick = room.hostNickname || localNickname;
  if (lobbyInvitePreviewText) {
    lobbyInvitePreviewText.textContent = `https://ikuradou745-oss.github.io/zinnrou/\n${hostNick}が呼んでるよ！参加コードは${room.code}だよ！`;
  }

  // Render modal roster
  if (lobbyPlayerRoster) {
    lobbyPlayerRoster.innerHTML = '';
    players.forEach((p) => {
      const isMe = p.id === localPlayerId;
      const avatarSrc = p.avatarIcon || (isMe ? localAvatarIcon : '') || generateDefaultAvatar(p.nickname);
      const row = document.createElement('div');
      row.className = 'lobby-player-item';
      row.id = `roster_${p.id}`;
      row.innerHTML = `
        <div class="lobby-player-info">
          <span class="speaking-indicator-ring ${p.isSpeaking ? 'speaking' : ''}"></span>
          <img class="roster-avatar-img" src="${avatarSrc}" alt="icon" />
          <span style="font-weight: 800; font-size: 0.95rem;">${formatPlayerDisplayName(p.nickname)}</span>
          ${p.isHost ? '<span style="font-size: 0.7rem; background: var(--crimson-light); color: var(--crimson); font-weight: 800; padding: 2px 6px; border-radius: 4px;">ホスト</span>' : ''}
          ${isMe ? '<span style="font-size: 0.7rem; color: var(--sky); font-weight: 800;">(あなた)</span>' : ''}
        </div>
        <div class="lobby-player-voice-status">
          <span>${!p.isVcOn ? '🔇(VC切)' : p.isMuted ? '🔇(消音)' : '🎙️'}</span>
        </div>
      `;
      lobbyPlayerRoster.appendChild(row);
    });
  }

  // Render dedicated Waiting Screen roster
  if (waitingPlayerRoster) {
    waitingPlayerRoster.innerHTML = '';
    players.forEach((p) => {
      const isMe = p.id === localPlayerId;
      const avatarSrc = p.avatarIcon || (isMe ? localAvatarIcon : '') || generateDefaultAvatar(p.nickname);
      const row = document.createElement('div');
      row.className = 'lobby-player-item';
      row.id = `waiting_roster_${p.id}`;
      row.innerHTML = `
        <div class="lobby-player-info">
          <span class="speaking-indicator-ring ${p.isSpeaking ? 'speaking' : ''}"></span>
          <img class="roster-avatar-img" src="${avatarSrc}" alt="icon" />
          <span style="font-weight: 800; font-size: 0.95rem;">${formatPlayerDisplayName(p.nickname)}</span>
          ${p.isHost ? '<span style="font-size: 0.72rem; background: var(--crimson-light); color: var(--crimson); font-weight: 900; padding: 2px 8px; border-radius: 9999px;">👑 ホスト</span>' : ''}
          ${isMe ? '<span style="font-size: 0.72rem; background: var(--sky-light); color: var(--sky); font-weight: 900; padding: 2px 8px; border-radius: 9999px;">(あなた)</span>' : ''}
        </div>
        <div class="lobby-player-voice-status">
          <span style="font-weight: 700;">${!p.isVcOn ? '🔇(VC切)' : p.isMuted ? '🔇(消音)' : '🎙️ 通話中'}</span>
        </div>
      `;
      waitingPlayerRoster.appendChild(row);
    });
  }

  // Strict Rule: Minimum 3 players required to start!
  const isMeHost = (room.hostId === localPlayerId);

  // Render Host Pending Requests (if any)
  const pendingRequests = room.pendingRequests || [];
  if (isMeHost && pendingRequests.length > 0 && lobbyPendingRequestsSection) {
    lobbyPendingRequestsSection.style.display = 'block';
    if (lobbyPendingCount) lobbyPendingCount.textContent = pendingRequests.length;
    if (lobbyPendingRequestsList) {
      lobbyPendingRequestsList.innerHTML = '';
      pendingRequests.forEach((req) => {
        const item = document.createElement('div');
        item.className = 'pending-request-card';
        item.innerHTML = `
          <div style="display: flex; align-items: center; gap: 6px;">
            <span style="font-size: 1.1rem;">👤</span>
            <div>
              <span class="pending-requester-name">${req.nickname}</span>
              <span style="font-size: 0.72rem; color: var(--text-muted); margin-left: 4px;">が参加を希望</span>
            </div>
          </div>
          <div class="pending-actions">
            <button class="btn-approve-sm" data-req-id="${req.requesterId}">許可</button>
            <button class="btn-reject-sm" data-req-id="${req.requesterId}">拒否</button>
          </div>
        `;
        item.querySelector('.btn-approve-sm').addEventListener('click', () => {
          sound.playClick();
          sendWs('RESPOND_JOIN_REQUEST', {
            roomCode: activeRoomCode,
            requesterId: req.requesterId,
            approved: true
          });
          showToast(`「${req.nickname}」さんの参加を許可しました`);
        });
        item.querySelector('.btn-reject-sm').addEventListener('click', () => {
          sound.playClick();
          sendWs('RESPOND_JOIN_REQUEST', {
            roomCode: activeRoomCode,
            requesterId: req.requesterId,
            approved: false
          });
          showToast(`「${req.nickname}」さんの参加を見送りました`);
        });
        lobbyPendingRequestsList.appendChild(item);
      });
    }
  } else if (lobbyPendingRequestsSection) {
    lobbyPendingRequestsSection.style.display = 'none';
  }

  // Update Start Game button state
  if (isMeHost) {
    if (btnLobbyStartGame) btnLobbyStartGame.style.display = 'block';
    if (btnWaitingStartGame) btnWaitingStartGame.style.display = 'block';

    if (playerCount < 3) {
      if (btnLobbyStartGame) {
        btnLobbyStartGame.disabled = true;
        btnLobbyStartGame.textContent = `最低3人必要 (現在: ${playerCount}/3人)`;
      }
      if (btnWaitingStartGame) {
        btnWaitingStartGame.disabled = true;
        btnWaitingStartGame.textContent = `最低3人必要 (現在: ${playerCount}/3人)`;
      }
      if (lobbyMinPlayerWarning) lobbyMinPlayerWarning.style.display = 'flex';
      if (waitingMinPlayerWarning) waitingMinPlayerWarning.style.display = 'flex';
      const warningText = `ゲームを開始するには最低3人のプレイヤーが必要です（現在: ${playerCount}/3人）。「Bot追加」で練習プレイヤーを追加できます。`;
      if (lobbyMinPlayerNoticeText) lobbyMinPlayerNoticeText.textContent = warningText;
      if (waitingMinNotice) waitingMinNotice.textContent = warningText;
    } else {
      if (btnLobbyStartGame) {
        btnLobbyStartGame.disabled = false;
        btnLobbyStartGame.textContent = `🐺 ゲームを開始する (${playerCount}人)`;
      }
      if (btnWaitingStartGame) {
        btnWaitingStartGame.disabled = false;
        btnWaitingStartGame.textContent = `🐺 ゲームを開始する (${playerCount}人)`;
      }
      if (lobbyMinPlayerWarning) lobbyMinPlayerWarning.style.display = 'none';
      if (waitingMinPlayerWarning) waitingMinPlayerWarning.style.display = 'none';
    }
  } else {
    if (btnLobbyStartGame) btnLobbyStartGame.style.display = 'none';
    if (btnWaitingStartGame) {
      btnWaitingStartGame.style.display = 'block';
      btnWaitingStartGame.disabled = true;
      btnWaitingStartGame.textContent = `ホストがゲームを開始するまで待機中... (${playerCount}人)`;
    }
    const nonHostText = `ホストがゲームを開始するまで待機中... (現在: ${playerCount}/3人 - 最低3人必要)`;
    if (playerCount < 3) {
      if (lobbyMinPlayerWarning) lobbyMinPlayerWarning.style.display = 'flex';
      if (waitingMinPlayerWarning) waitingMinPlayerWarning.style.display = 'flex';
      if (lobbyMinPlayerNoticeText) lobbyMinPlayerNoticeText.textContent = nonHostText;
      if (waitingMinNotice) waitingMinNotice.textContent = nonHostText;
    } else {
      if (lobbyMinPlayerWarning) lobbyMinPlayerWarning.style.display = 'none';
      if (waitingMinPlayerWarning) waitingMinPlayerWarning.style.display = 'none';
    }
  }
}

let lobbyUnsubscribe = null;
let presenceHeartbeatTimer = null;

function startPresenceHeartbeat(roomCode) {
  stopPresenceHeartbeat();
  presenceHeartbeatTimer = setInterval(() => {
    if (activeRoomCode && localPlayerId) {
      updatePlayerHeartbeat(activeRoomCode, localPlayerId);
    }
  }, 10000);
}

function stopPresenceHeartbeat() {
  if (presenceHeartbeatTimer) {
    clearInterval(presenceHeartbeatTimer);
    presenceHeartbeatTimer = null;
  }
}

function enterLobbyView(roomCode, roomData) {
  // Hide pre-room entry UI and show dedicated room waiting UI!
  switchScreen('waiting');

  // Push browser history state so Browser Back button triggers leaving the room
  try {
    if (!history.state || history.state.roomCode !== roomCode) {
      history.pushState({ inRoom: true, roomCode }, '', window.location.pathname + '#room=' + roomCode);
    }
  } catch (e) {}

  voiceManager.setSignalSender((msg) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(msg));
    }
  }, localPlayerId, roomCode);

  if (voiceManager.isVcEnabled) {
    voiceManager.initLocalAudio();
  }

  // Connect to peers already present in room
  if (roomData && roomData.players) {
    const pIds = Object.keys(roomData.players);
    for (const pId of pIds) {
      if (pId !== localPlayerId) {
        voiceManager.handlePeerJoined(pId, false);
      }
    }
  }

  updateLobbyUI(roomData);
  startPresenceHeartbeat(roomCode);

  // Setup backup sync listener to ensure state stays 100% in sync
  if (lobbyUnsubscribe) {
    try { lobbyUnsubscribe(); } catch (e) {}
    lobbyUnsubscribe = null;
  }
  lobbyUnsubscribe = subscribeToRoom(roomCode, (updatedRoom) => {
    if (updatedRoom && activeRoomCode === roomCode) {
      currentRoomData = updatedRoom;
      updateLobbyUI(updatedRoom);

      // 1. チャット同期 (Firestore冗長化: 相手の送信メッセージも漏れなく受信)
      if (Array.isArray(updatedRoom.chatHistory)) {
        updatedRoom.chatHistory.forEach((m) => {
          if (m && m.id && !displayedChatMsgIds.has(m.id)) {
            const isMe = m.senderId === localPlayerId;
            appendChatMessage(m.senderName, m.text, isMe ? 'me' : 'other', m.id, m.senderAvatar);
          }
        });
      }

      // 2. ゲーム開始同期 (Firestore冗長化: 部屋にいる全員が確実にゲーム画面へ遷移！)
      if (updatedRoom.status === 'in_game' && updatedRoom.game) {
        if (!gameView || gameView.style.display !== 'flex') {
          const myRole = (updatedRoom.roles && updatedRoom.roles[localPlayerId]) ||
                         (updatedRoom.players && updatedRoom.players[localPlayerId]?.role) ||
                         mySecretRole || 'villager';
          mySecretRole = myRole;
          showRoleAnnouncement(myRole, updatedRoom);
        } else {
          updateGamePhaseUI(updatedRoom);
        }
      }
    }
  });
}

function triggerStartGame() {
  const currentCount = currentRoomData ? Object.keys(currentRoomData.players || {}).length : 1;
  if (currentCount < 3) {
    sound.playClick();
    showToast(`⚠️ 最低3人いないとゲームを開始できません（現在: ${currentCount}/3人）`);
    return;
  }
  sound.playWolfHowl();
  showToast('🐺 役職を配り、ゲームを開始します...');

  // 1. WebSocketでSTART_GAME送信
  sendWs('START_GAME', { roomCode: activeRoomCode, playerId: localPlayerId });

  // 2. REST APIフォールバック（二重経路で確実にゲーム開始を保障）
  fetch(`/api/jinrou/rooms/${encodeURIComponent(activeRoomCode)}/start-game`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId: localPlayerId })
  }).then(async (res) => {
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (err.error) showToast(err.error);
    }
  }).catch(() => {});
}

// Dummy Bot addition for instant testing (一人でも即テストプレイ可能)
async function triggerAddDummy() {
  if (!activeRoomCode) return;
  sound.playClick();
  showToast('🤖 練習用Botを追加しました (+1人)');
  sendWs('ADD_DUMMY_PLAYER', { code: activeRoomCode });
  try {
    await fetch(`/api/jinrou/rooms/${encodeURIComponent(activeRoomCode)}/add-dummy`, { method: 'POST' });
  } catch (e) {}
}

if (btnLobbyAddDummy) btnLobbyAddDummy.addEventListener('click', triggerAddDummy);
if (btnWaitingAddDummy) btnWaitingAddDummy.addEventListener('click', triggerAddDummy);

if (btnLobbyStartGame) btnLobbyStartGame.addEventListener('click', triggerStartGame);
if (btnWaitingStartGame) btnWaitingStartGame.addEventListener('click', triggerStartGame);

if (btnWaitingLeaveRoom) btnWaitingLeaveRoom.addEventListener('click', () => leaveCurrentRoom());
if (btnWaitingCopyCode) {
  btnWaitingCopyCode.addEventListener('click', () => {
    if (!activeRoomCode) return;
    navigator.clipboard.writeText(activeRoomCode).then(() => {
      showToast(`部屋コード #${activeRoomCode} をコピーしました！`);
    });
  });
}
if (btnWaitingVcToggle) {
  btnWaitingVcToggle.addEventListener('click', () => {
    setVcState(!voiceManager.isVcEnabled);
  });
}
if (btnWaitingMicToggle) {
  btnWaitingMicToggle.addEventListener('click', () => {
    setMicState(!voiceManager.isMicMuted);
  });
}
if (btnWaitingForceVc) {
  btnWaitingForceVc.addEventListener('click', openForceVcModal);
}

// --- Role Announcement Phase (ユーザー要望: 最初は自分の役職が言い渡され、その後に試合スタート) ---
function showRoleAnnouncement(roleId, room) {
  closeModal(onlinePlayModal);
  const r = ALL_ROLES_MAP[roleId] || BASE_ROLES[1];

  revealRoleIcon.textContent = r.icon;
  revealRoleName.textContent = r.name;
  revealRoleDesc.textContent = r.desc;
  revealRoleWinCondition.textContent = r.winCondition;
  revealRoleBadge.textContent = r.campName;
  revealRoleBadge.className = 'role-badge ' + (r.camp === 'werewolf' ? 'werewolf' : 'villager');

  openModal(roleAnnouncementModal);
  sound.playWolfHowl();

  let autoConfirmTimer = setTimeout(() => {
    if (roleAnnouncementModal.classList.contains('active')) {
      btnConfirmMyRole.click();
    }
  }, 6000);

  btnConfirmMyRole.onclick = () => {
    clearTimeout(autoConfirmTimer);
    sound.playSuccess();
    closeModal(roleAnnouncementModal);
    switchScreen('game');
    myRoleName.textContent = r.name;
    myRoleIcon.textContent = r.icon;
    myRoleDesc.textContent = r.desc;
    myRoleCampBadge.textContent = r.campName;
    myRoleCampBadge.className = 'role-badge ' + (r.camp === 'werewolf' ? 'werewolf' : 'villager');
    updateGamePhaseUI(room);
  };
}

// --- In-Game Screen Phase Updates ---
function updateTimerBadge(timerSec) {
  if (!currentRoomData || !currentRoomData.game) return;
  const g = currentRoomData.game;
  const phase = g.phase;

  if (phase === 'morning_discussion') {
    gamePhaseText.textContent = `朝の話し合い (残り${timerSec}秒)`;
  } else if (phase === 'morning_voting') {
    gamePhaseText.textContent = `追放投票タイム (残り${timerSec}秒)`;
  } else if (phase === 'morning_execution') {
    gamePhaseText.textContent = `追放結果発表 (残り${timerSec}秒)`;
  } else if (phase.startsWith('night_')) {
    gamePhaseText.textContent = `${g.phaseTitle || '夜の行動'} (残り${timerSec}秒)`;
  } else if (phase === 'morning_result') {
    gamePhaseText.textContent = `昨夜の結果発表 (残り${timerSec}秒)`;
  } else if (phase === 'hunter_revenge') {
    gamePhaseText.textContent = `ハンター道連れ選択 (残り${timerSec}秒)`;
  }
}

function updateGamePhaseUI(room) {
  if (!room || !room.game) return;
  const g = room.game;
  gameDayCountText.textContent = `${g.dayCount || 1}日目`;

  // Update Dramatic Cutscene Banners & Audio
  if (g.phase === 'morning_discussion') {
    sound.playBellSound ? sound.playBellSound() : sound.playClick();
    gamePhaseIcon.textContent = '☀️';
    gamePhaseBadge.className = 'game-phase-badge day';
    cutsceneTitle.textContent = `☀️ ${g.dayCount}日目の朝が来ました`;
    cutsceneBody.innerHTML = `朝の話し合いタイムです。VCまたは左上のチャットで話し合ってください。<br><strong style="color: var(--crimson);">※ 話し合い終了後、怪しい人物を追放投票します。</strong>`;
    gameActionPrompt.textContent = '👥 参加者一覧 (話し合い中):';
  } else if (g.phase === 'morning_voting') {
    sound.playClick();
    gamePhaseIcon.textContent = '🗳️';
    gamePhaseBadge.className = 'game-phase-badge voting';
    cutsceneTitle.textContent = '🗳️ 追放投票タイム';
    cutsceneBody.textContent = '怪しいと思うプレイヤーを1人選んで投票してください。最も票を集めたプレイヤーが追放されます。';
    gameActionPrompt.textContent = '🗳️ 追放したいプレイヤーを選択:';
  } else if (g.phase === 'morning_execution') {
    sound.playExileSound ? sound.playExileSound() : sound.playWolfHowl();
    gamePhaseIcon.textContent = '⚖️';
    gamePhaseBadge.className = 'game-phase-badge voting';
    const exiled = g.lastExiled;
    if (exiled) {
      cutsceneTitle.textContent = `⚖️ 審判の結果:「${exiled.nickname}」が追放されました`;
      cutsceneBody.innerHTML = `投票により <strong>${exiled.nickname}</strong> が村から追放されました。<br>${exiled.role === 'werewolf' ? '<span style="color: var(--emerald); font-weight: 800;">🎉 人狼の追放に成功しました！</span>' : '<span style="color: var(--crimson);">⚠️ 村人陣営のプレイヤーでした...</span>'}`;
    } else {
      cutsceneTitle.textContent = '⚖️ 追放なし';
      cutsceneBody.textContent = '同票のため、今回の追放者は出ませんでした。';
    }
    // Traitor revealed if Mayor died
    if (g.revealedTraitor) {
      cutsceneBody.innerHTML += `<br><strong style="color: var(--gold); font-size: 0.95rem;">🎖️ 村長の遺言発動！ 裏切り者は「${g.revealedTraitor.nickname}」です！</strong>`;
    }
  } else if (g.phase === 'hunter_revenge') {
    gamePhaseIcon.textContent = '🎯';
    cutsceneTitle.textContent = '🎯 ハンターの最後の道連れ射撃！';
    cutsceneBody.textContent = 'ハンターが死亡時に発動する特殊能力！道連れにする相手を1人選択できます。';
    gameActionPrompt.textContent = mySecretRole === 'hunter_avenger' ? '🎯 道連れにする相手を1人選択してください:' : 'ハンターの道連れ選択を待っています...';
  } else if (g.phase.startsWith('night_')) {
    gamePhaseIcon.textContent = '🌙';
    gamePhaseBadge.className = 'game-phase-badge night';
    cutsceneTitle.textContent = `🌙 夜のターン: ${g.phaseTitle || ''}`;

    if (g.phase === 'night_guard') {
      cutsceneBody.textContent = '狩人のターンです。人狼が襲撃する前に守りたい人を1人護衛できます。';
      gameActionPrompt.textContent = mySecretRole === 'hunter_guard' ? '🛡️ 今夜守るプレイヤーを選択:' : '狩人が護衛対象を選択中...';
    } else if (g.phase === 'night_werewolf') {
      sound.playWolfHowl();
      cutsceneBody.textContent = '人狼のターンです。襲撃して殺害するプレイヤーを1人選択します。';
      gameActionPrompt.textContent = mySecretRole === 'werewolf' ? '🐺 襲撃して殺害するプレイヤーを選択:' : '人狼が獲物を狙っています...';
    } else if (g.phase === 'night_seer') {
      cutsceneBody.textContent = '占い師のターンです。占いたいプレイヤーの役職（人狼か市民か）を見抜きます。';
      gameActionPrompt.textContent = mySecretRole === 'seer' ? '🔮 占うプレイヤーを選択:' : '占い師が水晶を覗いています...';
    } else if (g.phase === 'night_medium') {
      cutsceneBody.textContent = '霊媒師のターンです。直前に追放されたプレイヤーの魂と対話します。';
      gameActionPrompt.textContent = mySecretRole === 'medium' ? '🕯️ 追放者の役職結果を確認中...' : '霊媒師が交信中...';
    } else if (g.phase === 'night_archer') {
      cutsceneBody.textContent = 'アーチャーのターンです。一度だけ誰かを狙撃（殺害）できます。';
      gameActionPrompt.textContent = mySecretRole === 'archer' ? '🏹 狙撃するプレイヤーを選択 (しない場合は待機):' : 'アーチャーが狙撃体勢に入っています...';
    } else if (g.phase === 'night_medic') {
      cutsceneBody.textContent = 'メディのターンです。死亡した味方を一度だけ蘇生できます。';
      gameActionPrompt.textContent = mySecretRole === 'medic' ? '💉 復活させるプレイヤーを選択:' : 'メディが治療を行っています...';
    }
  } else if (g.phase === 'morning_result') {
    gamePhaseIcon.textContent = '🌅';
    gamePhaseBadge.className = 'game-phase-badge day';
    const vic = g.lastVictim;
    if (vic) {
      cutsceneTitle.textContent = '🌅 昨夜の犠牲者';
      cutsceneBody.innerHTML = `無残にも <strong>${vic.nickname}</strong> が命を落としました...`;
    } else {
      cutsceneTitle.textContent = '🌅 平穏な朝';
      cutsceneBody.textContent = '昨夜の犠牲者はいませんでした！（狩人の護衛成功、または襲撃なし）';
    }
    if (g.revealedTraitor) {
      cutsceneBody.innerHTML += `<br><strong style="color: var(--gold); font-size: 0.95rem;">🎖️ 村長死亡！ 裏切り者の正体は「${g.revealedTraitor.nickname}」です！</strong>`;
    }
  } else if (g.phase === 'game_over') {
    sound.playVictorySound ? sound.playVictorySound() : sound.playSuccess();
    gamePhaseIcon.textContent = '🏆';
    cutsceneTitle.textContent = g.winnerTitle || (g.winner === 'werewolf' ? '🐺 人狼チームの勝利！' : '🎉 村人チームの勝利！');
    cutsceneBody.innerHTML = `<div style="font-size: 1.1rem; font-weight: 900; color: ${g.winner === 'werewolf' ? 'var(--crimson)' : 'var(--emerald)'};">${g.winner === 'werewolf' ? '市民チームが2人以下になり、人狼チームが村を支配しました！' : 'すべての人狼が追放され、村に平和が戻りました！'}</div><div style="margin-top: 8px; font-size: 0.82rem; color: var(--text-muted);">勝利報酬: +50 コインを獲得しました🪙</div>`;
    btnReturnToLobby.style.display = 'block';
  }

  // Render Players Grid with interactive action buttons
  gamePlayersGrid.innerHTML = '';
  const players = Object.values(room.players || {});
  const me = room.players[localPlayerId];

  players.forEach((p) => {
    const isMe = p.id === localPlayerId;
    const avatarSrc = p.avatarIcon || (isMe ? localAvatarIcon : '') || generateDefaultAvatar(p.nickname);
    const card = document.createElement('div');
    card.className = 'game-player-card' + (!p.isAlive ? ' is-dead' : '') + (p.isSpeaking ? ' speaking' : '');
    card.id = `game_player_${p.id}`;

    let actionBtnText = null;
    let actionType = null;

    if (me && me.isAlive && p.isAlive && !isMe) {
      if (g.phase === 'morning_voting') {
        actionBtnText = '🗳️ 投票';
        actionType = 'CAST_VOTE';
      } else if (g.phase === 'night_guard' && mySecretRole === 'hunter_guard') {
        actionBtnText = '🛡️ 護衛';
        actionType = 'GUARD_TARGET';
      } else if (g.phase === 'night_werewolf' && mySecretRole === 'werewolf') {
        actionBtnText = '🐺 襲撃';
        actionType = 'WEREWOLF_KILL';
      } else if (g.phase === 'night_seer' && mySecretRole === 'seer') {
        actionBtnText = '🔮 占う';
        actionType = 'SEER_DIVINE';
      } else if (g.phase === 'night_archer' && mySecretRole === 'archer') {
        actionBtnText = '🏹 狙撃';
        actionType = 'ARCHER_SHOT';
      }
    } else if (me && g.phase === 'hunter_revenge' && mySecretRole === 'hunter_avenger' && p.isAlive && !isMe) {
      actionBtnText = '🎯 道連れ';
      actionType = 'HUNTER_REVENGE';
    } else if (me && me.isAlive && !p.isAlive && g.phase === 'night_medic' && mySecretRole === 'medic') {
      actionBtnText = '💉 復活';
      actionType = 'MEDIC_REVIVE';
    }

    // Role reveal on game over
    let revealedRoleHtml = '';
    if (g.phase === 'game_over' && g.allRolesRevealed && g.allRolesRevealed[p.id]) {
      const r = ALL_ROLES_MAP[g.allRolesRevealed[p.id].role];
      if (r) {
        revealedRoleHtml = `<div style="font-size: 0.75rem; font-weight: 800; color: ${r.camp === 'werewolf' ? 'var(--crimson)' : 'var(--villager-color)'}; margin-top: 4px;">${r.icon} ${r.name}</div>`;
      }
    }

    card.innerHTML = `
      <img class="game-player-avatar-img" src="${avatarSrc}" alt="${p.nickname}" />
      <div style="font-weight: 800; font-size: 0.88rem; color: var(--text-main);">${formatPlayerDisplayName(p.nickname)}</div>
      <div style="font-size: 0.72rem; color: ${p.isAlive ? 'var(--emerald)' : 'var(--crimson)'}; font-weight: 800;">
        ${p.isAlive ? '生存' : '追放/死亡'}
      </div>
      ${revealedRoleHtml}
      ${actionBtnText ? `<button class="btn-target-select" data-action="${actionType}" data-target="${p.id}">${actionBtnText}</button>` : ''}
    `;

    const btn = card.querySelector('.btn-target-select');
    if (btn) {
      btn.addEventListener('click', () => {
        sound.playClick();
        sendWs('GAME_ACTION', { action: actionType, targetId: p.id });
        showToast(`「${formatPlayerDisplayName(p.nickname)}」を選択しました`);
      });
    }

    gamePlayersGrid.appendChild(card);
  });

  // Host Skip / Advance button
  if (room.hostId === localPlayerId && g.phase !== 'game_over') {
    btnHostNextPhase.style.display = 'block';
  } else {
    btnHostNextPhase.style.display = 'none';
  }
}

if (btnHostNextPhase) {
  btnHostNextPhase.addEventListener('click', () => {
    sound.playClick();
    sendWs('GAME_ACTION', { action: 'HOST_SKIP_PHASE' });
  });
}

if (btnReturnToLobby) {
  btnReturnToLobby.addEventListener('click', () => {
    switchScreen('waiting');
  });
}

// --- Roles Guide & Shop Renderers ---
function renderRoles(campFilter = 'all') {
  rolesList.innerHTML = '';
  const filtered = BASE_ROLES.concat(SHOP_ROLES).filter(r => {
    if (campFilter === 'all') return true;
    if (campFilter === 'shop') return SHOP_ROLES.some(s => s.id === r.id);
    return r.camp === campFilter;
  });

  filtered.forEach(r => {
    const isUnlocked = BASE_ROLES.some(b => b.id === r.id) || unlockedRoles.includes(r.id);
    const card = document.createElement('div');
    card.className = 'role-card';
    card.innerHTML = `
      <div class="role-header">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 1.5rem;">${r.icon}</span>
          <strong style="font-size: 1rem; color: var(--text-main);">${r.name}</strong>
        </div>
        <span class="role-badge ${r.camp === 'werewolf' ? 'werewolf' : 'villager'}">${r.campName}</span>
      </div>
      <p style="font-size: 0.82rem; color: var(--text-sub); line-height: 1.5; margin-bottom: 6px;">${r.desc}</p>
      <div style="font-size: 0.74rem; color: var(--text-muted);">
        <strong>勝利条件:</strong> ${r.winCondition}
      </div>
      ${!isUnlocked ? '<div style="font-size: 0.72rem; color: var(--crimson); font-weight: 700; margin-top: 4px;">🔒 ショップで開放可能</div>' : ''}
    `;
    rolesList.appendChild(card);
  });
}

function renderShop() {
  shopItemsList.innerHTML = '';
  SHOP_ROLES.forEach(r => {
    const isUnlocked = unlockedRoles.includes(r.id);
    const card = document.createElement('div');
    card.className = 'shop-item-card';
    card.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 1.4rem;">${r.icon}</span>
          <strong style="font-size: 1rem; color: var(--text-main);">${r.name}</strong>
          <span class="role-badge villager" style="font-size: 0.7rem;">${r.campName}</span>
        </div>
        <div style="font-weight: 800; color: var(--gold); font-size: 0.95rem;">
          🪙 ${r.cost} C
        </div>
      </div>
      <p style="font-size: 0.8rem; color: var(--text-sub); margin-bottom: 8px;">${r.desc}</p>
      <button class="btn-primary btn-buy-role" ${isUnlocked ? 'disabled' : ''} style="width: 100%; padding: 8px 12px; font-size: 0.85rem;">
        ${isUnlocked ? '✅ 開放済み' : `🪙 ${r.cost}コインで開放`}
      </button>
    `;

    const buyBtn = card.querySelector('.btn-buy-role');
    if (!isUnlocked && buyBtn) {
      buyBtn.addEventListener('click', () => {
        if (userCoins < r.cost) {
          showToast(`コインが不足しています（必要: ${r.cost}C / 所持: ${userCoins}C）`);
          return;
        }
        userCoins -= r.cost;
        unlockedRoles.push(r.id);
        localStorage.setItem('jinrou_unlocked_roles', JSON.stringify(unlockedRoles));
        updateCoinsDisplay();
        scheduleProfileSync();
        renderShop();
        showToast(`🎉 役職「${r.name}」を開放しました！`);
      });
    }

    shopItemsList.appendChild(card);
  });
}

// --- Event Listeners ---
// Profile Avatar Canvas Drawing Engine
let canvasCtx = null;
let currentTool = 'pencil'; // 'pencil' | 'line' | 'circle' | 'fill' | 'eraser'
let currentColor = '#0f172a';
let currentSize = 5;
let isDrawing = false;
let startX = 0;
let startY = 0;
let snapshotData = null;
const undoStack = [];
const MAX_UNDO = 25;

function getCanvasCoords(e) {
  if (!avatarCanvas) return { x: 0, y: 0 };
  const rect = avatarCanvas.getBoundingClientRect();
  const scaleX = avatarCanvas.width / (rect.width || 170);
  const scaleY = avatarCanvas.height / (rect.height || 170);
  const clientX = e.clientX ?? (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
  const clientY = e.clientY ?? (e.touches && e.touches[0] ? e.touches[0].clientY : 0);
  return {
    x: Math.max(0, Math.min(avatarCanvas.width, (clientX - rect.left) * scaleX)),
    y: Math.max(0, Math.min(avatarCanvas.height, (clientY - rect.top) * scaleY))
  };
}

function saveUndoState() {
  if (!canvasCtx || !avatarCanvas) return;
  try {
    if (undoStack.length >= MAX_UNDO) undoStack.shift();
    undoStack.push(canvasCtx.getImageData(0, 0, avatarCanvas.width, avatarCanvas.height));
  } catch (e) {}
}

function updateAvatarLivePreview() {
  if (!avatarCanvas) return;
  try {
    const dataUrl = avatarCanvas.toDataURL('image/png');
    if (settingsAvatarPreview) settingsAvatarPreview.src = dataUrl;
    if (settingsAvatarDisplayLabel) {
      settingsAvatarDisplayLabel.textContent = formatPlayerDisplayName(localNickname || '自分');
    }
  } catch (e) {}
}

function floodFill(sX, sY, fillHex) {
  if (!canvasCtx || !avatarCanvas) return;
  const w = avatarCanvas.width;
  const h = avatarCanvas.height;
  if (sX < 0 || sX >= w || sY < 0 || sY >= h) return;

  const imgData = canvasCtx.getImageData(0, 0, w, h);
  const data = imgData.data;

  // Convert hex color to RGBA
  let hex = fillHex.replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  const targetR = parseInt(hex.slice(0, 2), 16) || 0;
  const targetG = parseInt(hex.slice(2, 4), 16) || 0;
  const targetB = parseInt(hex.slice(4, 6), 16) || 0;
  const targetA = 255;

  const startIdx = (sY * w + sX) * 4;
  const startR = data[startIdx];
  const startG = data[startIdx + 1];
  const startB = data[startIdx + 2];
  const startA = data[startIdx + 3];

  if (Math.abs(startR - targetR) < 6 &&
      Math.abs(startG - targetG) < 6 &&
      Math.abs(startB - targetB) < 6 &&
      Math.abs(startA - targetA) < 6) {
    return;
  }

  function matches(idx) {
    return Math.abs(data[idx] - startR) <= 12 &&
           Math.abs(data[idx + 1] - startG) <= 12 &&
           Math.abs(data[idx + 2] - startB) <= 12 &&
           Math.abs(data[idx + 3] - startA) <= 12;
  }

  const queue = [[sX, sY]];
  const visited = new Uint8Array(w * h);
  visited[sY * w + sX] = 1;

  while (queue.length > 0) {
    const [cx, cy] = queue.pop();
    const idx = (cy * w + cx) * 4;
    data[idx] = targetR;
    data[idx + 1] = targetG;
    data[idx + 2] = targetB;
    data[idx + 3] = targetA;

    const neighbors = [
      [cx + 1, cy],
      [cx - 1, cy],
      [cx, cy + 1],
      [cx, cy - 1]
    ];
    for (let i = 0; i < 4; i++) {
      const nx = neighbors[i][0];
      const ny = neighbors[i][1];
      if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
        const nPos = ny * w + nx;
        if (!visited[nPos]) {
          visited[nPos] = 1;
          const nIdx = nPos * 4;
          if (matches(nIdx)) {
            queue.push([nx, ny]);
          }
        }
      }
    }
  }

  canvasCtx.putImageData(imgData, 0, 0);
}

function drawWolfSampleAvatar() {
  if (!canvasCtx || !avatarCanvas) return;
  const w = avatarCanvas.width;
  const h = avatarCanvas.height;

  // Background - Dark Night
  canvasCtx.fillStyle = '#0f172a';
  canvasCtx.fillRect(0, 0, w, h);

  // Glowing Full Moon
  canvasCtx.fillStyle = '#fef08a';
  canvasCtx.beginPath();
  canvasCtx.arc(w / 2, h / 2 - 10, 56, 0, Math.PI * 2);
  canvasCtx.fill();

  canvasCtx.fillStyle = '#fde047';
  canvasCtx.beginPath();
  canvasCtx.arc(w / 2 - 20, h / 2 - 25, 12, 0, Math.PI * 2);
  canvasCtx.fill();
  canvasCtx.beginPath();
  canvasCtx.arc(w / 2 + 22, h / 2 - 5, 9, 0, Math.PI * 2);
  canvasCtx.fill();

  // Wolf Head Silhouette
  canvasCtx.fillStyle = '#1e293b';
  canvasCtx.beginPath();
  canvasCtx.moveTo(w / 2 - 40, h / 2 + 25);
  canvasCtx.lineTo(w / 2 - 52, h / 2 - 45); // Left ear tip
  canvasCtx.lineTo(w / 2 - 20, h / 2 - 15);
  canvasCtx.lineTo(w / 2 + 20, h / 2 - 15);
  canvasCtx.lineTo(w / 2 + 52, h / 2 - 45); // Right ear tip
  canvasCtx.lineTo(w / 2 + 40, h / 2 + 25);
  canvasCtx.lineTo(w / 2 + 24, h / 2 + 65); // Muzzle right
  canvasCtx.lineTo(w / 2, h / 2 + 76);      // Chin tip
  canvasCtx.lineTo(w / 2 - 24, h / 2 + 65); // Muzzle left
  canvasCtx.closePath();
  canvasCtx.fill();

  // Wolf Inner Ears
  canvasCtx.fillStyle = '#e11d48';
  canvasCtx.beginPath();
  canvasCtx.moveTo(w / 2 - 35, h / 2 + 5);
  canvasCtx.lineTo(w / 2 - 45, h / 2 - 35);
  canvasCtx.lineTo(w / 2 - 25, h / 2 - 10);
  canvasCtx.closePath();
  canvasCtx.fill();

  canvasCtx.beginPath();
  canvasCtx.moveTo(w / 2 + 35, h / 2 + 5);
  canvasCtx.lineTo(w / 2 + 45, h / 2 - 35);
  canvasCtx.lineTo(w / 2 + 25, h / 2 - 10);
  canvasCtx.closePath();
  canvasCtx.fill();

  // Crimson Eyes
  canvasCtx.fillStyle = '#e11d48';
  canvasCtx.beginPath();
  canvasCtx.ellipse(w / 2 - 17, h / 2 + 15, 6, 4, -0.2, 0, Math.PI * 2);
  canvasCtx.fill();
  canvasCtx.beginPath();
  canvasCtx.ellipse(w / 2 + 17, h / 2 + 15, 6, 4, 0.2, 0, Math.PI * 2);
  canvasCtx.fill();

  // Golden pupils
  canvasCtx.fillStyle = '#fbbf24';
  canvasCtx.beginPath();
  canvasCtx.arc(w / 2 - 16, h / 2 + 15, 2.5, 0, Math.PI * 2);
  canvasCtx.fill();
  canvasCtx.beginPath();
  canvasCtx.arc(w / 2 + 16, h / 2 + 15, 2.5, 0, Math.PI * 2);
  canvasCtx.fill();

  // Snout / Nose
  canvasCtx.fillStyle = '#020617';
  canvasCtx.beginPath();
  canvasCtx.ellipse(w / 2, h / 2 + 45, 7, 5, 0, 0, Math.PI * 2);
  canvasCtx.fill();

  // Sharp fangs
  canvasCtx.fillStyle = '#ffffff';
  canvasCtx.beginPath();
  canvasCtx.moveTo(w / 2 - 12, h / 2 + 53);
  canvasCtx.lineTo(w / 2 - 7, h / 2 + 63);
  canvasCtx.lineTo(w / 2 - 3, h / 2 + 53);
  canvasCtx.fill();

  canvasCtx.beginPath();
  canvasCtx.moveTo(w / 2 + 3, h / 2 + 53);
  canvasCtx.lineTo(w / 2 + 7, h / 2 + 63);
  canvasCtx.lineTo(w / 2 + 12, h / 2 + 53);
  canvasCtx.fill();
}

function loadCurrentAvatarIntoCanvas() {
  if (!avatarCanvas) return;
  if (!canvasCtx) {
    canvasCtx = avatarCanvas.getContext('2d', { willReadFrequently: true });
    avatarCanvas.width = 170;
    avatarCanvas.height = 170;
  }
  if (!canvasCtx) return;

  const w = avatarCanvas.width;
  const h = avatarCanvas.height;

  canvasCtx.fillStyle = '#ffffff';
  canvasCtx.fillRect(0, 0, w, h);

  const iconToLoad = localAvatarIcon || (localNickname ? generateDefaultAvatar(localNickname) : '');
  if (iconToLoad) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      canvasCtx.drawImage(img, 0, 0, w, h);
      undoStack.length = 0;
      saveUndoState();
      updateAvatarLivePreview();
    };
    img.onerror = () => {
      undoStack.length = 0;
      saveUndoState();
      updateAvatarLivePreview();
    };
    img.src = iconToLoad;
  } else {
    undoStack.length = 0;
    saveUndoState();
    updateAvatarLivePreview();
  }
}

function initAvatarCanvas() {
  if (!avatarCanvas) return;
  canvasCtx = avatarCanvas.getContext('2d', { willReadFrequently: true });
  if (!canvasCtx) return;

  avatarCanvas.width = 170;
  avatarCanvas.height = 170;
  canvasCtx.lineCap = 'round';
  canvasCtx.lineJoin = 'round';

  // Pointer Events (Mouse, Touch, Pen support)
  avatarCanvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (!canvasCtx) return;
    const { x, y } = getCanvasCoords(e);

    if (currentTool === 'fill') {
      floodFill(Math.round(x), Math.round(y), currentColor);
      saveUndoState();
      updateAvatarLivePreview();
      return;
    }

    isDrawing = true;
    startX = x;
    startY = y;
    snapshotData = canvasCtx.getImageData(0, 0, avatarCanvas.width, avatarCanvas.height);

    canvasCtx.lineWidth = currentSize;
    canvasCtx.strokeStyle = (currentTool === 'eraser') ? '#ffffff' : currentColor;
    canvasCtx.fillStyle = (currentTool === 'eraser') ? '#ffffff' : currentColor;

    if (currentTool === 'pencil' || currentTool === 'eraser') {
      canvasCtx.beginPath();
      canvasCtx.arc(x, y, currentSize / 2, 0, Math.PI * 2);
      canvasCtx.fill();
      canvasCtx.beginPath();
      canvasCtx.moveTo(x, y);
    }
  });

  avatarCanvas.addEventListener('pointermove', (e) => {
    if (!isDrawing || !canvasCtx) return;
    e.preventDefault();
    const { x, y } = getCanvasCoords(e);

    canvasCtx.lineWidth = currentSize;
    canvasCtx.strokeStyle = (currentTool === 'eraser') ? '#ffffff' : currentColor;
    canvasCtx.fillStyle = (currentTool === 'eraser') ? '#ffffff' : currentColor;

    if (currentTool === 'pencil' || currentTool === 'eraser') {
      canvasCtx.lineTo(x, y);
      canvasCtx.stroke();
    } else if (currentTool === 'line') {
      canvasCtx.putImageData(snapshotData, 0, 0);
      canvasCtx.beginPath();
      canvasCtx.moveTo(startX, startY);
      canvasCtx.lineTo(x, y);
      canvasCtx.stroke();
    } else if (currentTool === 'circle') {
      canvasCtx.putImageData(snapshotData, 0, 0);
      const rx = Math.abs(x - startX) / 2;
      const ry = Math.abs(y - startY) / 2;
      const cx = Math.min(startX, x) + rx;
      const cy = Math.min(startY, y) + ry;
      canvasCtx.beginPath();
      canvasCtx.ellipse(cx, cy, Math.max(1, rx), Math.max(1, ry), 0, 0, Math.PI * 2);
      canvasCtx.stroke();
    }
  });

  const finishDrawing = () => {
    if (!isDrawing) return;
    isDrawing = false;
    if (canvasCtx) canvasCtx.closePath();
    saveUndoState();
    updateAvatarLivePreview();
  };

  avatarCanvas.addEventListener('pointerup', finishDrawing);
  avatarCanvas.addEventListener('pointercancel', finishDrawing);
  avatarCanvas.addEventListener('pointerleave', finishDrawing);

  // Tool buttons (Pencil, Line, Circle, Fill, Eraser)
  const toolButtons = [
    { btn: btnToolPencil, tool: 'pencil' },
    { btn: btnToolLine, tool: 'line' },
    { btn: btnToolCircle, tool: 'circle' },
    { btn: btnToolFill, tool: 'fill' },
    { btn: btnToolEraser, tool: 'eraser' }
  ];

  toolButtons.forEach(({ btn, tool }) => {
    if (!btn) return;
    btn.addEventListener('click', () => {
      currentTool = tool;
      toolButtons.forEach(t => t.btn && t.btn.classList.toggle('active', t.tool === tool));
    });
  });

  // Size buttons
  if (canvasSizeGroup) {
    const sizeButtons = canvasSizeGroup.querySelectorAll('.btn-size-dot');
    sizeButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        currentSize = parseInt(btn.getAttribute('data-size'), 10) || 5;
        sizeButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
  }

  // Palette color swatches
  if (canvasColorPalette) {
    const swatches = canvasColorPalette.querySelectorAll('.color-swatch');
    swatches.forEach((sw) => {
      sw.addEventListener('click', () => {
        currentColor = sw.getAttribute('data-color') || '#0f172a';
        if (avatarColorPicker) avatarColorPicker.value = currentColor;
        swatches.forEach(s => s.classList.remove('active'));
        sw.classList.add('active');
        if (currentTool === 'eraser') {
          currentTool = 'pencil';
          toolButtons.forEach(t => t.btn && t.btn.classList.toggle('active', t.tool === 'pencil'));
        }
      });
    });
  }

  // Free Color Picker (16.7M colors)
  if (avatarColorPicker) {
    avatarColorPicker.addEventListener('input', (e) => {
      currentColor = e.target.value;
      if (canvasColorPalette) {
        canvasColorPalette.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
      }
      if (currentTool === 'eraser') {
        currentTool = 'pencil';
        toolButtons.forEach(t => t.btn && t.btn.classList.toggle('active', t.tool === 'pencil'));
      }
    });
  }

  // Undo button
  if (btnAvatarUndo) {
    btnAvatarUndo.addEventListener('click', () => {
      if (undoStack.length > 1) {
        undoStack.pop();
        const prev = undoStack[undoStack.length - 1];
        if (canvasCtx && prev) {
          canvasCtx.putImageData(prev, 0, 0);
          updateAvatarLivePreview();
        }
      } else {
        showToast('これ以上戻せません');
      }
    });
  }

  // Clear button
  if (btnAvatarClear) {
    btnAvatarClear.addEventListener('click', () => {
      if (!canvasCtx || !avatarCanvas) return;
      canvasCtx.fillStyle = '#ffffff';
      canvasCtx.fillRect(0, 0, avatarCanvas.width, avatarCanvas.height);
      saveUndoState();
      updateAvatarLivePreview();
      showToast('キャンバスを全消去しました');
    });
  }

  // Wolf Sample button
  if (btnAvatarSampleWolf) {
    btnAvatarSampleWolf.addEventListener('click', () => {
      drawWolfSampleAvatar();
      saveUndoState();
      updateAvatarLivePreview();
      sound.playClick();
      showToast('🐺 人狼サンプルを描画しました！');
    });
  }

  // Save Avatar button
  if (btnSaveAvatar) {
    btnSaveAvatar.addEventListener('click', () => {
      if (!avatarCanvas) return;
      const newAvatar = avatarCanvas.toDataURL('image/png');
      localAvatarIcon = newAvatar;
      localStorage.setItem('jinrou_avatar_icon', localAvatarIcon);
      sessionStorage.setItem('jinrou_avatar_icon', localAvatarIcon);

      if (topAvatarImg) topAvatarImg.src = localAvatarIcon;
      if (settingsAvatarPreview) settingsAvatarPreview.src = localAvatarIcon;
      if (settingsAvatarDisplayLabel) {
        settingsAvatarDisplayLabel.textContent = formatPlayerDisplayName(localNickname || '自分');
      }

      scheduleProfileSync();

      if (activeRoomCode) {
        sendWs('UPDATE_PROFILE', {
          playerId: localPlayerId,
          nickname: localNickname,
          avatarIcon: localAvatarIcon,
          roomCode: activeRoomCode
        });
      }

      sound.playSuccess();
      showToast('🖼️ プロフィールアイコンを保存しました！');
    });
  }

  loadCurrentAvatarIntoCanvas();
}

btnOpenSettings.addEventListener('click', () => {
  settingsNicknameInput.value = localNickname;
  settingsCharCounter.textContent = `${localNickname.length}/8`;
  settingsErrorMsg.classList.remove('visible');
  updateVcVolumeUI(vcVolume);
  setVcState(voiceManager.isVcEnabled);
  setMicState(voiceManager.isMicMuted);
  if (settingsAvatarDisplayLabel) {
    settingsAvatarDisplayLabel.textContent = formatPlayerDisplayName(localNickname || '自分');
  }
  loadCurrentAvatarIntoCanvas();
  openModal(settingsModal);
});
topNicknameChip.addEventListener('click', () => btnOpenSettings.click());
btnCloseSettings.addEventListener('click', () => closeModal(settingsModal));
btnFinishSettings.addEventListener('click', () => closeModal(settingsModal));

settingsNicknameInput.addEventListener('input', (e) => {
  settingsCharCounter.textContent = `${e.target.value.length}/8`;
  settingsErrorMsg.classList.remove('visible');
  if (settingsAvatarDisplayLabel) {
    settingsAvatarDisplayLabel.textContent = formatPlayerDisplayName(e.target.value || '自分');
  }
});

btnSaveNickname.addEventListener('click', () => {
  const val = (settingsNicknameInput.value || '').trim();
  if (!validateNickname(val)) {
    settingsErrorMsg.classList.add('visible');
    return;
  }
  applyNickname(val);
  showToast(`ニックネームを「${val}」に変更しました`);
});

vcVolumeSlider.addEventListener('input', (e) => updateVcVolumeUI(parseInt(e.target.value, 10)));
presetPills.forEach(pill => {
  pill.addEventListener('click', () => updateVcVolumeUI(parseInt(pill.getAttribute('data-preset'), 10)));
});
btnTestVolume.addEventListener('click', () => {
  sound.playVcTest();
  showToast(`🔊 音量テスト (${vcVolume}%)`);
});

// Role Guide & Shop
btnRoleGuide.addEventListener('click', () => { renderRoles('all'); openModal(roleGuideModal); });
btnCloseRoleGuide.addEventListener('click', () => closeModal(roleGuideModal));
btnFinishRoleGuide.addEventListener('click', () => closeModal(roleGuideModal));

tabRoleAll.addEventListener('click', () => renderRoles('all'));
tabRoleVillager.addEventListener('click', () => renderRoles('villager'));
tabRoleWerewolf.addEventListener('click', () => renderRoles('werewolf'));
tabRoleShop.addEventListener('click', () => renderRoles('shop'));

btnOpenShop.addEventListener('click', () => { renderShop(); openModal(shopModal); });
topCoinsChip.addEventListener('click', () => btnOpenShop.click());
btnCloseShop.addEventListener('click', () => closeModal(shopModal));
btnFinishShop.addEventListener('click', () => closeModal(shopModal));

// Online Play
btnOnlinePlay.addEventListener('click', () => {
  if (activeRoomCode) {
    switchScreen('waiting');
  } else {
    onlineHubView.style.display = 'block';
    onlineCreateRoomView.style.display = 'none';
    onlineJoinRoomView.style.display = 'none';
    openModal(onlinePlayModal);
  }
});
btnCloseOnlinePlay.addEventListener('click', () => {
  stopFirestoreRoomsListener();
  if (activeRoomCode) {
    leaveCurrentRoom();
  } else {
    closeModal(onlinePlayModal);
  }
});

btnCardCreateRoom.addEventListener('click', () => {
  onlineHubView.style.display = 'none';
  onlineCreateRoomView.style.display = 'block';
  updateCreateRoomUI();
});
btnCancelCreateRoom.addEventListener('click', () => {
  onlineCreateRoomView.style.display = 'none';
  onlineHubView.style.display = 'block';
});

// --- GUI Mode Selector (スマホ用GUI / PC用GUI) ---
let currentGuiMode = localStorage.getItem('jinrou_gui_mode') || 
  ((window.innerWidth <= 768 || /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) ? 'mobile' : 'pc');

function applyGuiMode(mode, showNotification = false) {
  currentGuiMode = mode === 'mobile' ? 'mobile' : 'pc';
  localStorage.setItem('jinrou_gui_mode', currentGuiMode);

  if (currentGuiMode === 'mobile') {
    document.body.classList.add('gui-mobile');
    document.body.classList.remove('gui-pc');
    if (btnGuiMobile) btnGuiMobile.classList.add('active');
    if (btnGuiPc) btnGuiPc.classList.remove('active');
    if (btnSettingsGuiMobile) btnSettingsGuiMobile.classList.add('active');
    if (btnSettingsGuiPc) btnSettingsGuiPc.classList.remove('active');
  } else {
    document.body.classList.add('gui-pc');
    document.body.classList.remove('gui-mobile');
    if (btnGuiPc) btnGuiPc.classList.add('active');
    if (btnGuiMobile) btnGuiMobile.classList.remove('active');
    if (btnSettingsGuiPc) btnSettingsGuiPc.classList.add('active');
    if (btnSettingsGuiMobile) btnSettingsGuiMobile.classList.remove('active');
  }

  if (showNotification) {
    sound.playClick();
    showToast(currentGuiMode === 'mobile' ? '📱 スマホ用GUIに切り替えました' : '💻 PC用GUIに切り替えました');
  }
}

if (btnGuiPc) btnGuiPc.addEventListener('click', () => applyGuiMode('pc', true));
if (btnGuiMobile) btnGuiMobile.addEventListener('click', () => applyGuiMode('mobile', true));
if (btnSettingsGuiPc) btnSettingsGuiPc.addEventListener('click', () => applyGuiMode('pc', true));
if (btnSettingsGuiMobile) btnSettingsGuiMobile.addEventListener('click', () => applyGuiMode('mobile', true));

// --- Real-Time Rooms List View ---
let firestoreRoomsUnsub = null;

function mergeActiveRooms(newRoomsList) {
  const roomsMap = new Map();
  (activeRoomsList || []).forEach(r => {
    if (r && r.code) roomsMap.set(r.code, r);
  });
  (newRoomsList || []).forEach(r => {
    if (r && r.code) {
      roomsMap.set(r.code, r);
    }
  });
  activeRoomsList = Array.from(roomsMap.values()).filter(r => r.status !== 'finished');
  renderRealtimeRoomsList();
}

function startFirestoreRoomsListener() {
  if (firestoreRoomsUnsub) return;
  firestoreRoomsUnsub = subscribeToActiveRooms((rooms) => {
    mergeActiveRooms(rooms);
  }, (err) => {
    console.warn('[Firestore Rooms Subscription Error]', err);
  });
}

function stopFirestoreRoomsListener() {
  if (firestoreRoomsUnsub) {
    try { firestoreRoomsUnsub(); } catch (e) {}
    firestoreRoomsUnsub = null;
  }
}

btnCardShowJoinInput.addEventListener('click', () => {
  onlineHubView.style.display = 'none';
  onlineJoinRoomView.style.display = 'block';
  startFirestoreRoomsListener();
  loadActiveRooms();
  if (roomsPollingInterval) clearInterval(roomsPollingInterval);
  roomsPollingInterval = setInterval(loadActiveRooms, 3500);
});

if (btnBackFromJoinRoom) {
  btnBackFromJoinRoom.addEventListener('click', () => {
    if (roomsPollingInterval) clearInterval(roomsPollingInterval);
    stopFirestoreRoomsListener();
    onlineJoinRoomView.style.display = 'none';
    onlineHubView.style.display = 'block';
  });
}

if (btnRefreshRoomsList) {
  btnRefreshRoomsList.addEventListener('click', () => {
    sound.playClick();
    loadActiveRooms();
    showToast('部屋一覧を最新に更新しました');
  });
}

async function loadActiveRooms() {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'GET_ACTIVE_ROOMS' }));
  }
  const roomsMap = new Map();

  // 1. Fetch from Firebase Firestore directly
  try {
    const firestoreRooms = await fetchActiveFirestoreRooms();
    firestoreRooms.forEach(r => {
      if (r && r.code) {
        roomsMap.set(r.code, r);
      }
    });
  } catch (e) {
    console.warn('[Room List Fetch Firestore]', e);
  }

  // 2. Fetch from Express Server API
  try {
    const res = await fetch('/api/jinrou/rooms');
    if (res.ok) {
      const data = await res.json();
      (data.rooms || []).forEach(r => {
        if (r && r.code) {
          if (!roomsMap.has(r.code) || roomsMap.get(r.code).playerCount < r.playerCount) {
            roomsMap.set(r.code, r);
          }
        }
      });
    }
  } catch (e) {
    console.warn('[Room List Fetch Server]', e);
  }

  activeRoomsList = Array.from(roomsMap.values()).filter(r => r.status !== 'finished');
  renderRealtimeRoomsList();
}

function renderRealtimeRoomsList() {
  if (!realtimeRoomsList) return;

  if (!activeRoomsList || activeRoomsList.length === 0) {
    realtimeRoomsList.innerHTML = `
      <div style="background: #ffffff; border: 1.5px dashed var(--border-color); border-radius: 14px; padding: 24px 16px; text-align: center;">
        <div style="font-size: 2rem; margin-bottom: 6px;">🏕️</div>
        <div style="font-weight: 800; font-size: 0.95rem; color: var(--text-main); margin-bottom: 4px;">現在作られている部屋はありません</div>
        <div style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 12px;">あなたが最初の部屋を作成するか、友達の開設をお待ちください。</div>
        <button class="btn-primary" id="btnQuickCreateRoom" style="padding: 8px 18px; font-size: 0.85rem;">🏠 新しく部屋を作成する</button>
      </div>
    `;
    const quickCreate = realtimeRoomsList.querySelector('#btnQuickCreateRoom');
    if (quickCreate) {
      quickCreate.addEventListener('click', () => {
        onlineJoinRoomView.style.display = 'none';
        onlineCreateRoomView.style.display = 'block';
        updateCreateRoomUI();
      });
    }
    return;
  }

  realtimeRoomsList.innerHTML = '';
  activeRoomsList.forEach((r) => {
    const card = document.createElement('div');
    card.className = 'realtime-room-card';

    const isFull = r.playerCount >= r.maxPlayers;
    const isInGame = r.status === 'in_game';
    const isPending = (pendingRequestRoomCode === r.code);

    let statusBadgeClass = 'waiting';
    let statusText = '🟢 募集中';
    if (isInGame) {
      statusBadgeClass = 'in_game';
      statusText = '⚔️ 試合中';
    } else if (isFull) {
      statusBadgeClass = 'full';
      statusText = '🔴 満員';
    }

    let actionButtonHtml = '';
    if (isInGame) {
      actionButtonHtml = `<button class="btn-room-enter" disabled style="opacity: 0.6;">⚔️ 試合中</button>`;
    } else if (isFull) {
      actionButtonHtml = `<button class="btn-room-enter" disabled style="opacity: 0.6;">🔴 満員</button>`;
    } else {
      actionButtonHtml = `<button class="btn-primary btn-room-enter-direct" data-room-code="${r.code}" style="padding: 8px 16px; font-weight: 900; font-size: 0.85rem; border-radius: 8px; box-shadow: var(--shadow-sm);">🚪 今すぐ入室</button>`;
    }

    card.innerHTML = `
      <div class="room-card-info">
        <div class="room-card-header">
          <span class="room-card-title">🏠 ${r.name || (r.hostNickname ? r.hostNickname + 'さんの部屋' : '人狼部屋')}</span>
          <span class="room-code-chip">#${r.code}</span>
          <span class="room-status-badge ${statusBadgeClass}">${statusText}</span>
        </div>
        <div class="room-card-meta">
          <span>👑 ホスト: ${r.hostNickname || 'ホスト'}</span>
          <span>👥 ${r.playerCount} / ${r.maxPlayers}人 (最低3人)</span>
          <span>⏱️ ${r.discussionTime || 60}秒</span>
          <span>🎭 ${r.roleMode === 'original' ? 'カスタム配役' : 'ノーマル'}</span>
        </div>
      </div>
      <div>
        ${actionButtonHtml}
      </div>
    `;

    const enterBtn = card.querySelector('.btn-room-enter-direct:not(:disabled)');
    if (enterBtn) {
      enterBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        joinDirectRoom(r.code);
      });
    }

    if (!isInGame && !isFull) {
      card.style.cursor = 'pointer';
      card.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        joinDirectRoom(r.code);
      });
    }

    realtimeRoomsList.appendChild(card);
  });
}

// オンライン一覧から部屋を探して入る（直接即時入室、ホスト招待・申請不要）
function requestJoinRoom(roomCode) {
  joinDirectRoom(roomCode);
}

// 部屋コードで入る場合はホストの申請・招待不要で直接入室
async function joinDirectRoom(inputCode) {
  const rawVal = (inputCode || '').toString().trim();
  const code = rawVal
    .replace(/[＃#\s]/g, '')
    .replace(/[０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0))
    .trim();

  if (!code || code.length === 0) {
    if (joinRoomErrorMsg) {
      joinRoomErrorMsg.textContent = '部屋コードを入力してください（例: 1234）';
      joinRoomErrorMsg.classList.add('visible');
    }
    showToast('⚠️ 部屋コードを入力してください');
    return;
  }
  if (joinRoomErrorMsg) joinRoomErrorMsg.classList.remove('visible');

  sound.playClick();
  showToast(`部屋 #${code} に直接入室中...`);

  try {
    // 1. Firebase Firestore & Server に直接参加（ホスト申請不要・即入室）
    const myAvatar = localAvatarIcon || generateDefaultAvatar(localNickname);
    const roomData = await joinFirestoreRoom(code, localPlayerId, localNickname, voiceManager.isVcEnabled, myAvatar);

    // 2. WebSocket サーバへ JOIN_ROOM 通知
    sendWs('JOIN_ROOM', {
      code,
      playerId: localPlayerId,
      nickname: localNickname,
      avatarIcon: myAvatar,
      isVcOn: voiceManager.isVcEnabled,
      roomData
    });

    // 3. ロビーへ即時画面遷移
    activeRoomCode = code;
    isHost = (roomData.hostId === localPlayerId);
    currentRoomData = roomData;
    enterLobbyView(code, roomData);
    sound.playSuccess();
    showToast(`🎉 部屋 #${code} に直接入室しました！`);
  } catch (err) {
    sound.playClick();
    if (joinRoomErrorMsg) {
      joinRoomErrorMsg.textContent = err.message || '部屋に入室できませんでした';
      joinRoomErrorMsg.classList.add('visible');
    }
    showToast(`⚠️ 入室エラー: ${err.message}`);
  }
}

// Host Response Modal Listeners
if (btnPromptApprove) {
  btnPromptApprove.addEventListener('click', () => {
    if (!currentPromptRequest) return;
    sound.playClick();
    sendWs('RESPOND_JOIN_REQUEST', {
      roomCode: activeRoomCode,
      requesterId: currentPromptRequest.requesterId,
      approved: true
    });
    closeModal(joinRequestPromptModal);
    showToast(`「${currentPromptRequest.requesterNickname}」さんの参加を許可しました`);
    currentPromptRequest = null;
  });
}

if (btnPromptReject) {
  btnPromptReject.addEventListener('click', () => {
    if (!currentPromptRequest) return;
    sound.playClick();
    sendWs('RESPOND_JOIN_REQUEST', {
      roomCode: activeRoomCode,
      requesterId: currentPromptRequest.requesterId,
      approved: false
    });
    closeModal(joinRequestPromptModal);
    showToast(`「${currentPromptRequest.requesterNickname}」さんの参加を見送りました`);
    currentPromptRequest = null;
  });
}

if (btnCancelJoinRequest) {
  btnCancelJoinRequest.addEventListener('click', () => {
    sound.playClick();
    if (pendingRequestRoomCode) {
      sendWs('CANCEL_JOIN_REQUEST', {
        roomCode: pendingRequestRoomCode,
        requesterId: localPlayerId
      });
      pendingRequestRoomCode = null;
    }
    closeModal(joinRequestWaitingModal);
    renderRealtimeRoomsList();
    showToast('参加申請をキャンセルしました');
  });
}

roomCodeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    btnJoinRoomSubmit.click();
  }
});

roomCodeInput.addEventListener('input', () => {
  joinRoomErrorMsg.classList.remove('visible');
});

if (roomNameInput) {
  roomNameInput.addEventListener('input', (e) => {
    let val = e.target.value;
    if (val.length > 8) {
      e.target.value = val.slice(0, 8);
      val = e.target.value;
    }
    if (roomNameCharCounter) roomNameCharCounter.textContent = `${val.length}/8`;
    if (roomNameErrorMsg) roomNameErrorMsg.classList.remove('visible');
  });
}

// Create Room Action
btnConfirmCreateRoom.addEventListener('click', async () => {
  btnConfirmCreateRoom.disabled = true;
  try {
    let roomName = (roomNameInput ? roomNameInput.value : '').trim();
    if (!roomName) roomName = `${localNickname || 'ホスト'}の部屋`;
    if (roomName.length > 8) roomName = roomName.slice(0, 8);
    if (roomName.length < 2) {
      if (roomNameErrorMsg) roomNameErrorMsg.classList.add('visible');
      showToast('⚠️ 部屋の名前は2文字〜8文字で入力してください');
      btnConfirmCreateRoom.disabled = false;
      return;
    }

    const code = Math.floor(1000 + Math.random() * 9000).toString();
    showToast('部屋を作成中...');

    let finalConfig = {};
    if (createRoomMode === 'normal') {
      finalConfig = getNormalRolesConfig(createRoomPlayerCount);
    } else {
      finalConfig = { ...originalRolesConfig };
    }
    const finalRolesList = expandRolesList(finalConfig);

    const myAvatar = localAvatarIcon || generateDefaultAvatar(localNickname);
    const roomData = await createFirestoreRoom(code, localPlayerId, localNickname, {
      name: roomName,
      maxPlayers: createRoomPlayerCount,
      discussionTime: createRoomDiscussionTime,
      roleMode: createRoomMode,
      rolesConfig: finalConfig,
      rolesList: finalRolesList,
      avatarIcon: myAvatar
    });

    activeRoomCode = code;
    isHost = true;
    enterLobbyView(code, roomData);

    sendWs('CREATE_ROOM', {
      code,
      name: roomName,
      playerId: localPlayerId,
      nickname: localNickname,
      avatarIcon: myAvatar,
      maxPlayers: createRoomPlayerCount,
      discussionTime: createRoomDiscussionTime,
      roleMode: createRoomMode,
      rolesConfig: finalConfig,
      rolesList: finalRolesList,
      isVcOn: voiceManager.isVcEnabled
    });

    showToast(`部屋 #${code}「${roomName}」を作成しました！`);
  } catch (err) {
    showToast('部屋作成エラー: ' + err.message);
  } finally {
    btnConfirmCreateRoom.disabled = false;
  }
});

// Join Room Action (部屋コードで入る時はホストの申請は不要で直接入室)
btnJoinRoomSubmit.addEventListener('click', () => {
  joinDirectRoom(roomCodeInput.value);
});

btnCopyRoomCode.addEventListener('click', () => {
  if (!activeRoomCode) return;
  navigator.clipboard.writeText(activeRoomCode).then(() => {
    showToast(`部屋コード #${activeRoomCode} をコピーしました！`);
  });
});

btnInviteShare.addEventListener('click', () => {
  if (!activeRoomCode) return;
  const inviteText = lobbyInvitePreviewText.textContent;
  if (navigator.share) {
    navigator.share({ title: '人狼オンライン 招待', text: inviteText }).catch(() => {});
  } else {
    navigator.clipboard.writeText(inviteText).then(() => {
      showToast('✉️ 招待メッセージをコピーしました！友達に送信してください');
    });
  }
});

async function leaveCurrentRoom(options = {}) {
  const code = activeRoomCode;
  if (!code) return;

  const meWasHost = isHost;
  stopPresenceHeartbeat();
  if (lobbyUnsubscribe) {
    try { lobbyUnsubscribe(); } catch (e) {}
    lobbyUnsubscribe = null;
  }

  // 1. Send WebSocket leave notification
  sendWs('LEAVE_ROOM', { code, playerId: localPlayerId, isHost: meWasHost });

  // 2. Fetch keepalive and Beacon for instantaneous browser unload / back
  const payloadStr = JSON.stringify({ playerId: localPlayerId, isHost: meWasHost });
  try {
    fetch(`/api/jinrou/rooms/${encodeURIComponent(code)}/leave`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payloadStr,
      keepalive: true
    }).catch(() => {});
  } catch (e) {}

  if (navigator.sendBeacon) {
    try {
      navigator.sendBeacon(`/api/jinrou/rooms/${encodeURIComponent(code)}/leave`, payloadStr);
    } catch (e) {}
  }

  // 3. Sync to Firebase Firestore
  await leaveFirestoreRoom(code, localPlayerId).catch(() => {});

  // 4. WebRTC voice cleanup
  voiceManager.leaveRoom();

  activeRoomCode = null;
  isHost = false;
  currentRoomData = null;

  switchScreen('main');

  // If user clicked browser back, clean up url hash without triggering another popstate
  if (window.location.hash.startsWith('#room=')) {
    try {
      history.replaceState(null, '', window.location.pathname);
    } catch (e) {}
  }

  loadActiveRooms();

  if (options.fromBrowserBack) {
    showToast('🔙 ブラウザバックにより部屋から退出しました');
  } else {
    showToast('部屋を退出しました');
  }
}

btnLeaveRoom.addEventListener('click', () => leaveCurrentRoom());

// ブラウザバックの検知: 部屋にいる状態でブラウザの「戻る」が押されたら自動で部屋を離脱
window.addEventListener('popstate', async () => {
  if (activeRoomCode) {
    await leaveCurrentRoom({ fromBrowserBack: true });
  }
});

// ページ終了・離脱時の即時クリーンアップ
window.addEventListener('pagehide', () => {
  if (activeRoomCode && navigator.sendBeacon) {
    try {
      navigator.sendBeacon(`/api/jinrou/rooms/${encodeURIComponent(activeRoomCode)}/leave`, JSON.stringify({ playerId: localPlayerId, isHost }));
    } catch (e) {}
  }
});

window.addEventListener('beforeunload', () => {
  if (activeRoomCode && navigator.sendBeacon) {
    try {
      navigator.sendBeacon(`/api/jinrou/rooms/${encodeURIComponent(activeRoomCode)}/leave`, JSON.stringify({ playerId: localPlayerId, isHost }));
    } catch (e) {}
  }
});

// --- Force VC & Device Setup Event Handlers (ユーザー要望: vcができない時、vcを強制的にする、端末内の設定を変更することができる) ---
async function openForceVcModal() {
  sound.playClick();
  if (forceVcPermBadge) {
    forceVcPermBadge.textContent = '確認中...';
    forceVcPermBadge.style.background = 'var(--bg-card-subtle)';
    forceVcPermBadge.style.color = 'var(--text-sub)';
  }

  await voiceManager.ensureAudioContext();
  await voiceManager.initLocalAudio();

  const perm = await voiceManager.checkPermissionStatus();
  if (forceVcPermBadge) {
    if (perm === 'granted') {
      forceVcPermBadge.textContent = '✅ 許可済み (正常稼働)';
      forceVcPermBadge.style.background = 'var(--emerald-light)';
      forceVcPermBadge.style.color = 'var(--emerald)';
    } else if (perm === 'denied') {
      forceVcPermBadge.textContent = '❌ ブロック中 (ブラウザ設定の変更が必要です)';
      forceVcPermBadge.style.background = 'var(--crimson-light)';
      forceVcPermBadge.style.color = 'var(--crimson)';
    } else {
      forceVcPermBadge.textContent = '⚠️ 要許可・確認';
      forceVcPermBadge.style.background = 'var(--gold-light)';
      forceVcPermBadge.style.color = 'var(--gold)';
    }
  }

  const { inputs, outputs } = await voiceManager.getAudioDevices();
  if (forceVcInputSelect) {
    forceVcInputSelect.innerHTML = inputs.length > 0
      ? inputs.map(d => `<option value="${d.deviceId}">${d.label}</option>`).join('')
      : '<option value="">デフォルトマイク</option>';
    if (voiceManager.selectedInputDeviceId) {
      forceVcInputSelect.value = voiceManager.selectedInputDeviceId;
    }
  }

  if (forceVcOutputSelect) {
    forceVcOutputSelect.innerHTML = outputs.length > 0
      ? outputs.map(d => `<option value="${d.deviceId}">${d.label}</option>`).join('')
      : '<option value="">デフォルトスピーカー</option>';
    if (voiceManager.selectedOutputDeviceId) {
      forceVcOutputSelect.value = voiceManager.selectedOutputDeviceId;
    }
  }

  openModal(forceVcModal);
}

if (btnLobbyForceVc) btnLobbyForceVc.addEventListener('click', openForceVcModal);
if (btnGameForceVc) btnGameForceVc.addEventListener('click', openForceVcModal);
if (btnSettingsForceVc) btnSettingsForceVc.addEventListener('click', openForceVcModal);
if (btnCloseForceVc) btnCloseForceVc.addEventListener('click', () => closeModal(forceVcModal));

if (forceVcInputSelect) {
  forceVcInputSelect.addEventListener('change', async (e) => {
    const devId = e.target.value;
    showToast('マイク入力を切り替えています...');
    await voiceManager.setAudioInputDevice(devId);
    showToast('🎙️ マイク入力を変更しました');
  });
}

if (forceVcOutputSelect) {
  forceVcOutputSelect.addEventListener('change', async (e) => {
    const devId = e.target.value;
    await voiceManager.setAudioOutputDevice(devId);
    showToast('🔊 スピーカー出力を変更しました');
  });
}

if (btnForceVcTestSpeaker) {
  btnForceVcTestSpeaker.addEventListener('click', () => {
    sound.playVcTest();
    showToast('🔊 スピーカーテスト音を再生しました');
  });
}

if (btnExecuteForceVc) {
  btnExecuteForceVc.addEventListener('click', async () => {
    sound.playClick();
    btnExecuteForceVc.disabled = true;
    btnExecuteForceVc.textContent = '⚡ 強制再接続を実行中...';
    try {
      const memberIds = currentRoomData ? Object.keys(currentRoomData.players || {}) : [];
      const ok = await voiceManager.forceRestartVoice(memberIds);
      closeModal(forceVcModal);
      if (ok) {
        sound.playSuccess();
        showToast('⚡ VCとマイクを強制再起動・再接続しました！');
      } else {
        showToast('⚠️ マイク権限を確認し、ブラウザ設定でマイクを許可してください');
      }
    } catch (e) {
      showToast('⚠️ 強制再接続中にエラーが発生しました');
    } finally {
      btnExecuteForceVc.disabled = false;
      btnExecuteForceVc.textContent = '⚡ 設定を適用してVCを強制再接続';
    }
  });
}

// Initial Nickname modal
initialNicknameInput.addEventListener('input', (e) => {
  initialCharCounter.textContent = `${e.target.value.length}/8`;
  if (validateNickname(e.target.value)) initialErrorMsg.classList.remove('visible');
});

btnConfirmInitialNickname.addEventListener('click', () => {
  const val = (initialNicknameInput.value || '').trim();
  if (!validateNickname(val)) {
    initialErrorMsg.classList.add('visible');
    return;
  }
  applyNickname(val);
  closeModal(initialNicknameModal);
  sound.playSuccess();
  showToast(`ニックネーム「${val}」で開始しました！`);
});

// App Initialization
function initApp() {
  applyGuiMode(currentGuiMode, false);
  updateCoinsDisplay();
  updateVcVolumeUI(vcVolume);
  setVcState(true); // VC ON by default
  loadActiveRooms();

  // Initialize Profile Avatar Canvas
  initAvatarCanvas();

  const currentDisplayAvatar = localAvatarIcon || generateDefaultAvatar(localNickname || 'ゲスト');
  if (topAvatarImg) topAvatarImg.src = currentDisplayAvatar;
  if (settingsAvatarPreview) settingsAvatarPreview.src = currentDisplayAvatar;
  if (settingsAvatarDisplayLabel) {
    settingsAvatarDisplayLabel.textContent = formatPlayerDisplayName(localNickname || '自分');
  }

  if (!localNickname || !validateNickname(localNickname)) {
    openModal(initialNicknameModal);
  } else {
    topNicknameText.textContent = formatPlayerDisplayName(localNickname);
    scheduleProfileSync();
  }

  const urlParams = new URLSearchParams(window.location.search);
  const roomParam = urlParams.get('room');
  if (roomParam && /^\d{4}$/.test(roomParam)) {
    if (roomCodeInput) roomCodeInput.value = roomParam;
    onlineHubView.style.display = 'none';
    onlineJoinRoomView.style.display = 'block';
    openModal(onlinePlayModal);
    joinDirectRoom(roomParam);
  }
}

window.addEventListener('DOMContentLoaded', initApp);
