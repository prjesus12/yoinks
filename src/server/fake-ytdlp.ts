// test support only — a stand-in for the real yt-dlp binary. Every answer is
// canned and nothing touches the network, so a server test can assert on exact
// bytes, events and exit behaviour. It is never imported by production code.
//
// It writes into its own folder rather than the server's outDir on purpose: a
// cancel test can then tell yt-dlp's own cleanup (the `.part` file) apart from
// the server deleting a job's scratch folder.

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** The bytes a fake download leaves in its file. */
export const FAKE_BYTES = 'yoinks fake download\n'

/** The folder a playlist download creates, inside `out`. */
export const ALBUM = 'Canned Artist - Canned Album'

/** What `-J` prints for a single video: two heights plus two audio formats. */
const VIDEO = {
  _type: 'video',
  id: 'canned-video',
  title: 'Canned Video',
  uploader: 'Canned Uploader',
  channel: 'Canned Channel',
  duration: 123,
  webpage_url: 'https://example.com/watch?v=canned',
  thumbnail: 'https://example.com/thumb.jpg',
  thumbnails: [{url: 'https://example.com/thumb.jpg', width: 1280, height: 720}],
  formats: [
    {
      format_id: '137',
      ext: 'mp4',
      vcodec: 'avc1.640028',
      acodec: 'none',
      height: 1080,
      width: 1920,
      tbr: 4000,
      filesize: 40_000_000,
    },
    {
      format_id: '136',
      ext: 'mp4',
      vcodec: 'avc1.4d401f',
      acodec: 'none',
      height: 720,
      width: 1280,
      tbr: 2000,
      filesize: 20_000_000,
    },
    {format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128, filesize: 3_000_000},
    {format_id: '251', ext: 'webm', vcodec: 'none', acodec: 'opus', abr: 160, filesize: 3_500_000},
  ],
}

/** What `-J` prints for a playlist: two entries, one channel, real durations. */
const PLAYLIST = {
  _type: 'playlist',
  id: 'canned-playlist',
  title: 'Album - Canned Album',
  uploader: 'Canned Channel',
  channel: 'Canned Channel',
  playlist_count: 2,
  entries: [
    {
      title: 'One',
      duration: 60,
      channel: 'Canned Artist',
      thumbnails: [{url: 'https://example.com/one.jpg', width: 1280, height: 720}],
    },
    {title: 'Two', duration: 90, channel: 'Canned Artist'},
  ],
}

export type FakeYtDlp = {
  /** Hand this to `startWebServer({ytdlpPath})`. */
  bin: string
  /** The script's own folder — also where `invocations.log` and `out/` live. */
  dir: string
  /** Every argv the script was launched with, one line each. */
  log: string
  /** Where the script writes the files it "downloads". */
  out: string
  /** The file a plain download produces. */
  video: string
  /** The folder a playlist download produces. */
  album: string
  /** Make plain downloads stall after writing their `.part` file. */
  hang: () => Promise<void>
  /** Stop stalling. */
  resume: () => Promise<void>
}

/**
 * A fake yt-dlp that answers `--version`, `-J` (a video payload, or a playlist
 * payload when the URL mentions "playlist") and, for anything else, behaves
 * like a download. Set `YOINKS_FAKE_DIR` to share one script between processes;
 * otherwise it writes next to itself.
 */
export async function fakeYtDlp(): Promise<FakeYtDlp> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-fake-'))
  const bin = path.join(dir, 'yt-dlp')
  const out = path.join(dir, 'out')
  await fs.writeFile(bin, script(dir), {mode: 0o755})
  // writeFile's mode is ignored when the file already exists (and on win32)
  await fs.chmod(bin, 0o755)
  return {
    bin,
    dir,
    log: path.join(dir, 'invocations.log'),
    out,
    video: path.join(out, 'video.mp4'),
    album: path.join(out, ALBUM),
    hang: () => fs.writeFile(path.join(dir, 'hang'), ''),
    resume: () => fs.rm(path.join(dir, 'hang'), {force: true}),
  }
}

function script(dir: string): string {
  return `#!/bin/sh
# a fake yt-dlp: canned metadata, real bytes, no network
dir="\${YOINKS_FAKE_DIR:-${dir}}"
echo "$*" >> "$dir/invocations.log"
out="$dir/out"
mkdir -p "$out"
mode=download
playlist=no
for arg in "$@"; do
  case "$arg" in
    --version) mode=version ;;
    -J) mode=probe ;;
    --yes-playlist) playlist=yes ;;
  esac
done
if [ "$mode" = version ]; then
  echo "2026.01.15"
  exit 0
fi
if [ "$mode" = probe ]; then
  url=
  for arg in "$@"; do
    case "$arg" in
      http://*|https://*) url="$arg" ;;
    esac
  done
  case "$url" in
    *playlist*)
      cat <<'JSON'
${JSON.stringify(PLAYLIST, null, 2)}
JSON
      ;;
    *)
      cat <<'JSON'
${JSON.stringify(VIDEO, null, 2)}
JSON
      ;;
  esac
  exit 0
fi
if [ "$playlist" = yes ]; then
  album="$out/${ALBUM}"
  mkdir -p "$album"
  echo "first track" > "$album/01 - One.mp3"
  echo "YOINK|10|20|NA|NA|NA"
  echo "second track" > "$album/02 - Two.mp3"
  echo "YOINK|20|20|NA|NA|NA"
  echo "$album/02 - Two.mp3"
  exit 0
fi
target="$out/video.mp4"
if [ -f "$dir/hang" ]; then
  echo "[download] Destination: $target"
  : > "$target.part"
  exec sleep 60
  exit 0
fi
echo "YOINK|512|1024|NA|NA|NA"
echo "[download] Destination: $target"
echo "${FAKE_BYTES.trim()}" > "$target"
echo "YOINK|1024|1024|NA|NA|NA"
echo "$target"
exit 0
`
}
