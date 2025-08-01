class VoiceChat {
  constructor() {
    this.ws = null;
    this.localStream = null;
    this.peers = new Map();
    this.clientId = null;
    this.roomId = null;
    this.isMuted = false;

    this.iceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ];

    this.initializeElements();
    this.attachEventListeners();
  }

  initializeElements() {
    this.elements = {
      connectSection: document.getElementById('connect-section'),
      chatSection: document.getElementById('chat-section'),
      roomInput: document.getElementById('room-input'),
      connectBtn: document.getElementById('connect-btn'),
      leaveBtn: document.getElementById('leave-btn'),
      muteBtn: document.getElementById('mute-btn'),
      roomIdSpan: document.getElementById('room-id'),
      statusSpan: document.getElementById('connection-status'),
      peerCountSpan: document.getElementById('peer-count'),
      localLevel: document.getElementById('local-level'),
      peersDiv: document.getElementById('peers'),
      muteIcon: document.querySelector('.mute-icon'),
      unmuteIcon: document.querySelector('.unmute-icon'),
    };
  }

  attachEventListeners() {
    this.elements.connectBtn.addEventListener('click', () => this.connect());
    this.elements.leaveBtn.addEventListener('click', () => this.disconnect());
    this.elements.muteBtn.addEventListener('click', () => this.toggleMute());
    this.elements.roomInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') this.connect();
    });
  }

  async connect() {
    const room = this.elements.roomInput.value.trim();
    if (!room) {
      alert('Please enter a room ID');
      return;
    }

    try {
      await this.getUserMedia();
      this.connectWebSocket(room);
    } catch (err) {
      console.error('Error connecting:', err);
      alert('Failed to access microphone. Please check permissions.');
    }
  }

  async getUserMedia() {
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    this.setupAudioLevelMonitoring(this.localStream, this.elements.localLevel);
  }

  setupAudioLevelMonitoring(stream, levelElement) {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = audioContext.createAnalyser();
    const microphone = audioContext.createMediaStreamSource(stream);
    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    analyser.smoothingTimeConstant = 0.8;
    analyser.fftSize = 256;

    microphone.connect(analyser);

    const checkLevel = () => {
      analyser.getByteFrequencyData(dataArray);
      const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
      const normalized = Math.min(100, (average / 128) * 100);
      levelElement.style.width = normalized + '%';

      if (stream.active) {
        requestAnimationFrame(checkLevel);
      }
    };

    checkLevel();
  }

  connectWebSocket(room) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${protocol}//${window.location.host}`);

    this.ws.onopen = () => {
      console.log('WebSocket connected');
      this.updateConnectionStatus('Connected', true);
    };

    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      this.handleMessage(message);
    };

    this.ws.onclose = () => {
      console.log('WebSocket disconnected');
      this.updateConnectionStatus('Disconnected', false);
      this.cleanup();
    };

    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      this.updateConnectionStatus('Error', false);
    };

    this.roomId = room;
  }

  handleMessage(message) {
    switch (message.type) {
      case 'id':
        this.clientId = message.id;
        this.joinRoom();
        break;

      case 'room-joined':
        this.onRoomJoined(message);
        break;

      case 'new-peer':
        this.createPeerConnection(message.peerId, true);
        break;

      case 'offer':
        this.handleOffer(message);
        break;

      case 'answer':
        this.handleAnswer(message);
        break;

      case 'ice-candidate':
        this.handleIceCandidate(message);
        break;

      case 'peer-left':
        this.removePeer(message.peerId);
        break;
    }
  }

  joinRoom() {
    this.send({ type: 'join', room: this.roomId });
  }

  onRoomJoined(message) {
    this.elements.connectSection.classList.add('hidden');
    this.elements.chatSection.classList.remove('hidden');
    this.elements.roomIdSpan.textContent = message.room;

    message.others.forEach((peerId) => {
      this.createPeerConnection(peerId, false);
    });

    this.updatePeerCount();
  }

  createPeerConnection(peerId, initiator) {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });

    this.localStream.getTracks().forEach((track) => {
      pc.addTrack(track, this.localStream);
    });

    pc.ontrack = (event) => {
      this.handleRemoteStream(peerId, event.streams[0]);
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.send({
          type: 'ice-candidate',
          to: peerId,
          candidate: event.candidate,
        });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`Peer ${peerId} connection state:`, pc.connectionState);
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        this.removePeer(peerId);
      }
    };

    this.peers.set(peerId, { pc, initiator });

    if (initiator) {
      this.createOffer(peerId);
    }

    this.updatePeerCount();
  }

  async createOffer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    try {
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);

      this.send({
        type: 'offer',
        to: peerId,
        offer: offer,
      });
    } catch (err) {
      console.error('Error creating offer:', err);
    }
  }

  async handleOffer(message) {
    const peerId = message.from;
    let peer = this.peers.get(peerId);

    if (!peer) {
      this.createPeerConnection(peerId, false);
      peer = this.peers.get(peerId);
    }

    try {
      await peer.pc.setRemoteDescription(message.offer);
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);

      this.send({
        type: 'answer',
        to: peerId,
        answer: answer,
      });
    } catch (err) {
      console.error('Error handling offer:', err);
    }
  }

  async handleAnswer(message) {
    const peer = this.peers.get(message.from);
    if (!peer) return;

    try {
      await peer.pc.setRemoteDescription(message.answer);
    } catch (err) {
      console.error('Error handling answer:', err);
    }
  }

  async handleIceCandidate(message) {
    const peer = this.peers.get(message.from);
    if (!peer) return;

    try {
      await peer.pc.addIceCandidate(message.candidate);
    } catch (err) {
      console.error('Error adding ICE candidate:', err);
    }
  }

  handleRemoteStream(peerId, stream) {
    const existingAudio = document.getElementById(`audio-${peerId}`);
    if (existingAudio) {
      existingAudio.srcObject = stream;
      return;
    }

    const audio = document.createElement('audio');
    audio.id = `audio-${peerId}`;
    audio.srcObject = stream;
    audio.autoplay = true;

    const peerDiv = document.createElement('div');
    peerDiv.className = 'peer';
    peerDiv.id = `peer-${peerId}`;

    const peerIdDiv = document.createElement('div');
    peerIdDiv.className = 'peer-id';
    peerIdDiv.textContent = `Peer: ${peerId}`;

    const levelMeter = document.createElement('div');
    levelMeter.className = 'level-meter';

    const levelBar = document.createElement('div');
    levelBar.className = 'level-bar';

    const levelFill = document.createElement('div');
    levelFill.className = 'level-fill';
    levelFill.id = `level-${peerId}`;

    levelBar.appendChild(levelFill);
    levelMeter.appendChild(levelBar);
    peerDiv.appendChild(peerIdDiv);
    peerDiv.appendChild(levelMeter);
    peerDiv.appendChild(audio);

    this.elements.peersDiv.appendChild(peerDiv);

    this.setupAudioLevelMonitoring(stream, levelFill);
  }

  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.pc.close();
      this.peers.delete(peerId);
    }

    const peerDiv = document.getElementById(`peer-${peerId}`);
    if (peerDiv) {
      peerDiv.remove();
    }

    this.updatePeerCount();
  }

  toggleMute() {
    if (!this.localStream) return;

    this.isMuted = !this.isMuted;
    this.localStream.getAudioTracks().forEach((track) => {
      track.enabled = !this.isMuted;
    });

    this.elements.muteIcon.classList.toggle('hidden');
    this.elements.unmuteIcon.classList.toggle('hidden');
  }

  disconnect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send({ type: 'leave' });
      this.ws.close();
    }

    this.cleanup();

    this.elements.connectSection.classList.remove('hidden');
    this.elements.chatSection.classList.add('hidden');
    this.elements.roomInput.value = '';
  }

  cleanup() {
    this.peers.forEach((peer, peerId) => {
      peer.pc.close();
    });
    this.peers.clear();

    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }

    this.elements.peersDiv.innerHTML = '';
    this.elements.localLevel.style.width = '0%';

    this.clientId = null;
    this.roomId = null;
    this.isMuted = false;
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  updateConnectionStatus(status, connected) {
    this.elements.statusSpan.textContent = status;
    this.elements.statusSpan.classList.toggle('connected', connected);
  }

  updatePeerCount() {
    this.elements.peerCountSpan.textContent = this.peers.size;
  }
}

const voiceChat = new VoiceChat();
