/* ==========================================================================
   Audio helpers: ringtone / ringback / tones synthesised with Web Audio, plus
   voice-activity detection. Nothing here needs a binary asset.
   ========================================================================== */
'use strict';

window.AudioKit = (function audioKit() {
  let ctx = null;
  let activePattern = null;

  /** Oscillators scheduled but not yet finished, so they can be cut short. */
  const voices = new Set();

  /**
   * Browsers refuse to start an AudioContext before a user gesture. We create
   * it lazily and resume on demand; the first tap anywhere unlocks it.
   */
  function context() {
    if (!ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  function unlock() { context(); }

  /** One beep. `gain` is kept low — these play close to the user's ear. */
  function tone({ freq = 440, duration = 0.2, gain = 0.12, type = 'sine', at = 0 }) {
    const audio = context();
    if (!audio) return;

    const start = audio.currentTime + at;
    const osc = audio.createOscillator();
    const amp = audio.createGain();

    osc.type = type;
    osc.frequency.value = freq;

    // Ramped envelope; a hard start/stop produces an audible click.
    amp.gain.setValueAtTime(0, start);
    amp.gain.linearRampToValueAtTime(gain, start + 0.015);
    amp.gain.setValueAtTime(gain, start + Math.max(0.02, duration - 0.03));
    amp.gain.linearRampToValueAtTime(0, start + duration);

    osc.connect(amp).connect(audio.destination);
    osc.start(start);
    osc.stop(start + duration + 0.02);

    // Keep the gain node reachable so an early stop can fade instead of clip.
    osc.__amp = amp;

    // A ring pattern schedules each burst up to ~0.9s ahead of real time.
    // Clearing the interval alone would leave those queued oscillators to fire,
    // so the ringtone would keep sounding over the first second of a call that
    // has already been answered. Track them so they can be silenced properly.
    voices.add(osc);
    osc.onended = () => voices.delete(osc);
  }

  /**
   * Stops the repeating pattern AND anything already queued, ramping the gain
   * down over 20 ms rather than cutting the waveform mid-cycle (which clicks).
   */
  function stopPattern() {
    if (activePattern) {
      clearInterval(activePattern);
      activePattern = null;
    }

    const audio = ctx;
    if (!audio) return;
    const now = audio.currentTime;

    voices.forEach((osc) => {
      try {
        const amp = osc.__amp;
        if (amp) {
          amp.gain.cancelScheduledValues(now);
          amp.gain.setValueAtTime(amp.gain.value, now);
          amp.gain.linearRampToValueAtTime(0, now + 0.02);
        }
        osc.stop(now + 0.03);
      } catch {
        // Already stopped, or never started — nothing left to silence.
      }
    });
    voices.clear();
  }

  /** Incoming-call ringtone: a repeating two-note trill. */
  function startRingtone() {
    stopPattern();
    const ring = () => {
      for (let i = 0; i < 2; i += 1) {
        tone({ freq: 784, duration: 0.16, gain: 0.14, at: i * 0.42 });
        tone({ freq: 988, duration: 0.16, gain: 0.12, at: i * 0.42 + 0.18 });
      }
    };
    ring();
    activePattern = setInterval(ring, 2400);
  }

  /** Outgoing ringback: the familiar long, sparse burst. */
  function startRingback() {
    stopPattern();
    const ring = () => {
      tone({ freq: 440, duration: 0.9, gain: 0.06 });
      tone({ freq: 480, duration: 0.9, gain: 0.06 });
    };
    ring();
    activePattern = setInterval(ring, 3200);
  }

  const stopRinging = stopPattern;

  function playConnected() {
    stopPattern();
    tone({ freq: 660, duration: 0.1, gain: 0.1 });
    tone({ freq: 880, duration: 0.14, gain: 0.1, at: 0.1 });
  }

  function playEnded() {
    stopPattern();
    tone({ freq: 480, duration: 0.13, gain: 0.09 });
    tone({ freq: 360, duration: 0.2, gain: 0.09, at: 0.13 });
  }

  function playBusy() {
    stopPattern();
    for (let i = 0; i < 3; i += 1) {
      tone({ freq: 480, duration: 0.22, gain: 0.1, at: i * 0.45 });
      tone({ freq: 620, duration: 0.22, gain: 0.08, at: i * 0.45 });
    }
  }

  /** DTMF-ish keypad feedback. */
  const DTMF = {
    1: [697, 1209], 2: [697, 1336], 3: [697, 1477],
    4: [770, 1209], 5: [770, 1336], 6: [770, 1477],
    7: [852, 1209], 8: [852, 1336], 9: [852, 1477],
    '*': [941, 1209], 0: [941, 1336], '#': [941, 1477],
  };

  function playKey(key) {
    const pair = DTMF[key];
    if (!pair) return;
    tone({ freq: pair[0], duration: 0.09, gain: 0.05 });
    tone({ freq: pair[1], duration: 0.09, gain: 0.05 });
  }

  function vibrate(pattern) {
    if (navigator.vibrate) {
      try { navigator.vibrate(pattern); } catch { /* unsupported */ }
    }
  }

  /* ------------------------------------------------------------------------
     Voice activity detection
     ------------------------------------------------------------------------ */

  /**
   * Attaches an analyser to a MediaStream and reports smoothed RMS level plus
   * a speaking/not-speaking flag.
   *
   * The threshold uses hysteresis (a higher bar to start speaking than to stop)
   * so a voice hovering near the cutoff does not flicker the indicator.
   */
  function createVoiceDetector(stream, { onLevel, intervalMs = 90 } = {}) {
    const audio = context();
    if (!audio || !stream || !stream.getAudioTracks().length) {
      return { stop() {} };
    }

    const source = audio.createMediaStreamSource(stream);
    const analyser = audio.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);

    const buffer = new Float32Array(analyser.fftSize);
    const SPEAK_ON = 0.035;
    const SPEAK_OFF = 0.018;
    let speaking = false;
    let smoothed = 0;

    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(buffer);

      let sum = 0;
      for (let i = 0; i < buffer.length; i += 1) sum += buffer[i] * buffer[i];
      const rms = Math.sqrt(sum / buffer.length);

      // Exponential smoothing keeps the meter from jittering frame to frame.
      smoothed = smoothed * 0.6 + rms * 0.4;

      if (!speaking && smoothed > SPEAK_ON) speaking = true;
      else if (speaking && smoothed < SPEAK_OFF) speaking = false;

      // Map RMS onto a perceptually reasonable 0-100 bar.
      const level = Math.min(100, Math.round((smoothed / 0.18) * 100));
      if (onLevel) onLevel(level, speaking);
    }, intervalMs);

    return {
      stop() {
        clearInterval(timer);
        try { source.disconnect(); } catch { /* already torn down */ }
      },
    };
  }

  return {
    unlock,
    startRingtone,
    startRingback,
    stopRinging,
    playConnected,
    playEnded,
    playBusy,
    playKey,
    vibrate,
    createVoiceDetector,
  };
}());
