// WebRTC Voice Chat Manager for Jinrou Online (人狼オンライン)
// Provides P2P mesh audio, voice activity detection (speaking indicator), VC ON/OFF, Mic Mute/Unmute,
// Audio device switching (Mic/Speaker), Volume boost (50%-500%), and Force VC Reconnection.

export class VoiceManager {
  constructor({ onSpeakingChange, onPeerVoiceState, onRemoteTrack, onVolumeLevel, onLog }) {
    this.onSpeakingChange = onSpeakingChange || (() => {});
    this.onPeerVoiceState = onPeerVoiceState || (() => {});
    this.onRemoteTrack = onRemoteTrack || (() => {});
    this.onVolumeLevel = onVolumeLevel || (() => {});
    this.onLog = onLog || (() => {});

    // State
    this.isVcEnabled = true; // VC is ON by default
    this.isMicMuted = false; // Mic is ON by default
    this.volumePercent = 100; // 50% to 500%
    this.localStream = null;
    this.selectedInputDeviceId = null;
    this.selectedOutputDeviceId = null;
    this.audioContext = null;
    this.analyser = null;
    this.analyserTimer = null;
    this.isSpeaking = false;
    this.isAudioInitialized = false;

    // WebRTC Peers: peerId -> { pc, audioElement, gainNode, pendingCandidates, isNegotiating }
    this.peers = new Map();

    // Signal send function (injected by main.js)
    this.sendSignal = null;
    this.localPlayerId = null;
    this.roomCode = null;

    // Audio element container in DOM
    this.audioContainer = document.getElementById('webrtcAudioContainer');
    if (!this.audioContainer) {
      this.audioContainer = document.createElement('div');
      this.audioContainer.id = 'webrtcAudioContainer';
      this.audioContainer.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1;';
      document.body.appendChild(this.audioContainer);
    }

    // High availability STUN Servers configuration
    this.rtcConfig = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun.services.mozilla.com' },
        { urls: 'stun:stun.cloudflare.com:3478' }
      ]
    };
  }

  setSignalSender(sender, localPlayerId, roomCode) {
    this.sendSignal = sender;
    this.localPlayerId = localPlayerId;
    this.roomCode = roomCode;
  }

  // Ensure AudioContext is instantiated and running (essential for browser autoplay policies)
  async ensureAudioContext() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      if (!this.audioContext) {
        this.audioContext = new AudioCtx();
      }
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }
      return this.audioContext;
    } catch (e) {
      console.warn('[WebRTC Voice] AudioContext resume failed:', e);
      return null;
    }
  }

  // Check current browser permission state for microphone
  async checkPermissionStatus() {
    if (navigator.permissions && navigator.permissions.query) {
      try {
        const result = await navigator.permissions.query({ name: 'microphone' });
        return result.state; // 'granted', 'prompt', 'denied'
      } catch (e) {}
    }
    return 'unknown';
  }

  // Enumerate connected audio devices (Microphones & Speakers)
  async getAudioDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      return { inputs: [], outputs: [] };
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter(d => d.kind === 'audioinput').map(d => ({
        deviceId: d.deviceId,
        label: d.label || `マイク (${d.deviceId.slice(0, 5)}...)`
      }));
      const outputs = devices.filter(d => d.kind === 'audiooutput').map(d => ({
        deviceId: d.deviceId,
        label: d.label || `スピーカー (${d.deviceId.slice(0, 5)}...)`
      }));
      return { inputs, outputs };
    } catch (e) {
      console.warn('[WebRTC Voice] enumerateDevices error:', e);
      return { inputs: [], outputs: [] };
    }
  }

  // Initialize or resume microphone stream
  async initLocalAudio(forceNew = false, preferredDeviceId = null) {
    if (preferredDeviceId) {
      this.selectedInputDeviceId = preferredDeviceId;
    }

    if (this.localStream && !forceNew) {
      this.updateTrackState();
      await this.ensureAudioContext();
      return true;
    }

    // Stop existing stream tracks before reacquiring
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => {
        try { t.stop(); } catch (e) {}
      });
      this.localStream = null;
    }

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        this.onLog('お使いのブラウザ・環境ではマイク機能がサポートされていません');
        return false;
      }

      await this.ensureAudioContext();

      // Audio constraints with fallback
      const baseConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      };
      if (this.selectedInputDeviceId) {
        baseConstraints.deviceId = { exact: this.selectedInputDeviceId };
      }

      let stream = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: baseConstraints,
          video: false
        });
      } catch (advancedErr) {
        console.warn('[WebRTC Voice] Advanced audio constraints failed, trying basic audio...', advancedErr);
        // Fallback to basic audio constraint if high-spec fails
        stream = await navigator.mediaDevices.getUserMedia({
          audio: this.selectedInputDeviceId ? { deviceId: this.selectedInputDeviceId } : true,
          video: false
        });
      }

      this.localStream = stream;
      this.isAudioInitialized = true;
      this.setupAudioAnalysis(stream);
      this.updateTrackState();

      // Replace or attach tracks to all existing peer connections
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        for (const [peerId, peerData] of this.peers.entries()) {
          const senders = peerData.pc.getSenders ? peerData.pc.getSenders() : [];
          const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
          if (audioSender && audioSender.replaceTrack) {
            audioSender.replaceTrack(audioTrack).catch(e => console.warn('[WebRTC Voice] replaceTrack error:', e));
          } else {
            try {
              peerData.pc.addTrack(audioTrack, stream);
            } catch (e) {}
          }
        }
      }

      this.onLog('マイクが正常に接続されました');
      return true;
    } catch (err) {
      console.warn('[WebRTC Voice] Microphone permission denied or unavailable:', err);
      this.onLog('マイクへのアクセスが制限されています（「VC強制再接続・端末設定」から許可・変更が可能です）');
      return false;
    }
  }

  // Switch microphone input device
  async setAudioInputDevice(deviceId) {
    this.selectedInputDeviceId = deviceId;
    return await this.initLocalAudio(true, deviceId);
  }

  // Switch speaker output device (if supported by browser)
  async setAudioOutputDevice(deviceId) {
    this.selectedOutputDeviceId = deviceId;
    for (const peer of this.peers.values()) {
      if (peer.audioElement && typeof peer.audioElement.setSinkId === 'function') {
        try {
          await peer.audioElement.setSinkId(deviceId);
        } catch (e) {
          console.warn('[WebRTC Voice] setSinkId error:', e);
        }
      }
    }
  }

  // Voice Activity Detection (VAD) & Live volume meter using AnalyserNode
  setupAudioAnalysis(stream) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;

      if (!this.audioContext) {
        this.audioContext = new AudioCtx();
      }
      if (this.audioContext.state === 'suspended') {
        this.audioContext.resume().catch(() => {});
      }

      const source = this.audioContext.createMediaStreamSource(stream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.smoothingTimeConstant = 0.4;
      source.connect(this.analyser);

      const buffer = new Uint8Array(this.analyser.frequencyBinCount);
      let speakingFrames = 0;

      if (this.analyserTimer) clearInterval(this.analyserTimer);
      this.analyserTimer = setInterval(() => {
        if (!this.localStream || !this.isVcEnabled || this.isMicMuted) {
          this.onVolumeLevel(0);
          if (this.isSpeaking) {
            this.isSpeaking = false;
            this.onSpeakingChange(false);
            this.broadcastVoiceState();
          }
          return;
        }

        this.analyser.getByteFrequencyData(buffer);
        let sum = 0;
        for (let i = 0; i < buffer.length; i++) {
          sum += buffer[i];
        }
        const avg = sum / buffer.length;

        // Normalize level (0 to 100) for volume bar UI
        const normalizedLevel = Math.min(100, Math.round((avg / 80) * 100));
        this.onVolumeLevel(normalizedLevel);

        // Threshold for speaking
        const currentlySpeaking = avg > 14;
        if (currentlySpeaking) {
          speakingFrames = Math.min(speakingFrames + 1, 5);
        } else {
          speakingFrames = Math.max(speakingFrames - 1, 0);
        }

        const isNowSpeaking = speakingFrames >= 2;
        if (isNowSpeaking !== this.isSpeaking) {
          this.isSpeaking = isNowSpeaking;
          this.onSpeakingChange(isNowSpeaking);
          this.broadcastVoiceState();
        }
      }, 100);
    } catch (e) {
      console.warn('[WebRTC] Audio analysis setup error:', e);
    }
  }

  // Apply track enabled status based on isVcEnabled and isMicMuted
  updateTrackState() {
    if (this.localStream) {
      const audioTracks = this.localStream.getAudioTracks();
      const shouldBeActive = this.isVcEnabled && !this.isMicMuted;
      audioTracks.forEach(track => {
        track.enabled = shouldBeActive;
      });
    }

    // Update remote peer audio elements
    for (const peer of this.peers.values()) {
      if (peer.audioElement) {
        peer.audioElement.muted = !this.isVcEnabled;
        if (peer.gainNode) {
          peer.gainNode.gain.setValueAtTime(this.isVcEnabled ? (this.volumePercent / 100) : 0, 0);
        }
      }
    }

    this.broadcastVoiceState();
  }

  // Toggle VC ON/OFF
  setVcEnabled(enabled) {
    this.isVcEnabled = !!enabled;
    this.updateTrackState();
    if (this.isVcEnabled && !this.localStream) {
      this.initLocalAudio();
    }
  }

  // Toggle Mic ON/OFF (Mute/Unmute)
  setMicMuted(muted) {
    this.isMicMuted = !!muted;
    this.updateTrackState();
  }

  // Set VC Volume (50% ~ 500%)
  setVolume(percent) {
    this.volumePercent = Math.max(50, Math.min(500, Number(percent) || 100));
    const gainValue = this.isVcEnabled ? (this.volumePercent / 100) : 0;
    for (const peer of this.peers.values()) {
      if (peer.gainNode) {
        try {
          peer.gainNode.gain.setValueAtTime(gainValue, 0);
        } catch (e) {}
      } else if (peer.audioElement) {
        peer.audioElement.volume = Math.min(1.0, this.volumePercent / 100);
      }
    }
  }

  broadcastVoiceState() {
    if (this.sendSignal && this.localPlayerId && this.roomCode) {
      this.sendSignal({
        type: 'VOICE_STATE',
        payload: {
          roomCode: this.roomCode,
          senderId: this.localPlayerId,
          isVcOn: this.isVcEnabled,
          isMuted: this.isMicMuted,
          isSpeaking: this.isSpeaking
        }
      });
    }
  }

  // Handle peer joining room -> initiate connection
  async handlePeerJoined(peerId, isInitiator = false) {
    if (!peerId || peerId === this.localPlayerId) return;

    // Clean up old peer if exists
    if (this.peers.has(peerId)) {
      this.handlePeerLeft(peerId);
    }

    const pc = new RTCPeerConnection(this.rtcConfig);

    // Audio element in DOM for rock-solid playback across iOS/Safari/Android/Chrome
    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.playsInline = true;
    audioEl.muted = !this.isVcEnabled;
    audioEl.volume = Math.min(1.0, this.volumePercent / 100);
    if (this.selectedOutputDeviceId && typeof audioEl.setSinkId === 'function') {
      audioEl.setSinkId(this.selectedOutputDeviceId).catch(() => {});
    }
    this.audioContainer.appendChild(audioEl);

    let gainNode = null;
    try {
      const ctx = await this.ensureAudioContext();
      if (ctx) {
        gainNode = ctx.createGain();
        gainNode.gain.setValueAtTime(this.isVcEnabled ? (this.volumePercent / 100) : 0, ctx.currentTime);
        gainNode.connect(ctx.destination);
      }
    } catch (e) {}

    const peerData = {
      pc,
      audioElement: audioEl,
      gainNode,
      peerId,
      pendingCandidates: [],
      isNegotiating: false
    };
    this.peers.set(peerId, peerData);

    // Send ICE candidates to remote peer
    pc.onicecandidate = (event) => {
      if (event.candidate && this.sendSignal) {
        this.sendSignal({
          type: 'WEBRTC_SIGNAL',
          payload: {
            roomCode: this.roomCode,
            targetId: peerId,
            signal: {
              type: 'candidate',
              candidate: event.candidate
            }
          }
        });
      }
    };

    // Receive remote audio track
    pc.ontrack = (event) => {
      const remoteStream = event.streams[0] || new MediaStream([event.track]);
      audioEl.srcObject = remoteStream;
      audioEl.play().catch(e => {
        console.warn('[WebRTC Voice] audio.play() autoplay constraint:', e.message);
      });

      // Connect to Web Audio API gain for volume boost above 100%
      try {
        if (this.audioContext && peerData.gainNode) {
          const source = this.audioContext.createMediaStreamSource(remoteStream);
          source.connect(peerData.gainNode);
          audioEl.muted = true; // Use Web Audio destination to prevent double audio
        }
      } catch (e) {
        audioEl.muted = !this.isVcEnabled;
      }

      this.onRemoteTrack(peerId, remoteStream);
    };

    // Add local tracks if available
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(track => {
        try {
          pc.addTrack(track, this.localStream);
        } catch (e) {}
      });
    }

    // If initiator, create offer
    if (isInitiator) {
      try {
        peerData.isNegotiating = true;
        const offer = await pc.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: false
        });
        await pc.setLocalDescription(offer);

        if (this.sendSignal) {
          this.sendSignal({
            type: 'WEBRTC_SIGNAL',
            payload: {
              roomCode: this.roomCode,
              targetId: peerId,
              signal: {
                type: 'offer',
                sdp: offer
              }
            }
          });
        }
      } catch (err) {
        console.warn('[WebRTC Voice] Create offer failed:', err);
      } finally {
        peerData.isNegotiating = false;
      }
    }
  }

  // Handle incoming WebRTC signaling message with candidate queueing
  async handleSignal(senderId, signal) {
    if (!signal || !senderId || senderId === this.localPlayerId) return;

    let peer = this.peers.get(senderId);
    if (!peer) {
      await this.handlePeerJoined(senderId, false);
      peer = this.peers.get(senderId);
    }
    if (!peer) return;

    const pc = peer.pc;

    try {
      if (signal.type === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));

        // Flush queued candidates
        if (peer.pendingCandidates && peer.pendingCandidates.length > 0) {
          for (const cand of peer.pendingCandidates) {
            try { await pc.addIceCandidate(new RTCIceCandidate(cand)); } catch (e) {}
          }
          peer.pendingCandidates = [];
        }

        // Add local tracks if not added yet
        if (this.localStream) {
          const senders = pc.getSenders();
          this.localStream.getAudioTracks().forEach(track => {
            if (!senders.some(s => s.track === track)) {
              try { pc.addTrack(track, this.localStream); } catch (e) {}
            }
          });
        }

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        if (this.sendSignal) {
          this.sendSignal({
            type: 'WEBRTC_SIGNAL',
            payload: {
              roomCode: this.roomCode,
              targetId: senderId,
              signal: {
                type: 'answer',
                sdp: answer
              }
            }
          });
        }
      } else if (signal.type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));

        // Flush queued candidates
        if (peer.pendingCandidates && peer.pendingCandidates.length > 0) {
          for (const cand of peer.pendingCandidates) {
            try { await pc.addIceCandidate(new RTCIceCandidate(cand)); } catch (e) {}
          }
          peer.pendingCandidates = [];
        }
      } else if (signal.type === 'candidate' && signal.candidate) {
        if (!pc.remoteDescription || !pc.remoteDescription.type) {
          peer.pendingCandidates.push(signal.candidate);
        } else {
          await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
        }
      }
    } catch (e) {
      console.warn('[WebRTC Voice] handleSignal error:', e);
    }
  }

  // Handle peer leaving
  handlePeerLeft(peerId) {
    const peer = this.peers.get(peerId);
    if (peer) {
      try {
        peer.pc.close();
        if (peer.audioElement) {
          peer.audioElement.srcObject = null;
          peer.audioElement.remove();
        }
      } catch (e) {}
      this.peers.delete(peerId);
    }
  }

  // Force restart / reconnect voice (user requested: VCができない時、VCを強制的にする)
  async forceRestartVoice(currentPeerIds = []) {
    this.onLog('⚡ VCとマイクを強制再起動しています...');

    // 1. Force resume AudioContext
    await this.ensureAudioContext();

    // 2. Force re-acquire microphone stream
    const micOk = await this.initLocalAudio(true, this.selectedInputDeviceId);

    // 3. Close existing peers and renegotiate
    for (const [peerId, peer] of this.peers.entries()) {
      try {
        peer.pc.close();
        if (peer.audioElement) {
          peer.audioElement.srcObject = null;
          peer.audioElement.remove();
        }
      } catch (e) {}
    }
    this.peers.clear();

    // 4. If in a room with peers, create new offers to all peers
    if (Array.isArray(currentPeerIds)) {
      for (const pId of currentPeerIds) {
        if (pId !== this.localPlayerId) {
          await this.handlePeerJoined(pId, true);
        }
      }
    }

    this.broadcastVoiceState();
    return micOk;
  }

  // Leave room: close all connections and clear timers
  leaveRoom() {
    for (const [peerId, peer] of this.peers.entries()) {
      try {
        peer.pc.close();
        if (peer.audioElement) {
          peer.audioElement.srcObject = null;
          peer.audioElement.remove();
        }
      } catch (e) {}
    }
    this.peers.clear();
    this.roomCode = null;

    if (this.analyserTimer) {
      clearInterval(this.analyserTimer);
      this.analyserTimer = null;
    }
    this.isSpeaking = false;
    this.onVolumeLevel(0);
  }
}
