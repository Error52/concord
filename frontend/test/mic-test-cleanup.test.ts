import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { Settings } from '../src/state/settings';
import { startMicrophoneTest } from '../src/webrtc/micTest';

function mockGlobal(t: TestContext, name: string, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => { if (previous) Object.defineProperty(globalThis, name, previous); else Reflect.deleteProperty(globalThis, name); });
}

const settings = () => ({ inputDeviceId: 'default', outputDeviceId: 'default', inputVolume: 1, vadThresholdDb: -50, vadAuto: true } as Settings);

test('failed microphone permission closes the audio context and preserves the error', async t => {
  let closed = 0;
  const error = new DOMException('Permission denied', 'NotAllowedError');
  mockGlobal(t, 'AudioContext', class { async close() { closed++; } });
  mockGlobal(t, 'navigator', { mediaDevices: { getUserMedia: async () => { throw error; } } });
  await assert.rejects(startMicrophoneTest(settings, { loopback: false, onLevel() {} }), e => e === error);
  assert.equal(closed, 1);
});

test('failed meter setup releases the live microphone and audio graph', async t => {
  let closed = 0, stopped = 0, disconnected = 0;
  const error = new Error('Audio worklet unavailable');
  const node = () => ({ gain: { value: 0 }, connect() {}, disconnect() { disconnected++; } });
  mockGlobal(t, 'AudioContext', class {
    state = 'running';
    audioWorklet = { addModule: async () => { throw error; } };
    createMediaStreamSource = node;
    createGain = node;
    async close() { closed++; }
  });
  mockGlobal(t, 'navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() { stopped++; } }] }) } });
  await assert.rejects(startMicrophoneTest(settings, { loopback: false, onLevel() {} }), e => e === error);
  assert.equal(stopped, 1);
  assert.equal(closed, 1);
  assert.equal(disconnected, 2);
});

test('successful microphone loopback stops capture, output and meter exactly once', async t => {
  let closed = 0, micStopped = 0, outputStopped = 0, paused = 0;
  const node = () => ({ gain: { value: 0 }, connect() {}, disconnect() {} });
  mockGlobal(t, 'AudioContext', class {
    state = 'running';
    audioWorklet = { addModule: async () => {} };
    createMediaStreamSource = node;
    createGain = node;
    createMediaStreamDestination = () => ({ stream: { getTracks: () => [{ stop() { outputStopped++; } }] } });
    async close() { closed++; }
  });
  mockGlobal(t, 'AudioWorkletNode', class { port = { onmessage: null }; });
  mockGlobal(t, 'Audio', class { srcObject = null; async play() {} pause() { paused++; } });
  mockGlobal(t, 'navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() { micStopped++; } }] }) } });
  const capture = await startMicrophoneTest(settings, { loopback: true, onLevel() {} });
  capture.stop(); capture.stop();
  assert.deepEqual({ closed, micStopped, outputStopped, paused }, { closed: 1, micStopped: 1, outputStopped: 1, paused: 1 });
});

test('cancelling while a worklet is loading releases capture before the pending module resolves', async t => {
  let closed = 0, stopped = 0;
  let resolveModule!: () => void;
  const module = new Promise<void>(resolve => { resolveModule = resolve; });
  const node = () => ({ gain: { value: 0 }, connect() {}, disconnect() {} });
  t.mock.method(URL, 'createObjectURL', () => 'blob:test');
  t.mock.method(URL, 'revokeObjectURL', () => {});
  mockGlobal(t, 'AudioContext', class {
    state = 'running'; audioWorklet = { addModule: () => module };
    createMediaStreamSource = node; createGain = node;
    async close() { closed++; }
  });
  mockGlobal(t, 'AudioWorkletNode', class { port = { onmessage: null }; });
  mockGlobal(t, 'navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() { stopped++; } }] }) } });
  const controller = new AbortController();
  const pending = startMicrophoneTest(settings, { loopback: false, onLevel() {}, signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  assert.equal(stopped, 1); assert.equal(closed, 1);
  resolveModule();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(stopped, 1); assert.equal(closed, 1);
});

test('permission resolving after cancellation immediately stops the new microphone stream', async t => {
  let closed = 0, stopped = 0;
  let resolvePermission!: (stream: unknown) => void;
  mockGlobal(t, 'AudioContext', class { async close() { closed++; } });
  mockGlobal(t, 'navigator', { mediaDevices: { getUserMedia: () => new Promise(resolve => { resolvePermission = resolve; }) } });
  const controller = new AbortController();
  const pending = startMicrophoneTest(settings, { loopback: false, onLevel() {}, signal: controller.signal });
  controller.abort();
  resolvePermission({ getTracks: () => [{ stop() { stopped++; } }] });
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(stopped, 1); assert.equal(closed, 1);
});
