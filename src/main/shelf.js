// Entries carry their provider; derive it when reading legacy Spotify-only shelves.
function cleanShelf(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list.flatMap((item) => {
    if (!item || typeof item.uri !== "string") return [];
    const spotify = item.uri.match(/^spotify:(track|album|playlist|artist):([A-Za-z0-9]+)$/);
    const sc = item.uri.match(/^soundcloud:(tracks|playlists):([A-Za-z0-9_-]+)$/);
    if (!spotify && !sc || seen.has(item.uri)) return [];
    const provider = spotify ? "spotify" : "soundcloud";
    if (item.provider && item.provider !== provider) return [];
    seen.add(item.uri);
    const entry = {
      provider, kind: spotify ? spotify[1] : sc[1] === "tracks" ? "track" : "playlist",
      uri: item.uri, title: String(item.title || "").slice(0, 120),
      ...(item.artist ? { artist: String(item.artist).slice(0, 120) } : {}),
    };
    if (provider === "soundcloud" && typeof item.url === "string") {
      try {
        const url = new URL(item.url);
        if (url.protocol === "https:" && ["soundcloud.com", "www.soundcloud.com"].includes(url.hostname) && !url.username && !url.password && !url.port) {
          entry.url = url.origin + url.pathname;
        }
      } catch {}
    }
    return [entry];
  }).slice(0, 500);
}

module.exports = { cleanShelf };
