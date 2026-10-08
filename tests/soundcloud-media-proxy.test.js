const test = require('node:test');
const assert = require('node:assert/strict');
const { createMediaProxy } = require('../src/main/soundcloud/media-proxy');

const SECRET = 'private-oauth-token';
const PLAYLIST = '#EXTM3U\n#EXTINF:4,\nsegment.ts?signature=private\n#EXT-X-ENDLIST\n';

function fixture(responder) {
  const calls = [];
  let tokenReads = 0;
  const proxy = createMediaProxy({
    fetch: async (url, options) => {
      calls.push({ url, ...options });
      return responder(url, options, calls.length);
    },
    getAccessToken: async () => { tokenReads++; return SECRET; },
  });
  return { proxy, calls, get tokenReads() { return tokenReads; } };
}

function manifest(text = PLAYLIST) {
  return new Response(text, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
}

function links(text) {
  return text.match(/soundcloud-media:\/\/local\/[a-f0-9]{48}/g) || [];
}

test('API redirects authenticate only the API host and expose only opaque manifest links', async () => {
  const setup = fixture((_url, _options, call) => call === 1
    ? new Response(null, { status: 302, headers: { Location: 'https://cf-media.sndcdn.com/folder/index.m3u8?signed=private' } })
    : manifest());
  const url = setup.proxy.register('https://api.soundcloud.com/tracks/123/stream');
  assert.match(url, /^soundcloud-media:\/\/local\/[a-f0-9]{48}$/);
  const response = await setup.proxy.handle(new Request(url));
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.equal(setup.calls[0].headers.get('authorization'), `OAuth ${SECRET}`);
  assert.equal(setup.calls[1].headers.get('authorization'), null);
  assert.equal(setup.calls[0].redirect, 'manual');
  assert.equal(setup.calls[1].credentials, 'omit');
  assert.equal(setup.tokenReads, 1);
  assert.equal(links(body).length, 1);
  assert.doesNotMatch(body, /private|https:|api\.soundcloud|sndcdn/);
  assert.doesNotMatch(JSON.stringify([...response.headers]), /private|OAuth|location/i);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
});

test('API JSON indirection reaches the official AAC host without credentials', async () => {
  const setup = fixture((_url, _options, call) => call === 1
    ? Response.json({ url: 'https://playback.media-streaming.soundcloud.cloud/media/index.m3u8?token=signed' })
    : manifest());
  const response = await setup.proxy.handle(new Request(setup.proxy.register('https://api.soundcloud.com/tracks/123/stream')));
  assert.equal(response.status, 200);
  assert.equal(links(await response.text()).length, 1);
  assert.equal(setup.calls[1].headers.get('authorization'), null);
});

test('master playlists, renditions, keys, init maps and relative segments stay behind the proxy', async () => {
  const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="../audio/index.m3u8?auth=private"\n'
    + '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100,URI="iframe.m3u8"\n'
    + '#EXT-X-STREAM-INF:BANDWIDTH=1000\nvariant/index.m3u8\n';
  const media = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="../key.bin?key=private"\n'
    + '#EXT-X-MAP:URI="init.mp4"\n#EXT-X-PART:DURATION=0.5,URI="part.m4s"\n'
    + '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="next.m4s"\n'
    + '#EXT-X-RENDITION-REPORT:URI="../other/index.m3u8"\n#EXTINF:4,\nsegment.m4s\n';
  const setup = fixture((url) => url.includes('/master.m3u8') ? manifest(master)
    : url.includes('/variant/index.m3u8') ? manifest(media)
      : new Response('binary', { headers: { 'Content-Type': 'application/octet-stream' } }));
  const top = await setup.proxy.handle(new Request(setup.proxy.register('https://cf-media.sndcdn.com/set/master.m3u8')));
  const topText = await top.text();
  assert.equal(links(topText).length, 3);
  assert.doesNotMatch(topText, /https:|private/);
  const second = await setup.proxy.handle(new Request(links(topText)[2]));
  const secondText = await second.text();
  assert.equal(links(secondText).length, 6);
  assert.doesNotMatch(secondText, /private|https:/);
  assert.equal(setup.calls[1].url, 'https://cf-media.sndcdn.com/set/variant/index.m3u8');
  for (const index of [0, 1, 2, 3, 5]) {
    const response = await setup.proxy.handle(new Request(links(secondText)[index]));
    assert.equal(await response.text(), 'binary');
  }
  assert.equal(setup.calls[2].url, 'https://cf-media.sndcdn.com/set/key.bin?key=private');
  assert.equal(setup.calls[3].url, 'https://cf-media.sndcdn.com/set/variant/init.mp4');
  assert.equal(setup.calls[6].url, 'https://cf-media.sndcdn.com/set/variant/segment.m4s');
  assert.equal(setup.tokenReads, 0);
});

test('rejects non-HTTPS, credentials, local hosts, ports, and deceptive hostnames before fetching', () => {
  const setup = fixture(() => { throw new Error('must not fetch'); });
  for (const url of [
    'http://api.soundcloud.com/track', 'https://localhost/track', 'https://127.0.0.1/track',
    'https://169.254.169.254/', 'file:///tmp/track', 'data:audio/mpeg;base64,AA',
    'https://api.soundcloud.com.attacker.test/a', 'https://evil-sndcdn.com/a',
    'https://evil.soundcloud.cloud/a', 'https://api.soundcloud.com:443/a',
    'https://api.soundcloud.com:8080/a', 'https://user:secret@api.soundcloud.com/a',
    'https://cf-media.sndcdn.com\\@attacker.test/a', 'https://cf-media.sndcdn.com/white space',
  ]) assert.throws(() => setup.proxy.register(url), /SoundCloud media is unavailable/);
  assert.equal(setup.calls.length, 0);
});

test('hostile redirects and JSON URLs are never fetched', async () => {
  for (const source of ['redirect', 'json']) {
    const setup = fixture(() => source === 'redirect'
      ? new Response(null, { status: 302, headers: { Location: 'https://attacker.test/?private=secret' } })
      : Response.json({ url: 'https://127.0.0.1/private' }));
    const response = await setup.proxy.handle(new Request(setup.proxy.register('https://api.soundcloud.com/tracks/1/stream')));
    assert.equal(response.status, 502);
    assert.equal(setup.calls.length, 1);
    assert.equal(await response.text(), 'SoundCloud media is unavailable.');
  }
});

test('credential query parameters are rejected on registration and every indirection path', async () => {
  for (const key of ['oauth_token', 'ACCESS_TOKEN', 'client_secret', 'Authorization']) {
    const target = `https://cf-media.sndcdn.com/index.m3u8?${key}=${SECRET}`;
    const direct = fixture(() => manifest());
    assert.throws(() => direct.proxy.register(target), /SoundCloud media is unavailable/);
    for (const kind of ['redirect', 'json', 'manifest']) {
      const setup = fixture(() => kind === 'redirect'
        ? new Response(null, { status: 302, headers: { Location: target } })
        : kind === 'json' ? Response.json({ url: target }) : manifest(`#EXTM3U\n${target}\n`));
      const response = await setup.proxy.handle(new Request(setup.proxy.register('https://api.soundcloud.com/tracks/1/stream')));
      assert.equal(response.status, 502);
      assert.equal(setup.calls.length, 1);
      assert.equal(await response.text(), 'SoundCloud media is unavailable.');
    }
  }
});

test('hostile manifest resources and malformed URI attributes fail without exposing upstream content', async () => {
  for (const line of [
    'https://attacker.test/private', '#EXT-X-KEY:METHOD=AES-128,URI="http://127.0.0.1/key"',
    '#EXT-X-MAP:URI="data:application/octet-stream;base64,AA"',
    '#EXT-X-KEY:URI=https://cf-media.sndcdn.com/key',
  ]) {
    const setup = fixture(() => manifest(`#EXTM3U\n${line}\n`));
    const response = await setup.proxy.handle(new Request(setup.proxy.register('https://cf-media.sndcdn.com/playlist.m3u8')));
    assert.equal(response.status, 502);
    assert.equal(await response.text(), 'SoundCloud media is unavailable.');
  }
});

test('binary byte ranges preserve status and media headers, without forwarding renderer credentials', async () => {
  const setup = fixture(() => new Response('abc', {
    status: 206,
    headers: { 'Content-Type': 'audio/aac', 'Content-Range': 'bytes 4-6/10',
      'Content-Length': '3', 'Accept-Ranges': 'bytes', 'Set-Cookie': 'private=secret',
      Location: 'https://cf-media.sndcdn.com/private', 'X-Debug-Token': SECRET },
  }));
  const response = await setup.proxy.handle(new Request(setup.proxy.register('https://cf-media.sndcdn.com/segment.aac', 'audio'), {
    headers: { Range: 'bytes=4-6', Authorization: 'Bearer renderer-value', Cookie: 'renderer-cookie', Origin: 'https://untrusted.test' },
  }));
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 4-6/10');
  assert.equal(response.headers.get('content-type'), 'audio/aac');
  assert.equal(response.headers.get('content-length'), '3');
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('location'), null);
  assert.equal(response.headers.get('x-debug-token'), null);
  assert.equal(await response.text(), 'abc');
  assert.deepEqual([...setup.calls[0].headers], [['range', 'bytes=4-6']]);
});

test('invalid or multipart ranges fail before an upstream request', async () => {
  const setup = fixture(() => new Response('audio'));
  const url = setup.proxy.register('https://cf-media.sndcdn.com/segment.aac', 'audio');
  for (const range of ['bytes=9-1', 'bytes=-0', 'bytes=-', 'items=1-2', 'bytes=0-1,4-5', 'bytes=9999999999999999-']) {
    const response = await setup.proxy.handle(new Request(url, { headers: { range } }));
    assert.equal(response.status, 400);
  }
  assert.equal(setup.calls.length, 0);
});

test('HEAD and CORS preflight have no body and unsupported methods are rejected', async () => {
  const setup = fixture(() => new Response('audio', { headers: { 'Content-Type': 'audio/mpeg' } }));
  const url = setup.proxy.register('https://cf-media.sndcdn.com/segment.mp3', 'audio');
  const head = await setup.proxy.handle(new Request(url, { method: 'HEAD' }));
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const options = await setup.proxy.handle(new Request(url, { method: 'OPTIONS' }));
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('access-control-allow-headers'), 'Range');
  assert.equal((await setup.proxy.handle(new Request(url, { method: 'POST' }))).status, 405);
  assert.equal(setup.calls.length, 1);
});

test('clear revokes existing links and creates new opaque links on registration', async () => {
  const setup = fixture(() => manifest());
  const source = 'https://cf-media.sndcdn.com/playlist.m3u8';
  const first = setup.proxy.register(source);
  assert.equal(setup.proxy.register(source), first);
  const response = await setup.proxy.handle(new Request(first));
  const segment = links(await response.text())[0];
  setup.proxy.clear();
  assert.equal((await setup.proxy.handle(new Request(first))).status, 404);
  assert.equal((await setup.proxy.handle(new Request(segment))).status, 404);
  assert.notEqual(setup.proxy.register(source), first);
  assert.equal(setup.calls.length, 1);
});

test('clear during a manifest fetch prevents stale resources from registering', async () => {
  let finish;
  const setup = fixture(() => new Promise((resolve) => { finish = resolve; }));
  const request = setup.proxy.handle(new Request(setup.proxy.register('https://cf-media.sndcdn.com/playlist.m3u8')));
  assert.equal(setup.calls.length, 1);
  setup.proxy.clear();
  assert.equal(setup.calls[0].signal.aborted, true);
  finish(manifest());
  const response = await request;
  assert.equal(response.status, 502);
  assert.equal(links(await response.text()).length, 0);
});

test('clear while token acquisition is pending prevents an authenticated fetch', async () => {
  let finish;
  let requests = 0;
  const proxy = createMediaProxy({ fetch: async () => { requests++; return manifest(); },
    getAccessToken: () => new Promise((resolve) => { finish = resolve; }) });
  const pending = proxy.handle(new Request(proxy.register('https://api.soundcloud.com/tracks/1/stream')));
  proxy.clear();
  finish(SECRET);
  assert.equal((await pending).status, 502);
  assert.equal(requests, 0);
});

test('clear invalidates an in-progress binary stream', async () => {
  let push;
  const setup = fixture(() => new Response(new ReadableStream({ start(controller) { push = controller; } })));
  const response = await setup.proxy.handle(new Request(setup.proxy.register('https://cf-media.sndcdn.com/audio.aac', 'audio')));
  const body = response.text();
  setup.proxy.clear();
  push.enqueue(new Uint8Array([1, 2]));
  await assert.rejects(body, /SoundCloud media is unavailable/);
});

test('caps redirect and JSON indirection loops', async () => {
  for (const json of [false, true]) {
    const setup = fixture(() => json ? Response.json({ url: 'https://api.soundcloud.com/tracks/1/stream' })
      : new Response(null, { status: 307, headers: { Location: '/loop' } }));
    const response = await setup.proxy.handle(new Request(setup.proxy.register('https://api.soundcloud.com/tracks/1/stream')));
    assert.equal(response.status, 502);
    assert.equal(setup.calls.length, 6);
  }
});

test('timeouts cover stalled token acquisition, fetch and manifest bodies', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const stalledAt of ['token', 'fetch', 'body']) {
    const proxy = createMediaProxy({
      getAccessToken: () => stalledAt === 'token' ? new Promise(() => {}) : SECRET,
      fetch: () => stalledAt === 'fetch' ? new Promise(() => {})
        : new Response(new ReadableStream({ start() {} })),
    });
    const request = proxy.handle(new Request(proxy.register('https://api.soundcloud.com/tracks/1/stream')));
    await new Promise(setImmediate);
    t.mock.timers.tick(30000);
    const response = await request;
    assert.equal(response.status, 502, stalledAt);
    assert.equal(await response.text(), 'SoundCloud media is unavailable.');
  }
});

test('progressing binary audio survives beyond the setup deadline and releases its idle timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let headers;
  let source;
  const setup = fixture(() => new Promise((resolve) => { headers = resolve; }));
  const pending = setup.proxy.handle(new Request(setup.proxy.register('https://cf-media.sndcdn.com/audio.aac', 'audio')));
  t.mock.timers.tick(25000);
  headers(new Response(new ReadableStream({ start(controller) { source = controller; } }), {
    headers: { 'Content-Type': 'audio/aac' },
  }));
  const response = await pending;
  const reader = response.body.getReader();
  for (let index = 0; index < 4; index++) {
    const chunk = reader.read();
    t.mock.timers.tick(20000);
    assert.equal(setup.calls[0].signal.aborted, false);
    source.enqueue(new Uint8Array([index]));
    assert.deepEqual(await chunk, { value: new Uint8Array([index]), done: false });
  }
  source.close();
  assert.equal((await reader.read()).done, true);
  // A completed transfer must not retain a timer that later aborts its fetch.
  t.mock.timers.tick(30000);
  assert.equal(setup.calls[0].signal.aborted, false);
});

test('binary audio that stops progressing aborts and cancels its upstream body', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let source;
  let canceled = 0;
  const setup = fixture(() => new Response(new ReadableStream({
    start(controller) { source = controller; },
    cancel() { canceled++; },
  }), { headers: { 'Content-Type': 'audio/aac' } }));
  const response = await setup.proxy.handle(new Request(setup.proxy.register('https://cf-media.sndcdn.com/audio.aac', 'audio')));
  const reader = response.body.getReader();
  const first = reader.read();
  t.mock.timers.tick(20000);
  source.enqueue(new Uint8Array([1]));
  assert.deepEqual(await first, { value: new Uint8Array([1]), done: false });
  const stalled = reader.read();
  const rejected = assert.rejects(stalled, /SoundCloud media is unavailable/);
  t.mock.timers.tick(29999);
  assert.equal(setup.calls[0].signal.aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(setup.calls[0].signal.aborted, true);
  assert.equal(canceled, 1);
});

test('manifest progress does not extend its bounded setup deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let source;
  let canceled = false;
  const setup = fixture(() => new Response(new ReadableStream({
    start(controller) { source = controller; },
    cancel() { canceled = true; },
  }), { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } }));
  const pending = setup.proxy.handle(new Request(setup.proxy.register('https://cf-media.sndcdn.com/playlist.m3u8')));
  await new Promise(setImmediate);
  for (let index = 0; index < 2; index++) {
    t.mock.timers.tick(10000);
    source.enqueue(new TextEncoder().encode(index === 0 ? '#EXTM3U\n' : '#EXTINF:4,\n'));
    await new Promise(setImmediate);
  }
  t.mock.timers.tick(10000);
  const response = await pending;
  assert.equal(response.status, 502);
  assert.equal(await response.text(), 'SoundCloud media is unavailable.');
  assert.equal(setup.calls[0].signal.aborted, true);
  assert.equal(canceled, true);
});

test('compressed binary bodies do not forward an incorrect compressed Content-Length', async () => {
  const setup = fixture(() => new Response('decoded audio', {
    headers: { 'Content-Type': 'audio/aac', 'Content-Encoding': 'gzip', 'Content-Length': '3' },
  }));
  const response = await setup.proxy.handle(new Request(setup.proxy.register('https://cf-media.sndcdn.com/audio.aac', 'audio')));
  assert.equal(response.headers.get('content-length'), null);
  assert.equal(response.headers.get('content-encoding'), null);
  assert.equal(await response.text(), 'decoded audio');
});

test('caps manifest bytes with and without Content-Length', async () => {
  for (const explicitLength of [false, true]) {
    const setup = fixture(() => new Response(`#EXTM3U\n#${'x'.repeat(2 * 1024 * 1024)}`, {
      headers: explicitLength ? { 'Content-Length': String(3 * 1024 * 1024) } : {},
    }));
    const response = await setup.proxy.handle(new Request(setup.proxy.register('https://cf-media.sndcdn.com/playlist.m3u8')));
    assert.equal(response.status, 502);
    assert.equal(await response.text(), 'SoundCloud media is unavailable.');
  }
});

test('upstream failures never expose signed URLs, token headers or error bodies', async () => {
  for (const kind of ['throw', 'http', 'invalid-manifest']) {
    const setup = fixture(() => {
      if (kind === 'throw') throw new Error(`https://api.soundcloud.com/?token=${SECRET}`);
      return new Response(`private ${SECRET}`, { status: kind === 'http' ? 403 : 200 });
    });
    const response = await setup.proxy.handle(new Request(setup.proxy.register('https://api.soundcloud.com/tracks/1/stream')));
    assert.equal(response.status, kind === 'http' ? 403 : 502);
    assert.equal(await response.text(), 'SoundCloud media is unavailable.');
  }
});

test('opaque URL validation forbids alternate hosts, queries and guessed identifiers', async () => {
  const setup = fixture(() => manifest());
  const url = setup.proxy.register('https://cf-media.sndcdn.com/playlist.m3u8');
  for (const input of [url.replace('local', 'elsewhere'), `${url}?url=https://api.soundcloud.com`, `${url}#x`,
    'soundcloud-media://local/' + '0'.repeat(48)]) {
    assert.equal((await setup.proxy.handle(new Request(input))).status, 404);
  }
  assert.equal(setup.calls.length, 0);
});

test('bounds opaque resource registrations', async () => {
  const setup = fixture(() => manifest());
  const first = setup.proxy.register('https://cf-media.sndcdn.com/0.m3u8');
  let last;
  for (let index = 1; index <= 8192; index++) last = setup.proxy.register(`https://cf-media.sndcdn.com/${index}.m3u8`);
  assert.equal((await setup.proxy.handle(new Request(first))).status, 404);
  const response = await setup.proxy.handle(new Request(last));
  assert.equal(response.status, 200);
  await response.text();
});

test('playlists exceeding the registration bound fail instead of exposing expired handles', async () => {
  const setup = fixture(() => manifest('#EXTM3U\n'
    + Array.from({ length: 8193 }, (_, index) => `#EXTINF:4,\n${index}.ts`).join('\n')));
  const response = await setup.proxy.handle(new Request(setup.proxy.register('https://cf-media.sndcdn.com/index.m3u8')));
  assert.equal(response.status, 502);
  assert.equal(await response.text(), 'SoundCloud media is unavailable.');
});
