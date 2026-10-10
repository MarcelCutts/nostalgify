#!/usr/bin/env node
// Read-only service checks. Credentials and signed media URLs never reach stdout.
const { createSoundCloudAuth } = require("../apps/desktop/src/main/soundcloud/auth");
const { createSoundCloudClient } = require("../apps/desktop/src/main/soundcloud/client");
const { createMediaProxy } = require("../apps/desktop/src/main/soundcloud/media-proxy");

async function main() {
  let url;
  let checkRefresh = false;
  for (const argument of process.argv.slice(2)) {
    if (argument === "--refresh" && !checkRefresh) checkRefresh = true;
    else if (!argument.startsWith("-") && url === undefined) url = argument;
    else throw new Error("Usage: node scripts/check-soundcloud.js [--refresh] [public SoundCloud URL]");
  }
  if (!process.env.SOUNDCLOUD_CLIENT_ID || !process.env.SOUNDCLOUD_CLIENT_SECRET) {
    throw new Error("Set SOUNDCLOUD_CLIENT_ID and SOUNDCLOUD_CLIENT_SECRET in the process environment before running this check.");
  }
  let clockOffset = 0;
  let applicationGrants = 0;
  let refreshGrants = 0;
  const auth = createSoundCloudAuth({
    clientId: process.env.SOUNDCLOUD_CLIENT_ID,
    clientSecret: process.env.SOUNDCLOUD_CLIENT_SECRET,
    now: () => Date.now() + clockOffset,
    fetch: (requestUrl, options) => {
      const grant = new URLSearchParams(options.body).get("grant_type");
      if (grant === "client_credentials") applicationGrants += 1;
      if (grant === "refresh_token") refreshGrants += 1;
      return fetch(requestUrl, options);
    },
    openExternal: async () => { throw new Error("This check does not open a browser."); },
    store: { load: async () => null, save: async () => {}, clear: async () => {} },
  });
  const proxy = createMediaProxy({ fetch, getAccessToken: () => auth.getAccessToken() });
  try {
    await auth.getAccessToken();
    console.log("PASS SoundCloud application authentication");
    if (checkRefresh) {
      const previousApplicationGrants = applicationGrants;
      const previousRefreshGrants = refreshGrants;
      // Advance only the injected auth clock past the documented one-hour
      // lifetime. This forces a real refresh request without waiting an hour.
      clockOffset += 61 * 60 * 1000;
      await auth.getAccessToken();
      if (refreshGrants !== previousRefreshGrants + 1 || applicationGrants !== previousApplicationGrants) {
        throw new Error("The check did not perform the expected refresh_token grant.");
      }
      console.log("PASS SoundCloud token refresh (simulated expiry, real refresh grant)");
    }
    if (!url) {
      console.log("Add a public SoundCloud track or playlist URL to also verify resolution and media access.");
      return;
    }
    const client = createSoundCloudClient({ fetch, auth });
    const entries = await client.resolveLinks(url);
    if (!entries.length) throw new Error("Supply a public SoundCloud track or playlist link.");
    const tracks = await client.loadContext(entries[0].uri);
    console.log(`PASS SoundCloud context resolution (${tracks.length} tracks)`);
    const track = tracks.find((item) => item.access === "playable") || tracks.find((item) => item.access === "preview");
    if (!track) throw new Error("This context has no API-playable tracks. Try another public track.");
    const stream = await client.getStream(track);
    const response = await proxy.handle(new Request(proxy.register(stream.url, stream.type)));
    if (!response.ok) throw new Error("The stream could not be fetched. Check network access and catalogue availability.");
    if (stream.type === "hls") {
      if (!(await response.text()).startsWith("#EXTM3U")) throw new Error("The service did not return an HLS playlist.");
    } else {
      await response.body?.cancel();
    }
    console.log(`PASS SoundCloud ${stream.preview ? "preview" : "full-track"} media access (${stream.type})`);
    console.log("Playback decoding and audio output still require the Electron app.");
  } finally {
    proxy.clear();
    await auth.dispose();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
