/* ==========================================================================
   WebRTC peer connection lifecycle: media capture, SDP, ICE, stats, recovery.
   Transport-agnostic — the caller supplies send* callbacks.
   ========================================================================== */
'use strict';

window.RTC = (function rtc() {
  let pc = null;
  let localStream = null;
  let remoteStream = null;
  let statsTimer = null;
  let iceRestartAttempts = 0;
  /** Latch: both ICE and connection state report `failed` for one drop. */
  let restartInFlight = false;
  let makingOffer = false;
  let isPolite = false;
  let currentCallId = null;

  const MAX_ICE_RESTARTS = 3;

  /**
   * ICE candidates can arrive before the remote description is set (the
   * answerer often gets them first). Adding one early throws, so we queue
   * until the remote description lands.
   */
  let pendingCandidates = [];

  const handlers = {
    onIceCandidate: () => {},
    onRemoteStream: () => {},
    onConnectionStateChange: () => {},
    onStats: () => {},
    onNegotiationNeeded: () => {},
    onFailed: () => {},
  };

  function configure(next) { Object.assign(handlers, next); }

  /* ------------------------------------------------------------------------
     Microphone
     ------------------------------------------------------------------------ */

  /**
   * Requests the microphone with the DSP chain enabled. These three
   * constraints are what make a browser call sound like a phone call rather
   * than a speakerphone in a hallway.
   */
  async function getMicrophone(settings = {}) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser does not support microphone access. Use Chrome, Edge, Firefox or Safari over HTTPS.');
    }

    const constraints = {
      audio: {
        echoCancellation: settings.echoCancellation !== false,
        noiseSuppression: settings.noiseSuppression !== false,
        autoGainControl: settings.autoGainControl !== false,
        // 48 kHz mono matches Opus' native rate, avoiding a resample.
        sampleRate: 48000,
        channelCount: 1,
        // Chromium-only hints; ignored elsewhere.
        googEchoCancellation: settings.echoCancellation !== false,
        googNoiseSuppression: settings.noiseSuppression !== false,
        googAutoGainControl: settings.autoGainControl !== false,
        googHighpassFilter: true,
        latency: 0.01,
      },
      video: false,
    };

    // Release any stream we already hold, so a second capture cannot orphan
    // the first and leave the OS microphone indicator lit forever.
    stopLocalStream();

    try {
      localStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      // Retry bare-bones: some devices reject the full constraint set.
      if (err.name === 'OverconstrainedError' || err.name === 'NotReadableError') {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      } else {
        throw translateMediaError(err);
      }
    }

    return localStream;
  }

  function translateMediaError(err) {
    const map = {
      NotAllowedError: 'Microphone permission was denied. Enable it in your browser site settings and try again.',
      PermissionDeniedError: 'Microphone permission was denied.',
      NotFoundError: 'No microphone was found on this device.',
      NotReadableError: 'Your microphone is already in use by another application.',
      SecurityError: 'Microphone access requires a secure (HTTPS) connection.',
    };
    const friendly = new Error(map[err.name] || `Could not access the microphone (${err.name}).`);
    friendly.name = err.name;
    return friendly;
  }

  /* ------------------------------------------------------------------------
     Peer connection
     ------------------------------------------------------------------------ */

  function createPeerConnection({ iceServers, callId, polite = false }) {
    close();

    currentCallId = callId;
    isPolite = polite;
    iceRestartAttempts = 0;
    restartInFlight = false;
    pendingCandidates = [];

    pc = new RTCPeerConnection({
      iceServers: iceServers && iceServers.length ? iceServers : [{ urls: 'stun:stun.l.google.com:19302' }],
      iceTransportPolicy: 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      // A small pool lets the first offer already carry candidates, shaving
      // a round trip off call setup.
      iceCandidatePoolSize: 4,
    });

    remoteStream = new MediaStream();

    if (localStream) {
      localStream.getTracks().forEach((track) => {
        const sender = pc.addTrack(track, localStream);
        tuneAudioSender(sender);
      });
    }

    pc.ontrack = (event) => {
      event.streams[0]?.getTracks().forEach((track) => {
        if (!remoteStream.getTracks().includes(track)) remoteStream.addTrack(track);
      });
      handlers.onRemoteStream(remoteStream);
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) handlers.onIceCandidate(event.candidate.toJSON());
    };

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      handlers.onConnectionStateChange(state);

      if (state === 'failed') {
        attemptIceRestart();
      } else if (state === 'connected' || state === 'completed') {
        iceRestartAttempts = 0;
      }
    };

    pc.onconnectionstatechange = () => {
      handlers.onConnectionStateChange(pc.connectionState);
      if (pc.connectionState === 'failed') attemptIceRestart();
    };

    pc.onnegotiationneeded = () => handlers.onNegotiationNeeded();

    startStatsMonitor();
    return pc;
  }

  /**
   * Caps and shapes the outgoing audio encoding. 32 kbps mono Opus is
   * transparent for speech; DTX stops sending during silence, which saves
   * bandwidth on a mobile connection.
   */
  function tuneAudioSender(sender) {
    if (!sender || sender.track?.kind !== 'audio') return;
    try {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = 32000;
      params.encodings[0].networkPriority = 'high';
      params.encodings[0].priority = 'high';
      params.encodings[0].dtx = 'enabled';
      sender.setParameters(params).catch(() => {});
    } catch { /* Not supported on this browser; the defaults are fine. */ }
  }

  /**
   * Rewrites the Opus fmtp line to favour voice quality and low latency.
   * These are the knobs the API does not expose any other way.
   */
  function preferOpus(sdp) {
    const opusPayload = /a=rtpmap:(\d+) opus\/48000/i.exec(sdp)?.[1];
    if (!opusPayload) return sdp;

    const options = [
      'stereo=0',
      'sprop-stereo=0',
      'maxaveragebitrate=32000',
      'maxplaybackrate=48000',
      'useinbandfec=1',    // forward error correction — masks packet loss
      'usedtx=1',          // discontinuous transmission during silence
      'cbr=0',
      'ptime=20',          // 20 ms frames: the latency/overhead sweet spot
      'minptime=10',
    ].join(';');

    const fmtpLine = new RegExp(`a=fmtp:${opusPayload} .*`);
    if (fmtpLine.test(sdp)) {
      return sdp.replace(fmtpLine, `a=fmtp:${opusPayload} ${options}`);
    }
    return sdp.replace(
      new RegExp(`(a=rtpmap:${opusPayload} opus/48000.*\r?\n)`),
      `$1a=fmtp:${opusPayload} ${options}\r\n`,
    );
  }

  /**
   * The call can end mid-negotiation, which nulls `pc` between awaits. Bail
   * quietly instead of throwing a TypeError that surfaces to the user as a
   * "could not negotiate" error on a call they just hung up normally.
   */
  function ensureOpen() {
    return Boolean(pc) && pc.signalingState !== 'closed';
  }

  async function createOffer({ iceRestart = false } = {}) {
    if (!ensureOpen()) return null;
    makingOffer = true;
    try {
      const offer = await pc.createOffer({ offerToReceiveAudio: true, iceRestart });
      if (!ensureOpen()) return null;
      offer.sdp = preferOpus(offer.sdp);
      await pc.setLocalDescription(offer);
      return pc ? pc.localDescription : null;
    } finally {
      makingOffer = false;
    }
  }

  async function createAnswer() {
    if (!ensureOpen()) return null;
    const answer = await pc.createAnswer();
    if (!ensureOpen()) return null;
    answer.sdp = preferOpus(answer.sdp);
    await pc.setLocalDescription(answer);
    return pc ? pc.localDescription : null;
  }

  /**
   * Applies a remote offer/answer using the "perfect negotiation" collision
   * rule: if both sides offer at once, the impolite peer ignores the incoming
   * offer and the polite peer rolls back its own.
   */
  async function setRemoteDescription(description) {
    if (!ensureOpen()) return false;

    const offerCollision = description.type === 'offer'
      && (makingOffer || pc.signalingState !== 'stable');

    if (offerCollision) {
      if (!isPolite) return false;
      await Promise.all([
        pc.setLocalDescription({ type: 'rollback' }).catch(() => {}),
        pc.setRemoteDescription(new RTCSessionDescription(description)),
      ]);
    } else {
      await pc.setRemoteDescription(new RTCSessionDescription(description));
    }

    // Drain anything that arrived before we had a remote description.
    const queued = pendingCandidates;
    pendingCandidates = [];
    for (const candidate of queued) {
      if (!ensureOpen()) break;
      await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
    }

    return true;
  }

  async function addIceCandidate(candidate) {
    if (!pc || !candidate) return;
    if (!pc.remoteDescription || !pc.remoteDescription.type) {
      pendingCandidates.push(candidate);
      return;
    }
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      // A rejected candidate is survivable as long as another one connects.
      console.warn('Failed to add ICE candidate', err);
    }
  }

  /**
   * Re-gathers candidates on the existing connection. This recovers from a
   * network change (wifi -> cellular) without tearing down the call.
   */
  async function attemptIceRestart() {
    if (!pc || iceRestartAttempts >= MAX_ICE_RESTARTS) {
      if (iceRestartAttempts >= MAX_ICE_RESTARTS) handlers.onFailed('ice-failed');
      return;
    }

    // Browsers report `failed` on BOTH iceConnectionState and connectionState,
    // so a single network drop calls this twice. Without this latch each real
    // failure would burn two of the three attempts, and the two runs could
    // emit competing restart offers.
    if (restartInFlight) return;
    restartInFlight = true;

    try {
      // Only the offerer may restart ICE; the answerer asks its peer to.
      if (pc.signalingState !== 'stable') return;

      iceRestartAttempts += 1;
      console.warn(`ICE restart attempt ${iceRestartAttempts}/${MAX_ICE_RESTARTS}`);

      const offer = await createOffer({ iceRestart: true });
      if (offer) handlers.onNegotiationNeeded(offer, true);
    } catch (err) {
      console.error('ICE restart failed', err);
      handlers.onFailed('ice-restart-failed');
    } finally {
      restartInFlight = false;
    }
  }

  /* ------------------------------------------------------------------------
     Stats / network quality
     ------------------------------------------------------------------------ */

  let lastPacketsLost = 0;
  let lastPacketsReceived = 0;

  /**
   * Grades the link from RTT, jitter and loss — roughly how a softphone shows
   * signal bars. Loss dominates: it is what listeners actually hear.
   */
  function rate({ rttMs, jitterMs, packetLossPct }) {
    if (packetLossPct > 8 || rttMs > 500 || jitterMs > 60) return 'poor';
    if (packetLossPct > 3 || rttMs > 300 || jitterMs > 30) return 'fair';
    if (packetLossPct > 1 || rttMs > 150 || jitterMs > 15) return 'good';
    return 'excellent';
  }

  function startStatsMonitor() {
    stopStatsMonitor();
    lastPacketsLost = 0;
    lastPacketsReceived = 0;

    statsTimer = setInterval(async () => {
      if (!pc || pc.connectionState === 'closed') return;

      try {
        const report = await pc.getStats();
        const sample = {
          rttMs: 0,
          jitterMs: 0,
          packetLossPct: 0,
          bitrateKbps: 0,
          audioLevel: 0,
          connectionType: null,
          codec: null,
          rating: 'unknown',
        };

        let inbound = null;
        let selectedPair = null;
        const candidates = new Map();
        const codecs = new Map();

        report.forEach((stat) => {
          if (stat.type === 'inbound-rtp' && stat.kind === 'audio') inbound = stat;
          if (stat.type === 'remote-candidate' || stat.type === 'local-candidate') candidates.set(stat.id, stat);
          if (stat.type === 'codec') codecs.set(stat.id, stat);
          if (stat.type === 'candidate-pair' && (stat.selected || stat.state === 'succeeded' && stat.nominated)) {
            selectedPair = stat;
          }
        });

        if (selectedPair) {
          sample.rttMs = Math.round((selectedPair.currentRoundTripTime || 0) * 1000);
          const local = candidates.get(selectedPair.localCandidateId);
          const remote = candidates.get(selectedPair.remoteCandidateId);
          // "relay" means media is flowing through TURN rather than peer-to-peer.
          sample.connectionType = local?.candidateType === 'relay' || remote?.candidateType === 'relay'
            ? 'relay'
            : local?.candidateType || 'host';
        }

        if (inbound) {
          sample.jitterMs = Math.round((inbound.jitter || 0) * 1000);
          sample.audioLevel = inbound.audioLevel || 0;

          // Loss is cumulative in getStats; the useful figure is the rate
          // over the last interval, not since the call began.
          const lostDelta = (inbound.packetsLost || 0) - lastPacketsLost;
          const recvDelta = (inbound.packetsReceived || 0) - lastPacketsReceived;
          lastPacketsLost = inbound.packetsLost || 0;
          lastPacketsReceived = inbound.packetsReceived || 0;

          const total = lostDelta + recvDelta;
          sample.packetLossPct = total > 0 ? Math.max(0, Math.round((lostDelta / total) * 1000) / 10) : 0;

          const codec = codecs.get(inbound.codecId);
          if (codec) {
            sample.codec = `${codec.mimeType?.split('/')[1] || 'opus'} @ ${Math.round((codec.clockRate || 48000) / 1000)}kHz`;
          }
        }

        sample.rating = rate(sample);
        handlers.onStats(sample);
      } catch (err) {
        console.warn('getStats failed', err);
      }
    }, 2000);
  }

  function stopStatsMonitor() {
    if (statsTimer) {
      clearInterval(statsTimer);
      statsTimer = null;
    }
  }

  /* ------------------------------------------------------------------------
     Controls
     ------------------------------------------------------------------------ */

  function setMuted(muted) {
    if (!localStream) return false;
    localStream.getAudioTracks().forEach((track) => { track.enabled = !muted; });
    return muted;
  }

  function isMuted() {
    const track = localStream?.getAudioTracks()[0];
    return track ? !track.enabled : false;
  }

  /**
   * Routes output to the loudspeaker where the browser allows it.
   * setSinkId is Chromium-only; iOS Safari picks the route itself, so there we
   * just report failure and let the UI keep the toggle visual-only.
   */
  async function setSpeaker(audioElement, enabled) {
    if (!audioElement) return false;

    if (typeof audioElement.setSinkId === 'function') {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const outputs = devices.filter((d) => d.kind === 'audiooutput');
        const target = enabled
          ? outputs.find((d) => /speaker|speakerphone/i.test(d.label)) || outputs.find((d) => d.deviceId === 'default')
          : outputs.find((d) => /earpiece|receiver|headset/i.test(d.label)) || outputs.find((d) => d.deviceId === 'default');

        if (target) {
          await audioElement.setSinkId(target.deviceId);
          return true;
        }
      } catch (err) {
        console.warn('setSinkId unavailable', err);
      }
    }

    // Fallback: at least make the volume difference audible.
    audioElement.volume = enabled ? 1.0 : 0.75;
    return false;
  }

  /**
   * Gathers ICE candidates against the configured servers WITHOUT placing a
   * call, and reports which kinds were obtainable.
   *
   * This exists because the failure it detects is otherwise invisible: with no
   * working TURN relay, a call between two phones on mobile data rings, both
   * sides display "Connected", and no audio ever passes. Being able to see
   * "relay: 0" turns a baffling silent failure into a one-line answer.
   */
  async function testConnectivity(iceServers, { timeoutMs = 12000 } = {}) {
    const result = { host: 0, srflx: 0, relay: 0, relayVia: null, errors: [], durationMs: 0 };
    const started = Date.now();

    // Deliberately a separate connection — never disturb a call in progress.
    const probe = new RTCPeerConnection({ iceServers: iceServers || [] });

    try {
      probe.onicecandidateerror = (event) => {
        // 701 is the generic "server unreachable"; keep it short and readable.
        result.errors.push(`${event.errorCode}${event.errorText ? ` ${event.errorText}` : ''}`);
      };

      probe.createDataChannel('connectivity-probe');
      await probe.setLocalDescription(await probe.createOffer());

      await new Promise((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        probe.onicecandidate = (event) => {
          if (!event.candidate) { clearTimeout(timer); resolve(); return; }
          const type = event.candidate.type;
          if (result[type] !== undefined) result[type] += 1;
          if (type === 'relay' && !result.relayVia) {
            result.relayVia = event.candidate.address || null;
          }
        };
      });
    } finally {
      try { probe.close(); } catch { /* already closed */ }
      result.durationMs = Date.now() - started;
      result.errors = [...new Set(result.errors)].slice(0, 3);
    }

    return result;
  }

  function getLocalStream() { return localStream; }
  function getRemoteStream() { return remoteStream; }
  function getPeerConnection() { return pc; }
  function getCallId() { return currentCallId; }

  function stopLocalStream() {
    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
      localStream = null;
    }
  }

  function close() {
    stopStatsMonitor();
    pendingCandidates = [];
    makingOffer = false;

    if (pc) {
      pc.ontrack = null;
      pc.onicecandidate = null;
      pc.oniceconnectionstatechange = null;
      pc.onconnectionstatechange = null;
      pc.onnegotiationneeded = null;
      try { pc.close(); } catch { /* already closed */ }
      pc = null;
    }

    remoteStream = null;
    currentCallId = null;
  }

  /** Full teardown, including the microphone (which turns off the OS mic light). */
  function destroy() {
    close();
    stopLocalStream();
  }

  return {
    configure,
    getMicrophone,
    createPeerConnection,
    createOffer,
    createAnswer,
    setRemoteDescription,
    addIceCandidate,
    attemptIceRestart,
    setMuted,
    isMuted,
    setSpeaker,
    testConnectivity,
    getLocalStream,
    getRemoteStream,
    getPeerConnection,
    getCallId,
    stopLocalStream,
    close,
    destroy,
  };
}());
