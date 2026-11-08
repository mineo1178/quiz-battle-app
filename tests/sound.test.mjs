import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

let sound;
let instances;
let initialState;
let importCount = 0;
const click = () => ({ type: 'click', isTrusted: true });

class MockAudioContext extends EventTarget {
  state = initialState;
  currentTime = 10;
  resumeCalls = 0;
  starts = [];
  stops = [];
  resumeResult = () => {
    this.state = 'running';
    return Promise.resolve();
  };

  constructor() {
    super();
    instances.push(this);
  }

  resume() {
    this.resumeCalls++;
    return this.resumeResult();
  }

  createOscillator() {
    return {
      frequency: {},
      connect() {},
      disconnect() {},
      start: time => this.starts.push(time),
      stop: time => this.stops.push(time),
    };
  }

  createGain() {
    return {
      gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect() {},
      disconnect() {},
    };
  }
}

beforeEach(async () => {
  instances = [];
  initialState = 'suspended';
  globalThis.window = { AudioContext: MockAudioContext, setTimeout, clearTimeout };
  globalThis.document = { hidden: false };
  sound = await import(`../src/sound.ts?case=${++importCount}`);
  sound.setAudioEnabled(true);
});

test('first trusted click creates one context and resumes before scheduling the melody', async () => {
  sound.playBeep(900, 0.04, 'square', 0.35);
  assert.equal(instances.length, 0);
  const event = click();
  const playback = sound.playStartSound(event);
  const [ctx] = instances;
  assert.equal(ctx.resumeCalls, 1);
  await sound.ensureAudioReady(event);
  assert.equal(await playback, '再生を開始');
  assert.equal(instances.length, 1);
  assert.equal(ctx.resumeCalls, 1);
  assert.deepEqual(ctx.starts, [10, 10.1, 10.2, 10.3]);
});

test('interrupted audio waits for a trusted click after returning to the page', async () => {
  assert.equal(await sound.playStartSound(click()), '再生を開始');
  const [ctx] = instances;
  ctx.state = 'interrupted';
  document.hidden = true;
  sound.cancelSounds();
  assert.equal(ctx.stops.filter(time => time === undefined).length, 4);
  await sound.ensureAudioReady(click());
  document.hidden = false;
  for (const type of ['visibilitychange', 'pageshow', 'focus', 'pointerdown', 'touchend']) {
    await sound.ensureAudioReady({ type, isTrusted: true });
  }
  await sound.ensureAudioReady({ type: 'click', isTrusted: false });
  sound.playBeep(900, 0.04, 'square', 0.35);
  assert.equal(ctx.resumeCalls, 1);
  assert.equal(ctx.starts.length, 4);
  assert.equal(await sound.playStartSound(click()), '再生を開始');
  assert.equal(ctx.resumeCalls, 2);
  assert.equal(ctx.starts.length, 8);
});

test('an unresolved resume does not block a later click or queue old playback after timeout', async () => {
  const ctx = await sound.ensureAudioReady(click());
  ctx.state = 'suspended';
  let resolveOld;
  ctx.resumeResult = () => new Promise(resolve => { resolveOld = resolve; });
  const oldPlayback = sound.playStartSound(click());
  assert.equal(await oldPlayback, '音声を開始できませんでした');
  ctx.resumeResult = () => {
    ctx.state = 'running';
    return Promise.resolve();
  };
  assert.equal(await sound.playStartSound(click()), '再生を開始');
  resolveOld();
  assert.equal(ctx.starts.length, 4);
  assert.equal(instances.length, 1);
});

test('rapid clicks can retry a pending resume and still share one context', async () => {
  const ctx = await sound.ensureAudioReady(click());
  ctx.state = 'suspended';
  let resumeFirst;
  ctx.resumeResult = () => new Promise(resolve => { resumeFirst = resolve; });
  const first = sound.ensureAudioReady(click());
  ctx.resumeResult = () => {
    ctx.state = 'running';
    return Promise.resolve();
  };
  const second = sound.playStartSound(click());
  resumeFirst();
  assert.equal(await first, ctx);
  assert.equal(await second, '再生を開始');
  assert.equal(ctx.resumeCalls, 3);
  assert.equal(instances.length, 1);
});

test('a closed context is replaced only on the next click', async () => {
  const old = await sound.ensureAudioReady(click());
  old.state = 'closed';
  sound.playBeep(220, 0.8, 'sawtooth', 0.8);
  assert.equal(instances.length, 1);
  const event = click();
  const playback = sound.playFinishSound(event);
  const replacement = await sound.ensureAudioReady(event);
  assert.equal(await playback, '再生を開始');
  assert.equal(instances.length, 2);
  assert.equal(replacement, instances[1]);
  assert.equal(replacement.resumeCalls, 1);
  assert.equal(old.resumeCalls, 1);
  assert.deepEqual(old.starts, []);
  assert.deepEqual(instances[1].starts, [10, 10.8]);
});

test('OFF cancels scheduled sounds and ON reuses the context', async () => {
  sound.setAudioEnabled(false);
  assert.equal(await sound.playStartSound(click()), '効果音OFF');
  assert.equal(instances.length, 0);
  sound.setAudioEnabled(true);
  await sound.playStartSound(click());
  const [ctx] = instances;
  sound.setAudioEnabled(false);
  assert.equal(ctx.stops.filter(time => time === undefined).length, 4);
  ctx.state = 'suspended';
  assert.equal(await sound.ensureAudioReady(click()), null);
  assert.equal(await sound.playStartSound(click()), '効果音OFF');
  sound.playBeep(900, 0.04, 'square', 0.35);
  assert.equal(ctx.resumeCalls, 1);
  assert.equal(ctx.starts.length, 4);
  sound.setAudioEnabled(true);
  await sound.playStartSound(click());
  assert.equal(instances.length, 1);
  assert.equal(ctx.starts.length, 8);
});

test('a pending sound is discarded across hide or OFF/ON', async () => {
  const ctx = await sound.ensureAudioReady(click());
  for (const invalidate of [sound.cancelSounds, () => {
    sound.setAudioEnabled(false);
    sound.setAudioEnabled(true);
  }]) {
    ctx.state = 'suspended';
    let resolveResume;
    ctx.resumeResult = () => new Promise(resolve => { resolveResume = resolve; });
    const playback = sound.playStartSound(click());
    invalidate();
    ctx.state = 'running';
    resolveResume();
    assert.equal(await playback, '音声を開始できませんでした');
  }
  assert.deepEqual(ctx.starts, []);
});

test('the test reports failures from resume and oscillator creation', async () => {
  const ctx = await sound.ensureAudioReady(click());
  ctx.state = 'suspended';
  ctx.resumeResult = () => Promise.reject(new Error('Blocked'));
  assert.equal(await sound.playStartSound(click()), '音声を開始できませんでした');
  ctx.state = 'running';
  ctx.createOscillator = () => { throw new Error('Unavailable'); };
  assert.equal(await sound.playStartSound(click()), '音声を開始できませんでした');
});
