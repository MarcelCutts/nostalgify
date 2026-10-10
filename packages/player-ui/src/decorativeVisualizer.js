// Feed Webamp a silent synthetic rhythm while the active provider is playing.
// This animation is decorative; it does not analyse Spotify or SoundCloud audio.
export function createDecorativeVisualizer({ enabled = true } = {}) {
  if (!enabled) {
    return {
      analyser: {
        fftSize: 2048, frequencyBinCount: 1024,
        getByteFrequencyData: (data) => data.fill(0),
        getByteTimeDomainData: (data) => data.fill(128),
      },
      setPlaying() {},
    };
  }
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.6;

  // Analyser output goes to a muted node so the graph is processed but silent.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  analyser.connect(mute);
  mute.connect(ctx.destination);

  const master = ctx.createGain();
  master.gain.value = 0;
  master.connect(analyser);

  // White noise buffer for hats and snares.
  const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

  // Three sustained chord tones whose pitches wander.
  const chord = [0, 1, 2].map(() => {
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    const g = ctx.createGain();
    g.gain.value = 0.08;
    osc.connect(g).connect(master);
    osc.start();
    return osc;
  });

  const ROOTS = [110, 130.8, 146.8, 164.8, 98];
  function newChord(t) {
    const root = ROOTS[Math.floor(Math.random() * ROOTS.length)];
    [1, 1.26, 1.5].forEach((ratio, i) => {
      const oct = Math.random() < 0.4 ? 2 : 1;
      chord[i].frequency.setTargetAtTime(root * ratio * oct, t, 0.05);
    });
  }

  function kick(t) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.setValueAtTime(140, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.15);
    g.gain.setValueAtTime(1, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    osc.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + 0.3);
  }

  function hat(t, level, cutoff) {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = cutoff;
    const g = ctx.createGain();
    g.gain.setValueAtTime(level, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    src.connect(hp).connect(g).connect(master);
    src.start(t, Math.random() * 0.5);
    src.stop(t + 0.15);
  }

  let playing = false;
  let step = 0;
  const STEP = 60 / 120 / 2; // eighth notes at 120 bpm
  setInterval(() => {
    if (!playing) return;
    const t = ctx.currentTime + 0.02;
    if (step % 2 === 0) kick(t);
    else hat(t, 0.35, 6000);
    if (step % 4 === 2) hat(t, 0.6, 1500); // snare-ish
    if (step % 16 === 0) newChord(t);
    step++;
  }, STEP * 1000);

  return {
    analyser,
    setPlaying(on) {
      playing = on;
      if (ctx.state === "suspended") ctx.resume();
      master.gain.setTargetAtTime(on ? 0.9 : 0, ctx.currentTime, 0.05);
    },
  };
}
