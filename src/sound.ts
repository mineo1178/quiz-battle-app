let context: AudioContext | null = null;
let enabled = false;
let playbackVersion = 0;
const activeNotes = new Set<() => void>();
const gestureAttempts = new WeakMap<Event, Promise<AudioContext | null>>();

const setAudioSessionType = (type: 'auto' | 'playback') => {
  try {
    const session = (navigator as Navigator & {
      audioSession?: { type: 'auto' | 'playback' };
    }).audioSession;
    if (session && session.type !== type) session.type = type;
  } catch {
    // AudioSession is optional. Web Audio can still work without it.
  }
};

export const cancelSounds = () => {
  playbackVersion++;
  activeNotes.forEach(stop => stop());
};

export const setAudioEnabled = (value: boolean) => {
  enabled = value;
  if (!value) {
    cancelSounds();
    setAudioSessionType('auto');
  }
};

export const getAudioState = () => context?.state ?? '未作成';

const canPlay = (ctx: AudioContext | null): ctx is AudioContext =>
  enabled && !document.hidden && ctx !== null && ctx === context && ctx.state === 'running';

const prepareAudio = async (): Promise<AudioContext | null> => {
  let timeoutId: number | undefined;
  try {
    if (!context || context.state === 'closed') {
      const AudioContextClass = window.AudioContext || (window as Window & {
        webkitAudioContext?: typeof AudioContext;
      }).webkitAudioContext;
      if (!AudioContextClass) return null;

      const created = new AudioContextClass();
      context = created;
      created.addEventListener('statechange', () => {
        if (created === context && created.state !== 'running') cancelSounds();
      });
    }

    const ctx = context;
    if (ctx.state !== 'running') {
      // Call resume synchronously in this click, even if an older click timed out.
      await Promise.race([
        ctx.resume(),
        new Promise<void>(resolve => {
          timeoutId = window.setTimeout(resolve, 1000);
        }),
      ]);
    }
    return canPlay(ctx) ? ctx : null;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeoutId);
  }
};

export const ensureAudioReady = (event: Event): Promise<AudioContext | null> => {
  if (!enabled || document.hidden || !event.isTrusted || event.type !== 'click') {
    return Promise.resolve(null);
  }
  const previous = gestureAttempts.get(event);
  if (previous) return previous;

  setAudioSessionType('playback');
  const attempt = canPlay(context) ? Promise.resolve(context) : prepareAudio();
  gestureAttempts.set(event, attempt);
  return attempt;
};

const scheduleBeep = (
  ctx: AudioContext, freq: number, duration: number, type: OscillatorType, volume: number, start: number,
) => {
  let disconnect: (() => void) | undefined;
  try {
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    const cleanup = () => {
      oscillator.disconnect();
      gainNode.disconnect();
      activeNotes.delete(stop);
    };
    const stop = () => {
      // Disconnect immediately, including notes scheduled for the future.
      cleanup();
      if (ctx.state !== 'closed') oscillator.stop();
    };
    disconnect = cleanup;
    oscillator.type = type;
    oscillator.frequency.value = freq;
    gainNode.gain.setValueAtTime(0, start);
    gainNode.gain.linearRampToValueAtTime(volume, start + 0.01);
    gainNode.gain.exponentialRampToValueAtTime(0.00001, start + duration);
    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);
    oscillator.onended = cleanup;
    oscillator.start(start);
    oscillator.stop(start + duration);
    activeNotes.add(stop);
    return true;
  } catch {
    disconnect?.();
    return false;
  }
};

export const playBeep = (freq: number, duration: number, type: OscillatorType, volume: number) => {
  if (canPlay(context)) scheduleBeep(context, freq, duration, type, volume, context.currentTime);
};

type Note = [frequency: number, duration: number, offset: number];
type PlaybackResult = '再生を開始' | '音声を開始できませんでした' | '効果音OFF';

const playFromClick = async (event: Event, notes: Note[], volume: number): Promise<PlaybackResult> => {
  if (!enabled) return '効果音OFF';
  const version = playbackVersion;
  const ctx = await ensureAudioReady(event);
  if (!enabled) return '効果音OFF';
  if (version !== playbackVersion || !canPlay(ctx)) return '音声を開始できませんでした';

  const start = ctx.currentTime;
  const scheduled = notes.map(([freq, duration, offset]) =>
    scheduleBeep(ctx, freq, duration, 'sine', volume, start + offset),
  );
  return scheduled.every(Boolean) ? '再生を開始' : '音声を開始できませんでした';
};

export const playStartSound = (event: Event) =>
  playFromClick(event, [[523.25, 0.1, 0], [659.25, 0.1, 0.1], [783.99, 0.1, 0.2], [1046.5, 0.3, 0.3]], 0.6);

export const playFinishSound = (event: Event) =>
  playFromClick(event, [[600, 1.5, 0], [600, 2, 0.8]], 1);
