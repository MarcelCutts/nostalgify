# SoundCloud playback fixture

This is generated silence, not downloaded music. The VOD HLS playlist has four
approximately 3-second MPEG-TS segments containing stereo AAC-LC at 48 kHz.
Encoding targets 64 kbps; silence compresses much smaller. Its measured duration
is 12.010667 seconds because AAC frames are discrete. Manifest and media total
15,281 bytes.

Generated with FFmpeg 7.1.5 (Debian 7.1.5-0+deb13u1). Run from the repository root
(the output files must not already exist):

```sh
ffmpeg -nostdin -hide_banner -loglevel error \
  -f lavfi -i anullsrc=r=48000:cl=stereo \
  -frames:a 562 -c:a aac -b:a 64k \
  -fflags +bitexact -flags:a +bitexact -map_metadata -1 \
  -f hls -hls_time 3 -hls_list_size 0 -hls_playlist_type vod \
  -hls_segment_filename tests/fixtures/soundcloud/segment-%02d.ts \
  tests/fixtures/soundcloud/index.m3u8
```

The fixed frame count, silent source, removed metadata, and bitexact flags make
generation reproducible with the same FFmpeg build. The fixture has been probed
as AAC-LC and decoded successfully with:

```sh
ffprobe -v error -show_entries stream=codec_name,profile,sample_rate,channels \
  -show_entries format=duration -of json tests/fixtures/soundcloud/index.m3u8
ffmpeg -nostdin -hide_banner -loglevel error \
  -i tests/fixtures/soundcloud/index.m3u8 -f null -
```

Only the explicitly enabled mock SoundCloud self-test should serve this fixture.
It exercises the production media proxy, HLS parser, AAC decoder, and Audio
element without SoundCloud credentials, external requests, or audible sound.
