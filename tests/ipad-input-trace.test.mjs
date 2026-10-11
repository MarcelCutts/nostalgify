import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Execute the exact Swift-injected source, without a second probe implementation.
const swift = readFileSync(new URL('../apps/ipad/ios/App/App/Native/NativeUITestFixture.swift', import.meta.url), 'utf8');
const source = swift.match(/static let script = #"""\n([\s\S]*?)\n\s*"""#/)?.[1];
assert.ok(source, 'the fixture contains its executable input probe');

class Element {
  constructor(id, parent = null) { this.id = id; this.parent = parent; }
  closest(selector) {
    assert.equal(selector, '#local-source, #spotify-source, #play-button');
    return ['local-source', 'spotify-source', 'play-button'].includes(this.id) ? this : this.parent?.closest(selector) ?? null;
  }
  getAttribute(name) {
    assert.ok(['aria-pressed', 'aria-label'].includes(name));
    return name === 'aria-label' ? this.label : this.pressed;
  }
  get textContent() { throw new Error('probe must not read page text'); }
  getBoundingClientRect() { throw new Error('probe must not force layout'); }
}

function fixture({ channel = 'working', present = true } = {}) {
  const messages = [];
  const listeners = [];
  const files = new Element('local-source');
  files.disabled = false;
  files.pressed = 'false';
  const play = new Element('play-button');
  play.label = 'Play';
  const observers = [];
  class MutationObserver {
    constructor(callback) { this.callback = callback; this.active = true; observers.push(this); }
    observe(element, options) {
      assert.equal(options.attributes, true);
      assert.deepEqual([...options.attributeFilter], [element === play ? 'aria-label' : 'aria-pressed']);
    }
    disconnect() { this.active = false; }
  }
  const document = {
    getElementById(id) {
      assert.ok(['local-source', 'play-button'].includes(id));
      return id === 'play-button' ? play : present ? files : null;
    },
    addEventListener(type, callback, options) {
      assert.equal(options.passive, true, 'observation cannot cancel input');
      listeners.push({ type, callback, capture: options.capture });
    },
    removeEventListener(type, callback, capture) {
      const index = listeners.findIndex(value => value.type === type && value.callback === callback && value.capture === capture);
      if (index !== -1) listeners.splice(index, 1);
    },
  };
  const window = channel === 'missing' ? {} : { webkit: { messageHandlers: { nostalgifyUITestInput: {
    postMessage(value) {
      if (channel === 'throwing') throw new Error('private bridge error');
      messages.push(JSON.parse(JSON.stringify(value)));
    },
  } } } };
  vm.runInNewContext(source, { document, window, Element, MutationObserver, performance: { now: () => 120.25 } });
  return {
    messages, listeners, files, play, observers,
    flushMutations() { for (const observer of observers) if (observer.active) observer.callback(); },
    emit(type, extra = {}, applicationHandler = () => {}) {
      const event = { type, target: files, clientX: 903, clientY: 216, isTrusted: true, defaultPrevented: false,
        preventDefault() { throw new Error('probe must not cancel input'); },
        stopPropagation() { throw new Error('probe must not stop input'); }, ...extra };
      for (const item of [...listeners]) if (item.type === type && item.capture) item.callback(event);
      applicationHandler(event);
      for (const item of [...listeners]) if (item.type === type && !item.capture) item.callback(event);
    },
  };
}

test('probe announces readiness and preserves an empty input trace', () => {
  const f = fixture();
  assert.deepEqual(f.messages, [{ ready: true }]);
  assert.equal(f.listeners.length, 8);
});

test('capture and bubble report the synchronous Files handler outcome without changing it', () => {
  const f = fixture();
  let calls = 0;
  f.emit('click', {}, () => { calls++; f.files.pressed = 'true'; });
  assert.equal(calls, 1);
  assert.deepEqual(f.messages.slice(1).map(({ phase, target, filesPressed }) => ({ phase, target, filesPressed })), [
    { phase: 'capture', target: 'files', filesPressed: false },
    { phase: 'bubble', target: 'files', filesPressed: true },
  ]);
  assert.equal(f.files.pressed, 'true');
});

test('trace stops at 32 input records and removes every passive listener', () => {
  const f = fixture();
  for (let i = 0; i < 50; i++) f.emit('pointerdown');
  assert.equal(f.messages.length, 33, 'one readiness message plus 32 records');
  assert.equal(f.listeners.length, 0);
  assert.equal(f.observers[0].active, false);
  f.emit('click', {}, () => { f.files.pressed = 'true'; });
  assert.equal(f.files.pressed, 'true', 'the application still receives input after the cap');
  assert.equal(f.messages.length, 33);
});

test('touch completion uses changedTouches and normalizes missing or unsafe coordinates', () => {
  const f = fixture();
  f.emit('touchend', { changedTouches: [{ clientX: 0, clientY: 216 }], clientX: undefined, clientY: undefined });
  f.emit('pointercancel', { clientX: Infinity, clientY: -20000 });
  assert.deepEqual(f.messages.slice(1).map(({ x, y }) => ({ x, y })), [{ x: 0, y: 216 }, { x: null, y: null }]);
});

test('target and Files state contain only fixed identities and booleans', () => {
  const f = fixture();
  f.files.pressed = 'private value';
  f.emit('pointerup', { target: new Element('private song'), isTrusted: false });
  f.emit('click', { target: new Element('private child', new Element('spotify-source')) }, event => { event.defaultPrevented = true; });
  assert.equal(f.messages[1].target, 'other');
  assert.equal(f.messages[1].filesPressed, null);
  assert.equal(f.messages[1].trusted, false);
  assert.equal(f.messages[2].target, 'spotify');
  assert.equal(f.messages[2].defaultPrevented, false);
  assert.equal(f.messages[3].defaultPrevented, true);
  assert.doesNotMatch(JSON.stringify(f.messages), /private/);
  assert.deepEqual(Object.keys(f.messages[1]).sort(), ['event', 'phase', 'target', 'timeMs', 'x', 'y', 'trusted',
    'defaultPrevented', 'filesDisabled', 'filesPressed', 'playLabel'].sort());
});

test('state observers record outcomes once and ignore repeated native polling values', () => {
  const f = fixture();
  for (let i = 0; i < 50; i++) f.flushMutations();
  assert.equal(f.messages.length, 1, 'unchanged startup/polling state consumes no records');
  f.files.pressed = 'true';
  f.play.label = 'Pause';
  f.flushMutations();
  for (let i = 0; i < 50; i++) f.flushMutations();
  assert.deepEqual(f.messages.slice(1).map(({ event, phase, target, trusted, x }) => ({ event, phase, target, trusted, x })), [
    { event: 'files-state', phase: 'mutation', target: 'files', trusted: null, x: null },
    { event: 'play-state', phase: 'mutation', target: 'play', trusted: null, x: null },
  ]);
  f.emit('click', { target: f.play }, () => { f.play.label = 'Play'; });
  f.flushMutations();
  assert.deepEqual(f.messages.slice(3).map(({ target, playLabel }) => ({ target, playLabel })), [
    { target: 'play', playLabel: 'Pause' }, { target: 'play', playLabel: 'Play' }, { target: 'play', playLabel: 'Play' },
  ]);
  f.play.label = 'private track title';
  f.flushMutations();
  assert.equal(f.messages.at(-1).playLabel, 'other');
  assert.doesNotMatch(JSON.stringify(f.messages), /private/);
});

test('missing Files is observable and unavailable native transport does not affect application input', () => {
  const missing = fixture({ present: false });
  missing.emit('touchcancel');
  assert.equal(missing.messages[1].filesDisabled, null);
  assert.equal(missing.messages[1].filesPressed, null);
  for (const channel of ['missing', 'throwing']) {
    const f = fixture({ channel });
    assert.equal(f.listeners.length, 0);
    assert.equal(f.observers[0].active, false);
    f.emit('click', {}, () => { f.files.pressed = 'true'; });
    assert.equal(f.files.pressed, 'true');
  }
});
