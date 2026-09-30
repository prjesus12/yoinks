# yoinks

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
  <img src="assets/logo-light.svg" alt="yoinks" width="288">
</picture>

yoink any video. paste. yoink. done.

Download videos from YouTube, X/Twitter, Instagram, Threads, TikTok and
1,800+ other sites — right from your terminal. Paste a url, pick a
resolution (or audio-only mp3), done. No popups, no fake download buttons,
no sketchy redirects.

<img src="assets/home.png" alt="yoinks home screen — paste a link and hit yoink" width="100%">

## Install

```sh
npm install -g yoinks
```

Or try it without installing anything:

```sh
npx yoinks
```

Requires Node 18+. Everything else (yt-dlp, ffmpeg) is fetched or bundled
automatically.

## Usage

```sh
$ yoinks https://youtu.be/dQw4w9WgXcQ    # straight to the format picker
$ yoinks                                 # prompts for a url
$ yoinks --theme light                   # force the light palette
$ yoinks --mp3 <playlist-url>            # every track as mp3, no questions
$ yoinks --m4a -o ~/Music <url>          # m4a, saved to ~/Music
$ yoinks --best <url>                    # highest-resolution mp4
```

With a url plus `--mp3`, `--m4a` or `--best`, yoinks skips the format
picker, downloads, prints the path and exits (with a non-zero exit code on
failure) — so it works in scripts too. `-o` / `--out` picks the folder.

yoinks takes over the terminal (full-screen, centered — and restores your
scrollback on exit). Pick a format with ↑/↓ (or j/k, or number keys) and
hit enter. `esc` goes back, `^c` quits. Or just use the mouse — the yoink
button, the format list and the footer hints are all clickable, and
clicking the logo takes you back home. Files are saved to `~/Downloads`,
and the file path is printed to your terminal when you're done.

Paste a playlist link to yoink the whole thing — every track as an mp3 or
m4a, or every video as an mp4 — into its own `Artist - Album` folder in
`~/Downloads` (the artist is the channel behind most tracks, or the
playlist's owner for mixed playlists), numbered in playlist order. Unavailable videos are skipped instead of stopping the run.
Pasting a `watch?v=…&list=…` link offers the whole playlist as an extra
option under the video's own formats.

Audio comes as mp3 or m4a (YouTube's own AAC stream, kept as-is instead of
re-encoded — smaller and a touch better). Either way it gets the video's
thumbnail embedded as square cover art (cropped from the center, which
recovers the album art on YouTube Music tracks), plus title and artist tags.
Titles are cleaned up for music: `Rick Astley - Never Gonna Give You Up
(Official Video) (4K Remaster)` becomes `Never Gonna Give You Up` — video
noise like `(Official Video)`, `[Lyrics]` or `(Video Oficial)` is dropped, and
so is a leading artist name that repeats the channel. Things that are part of
the song, like `(Live in …)`, `(feat. …)` or `(Remastered 2009)`, stay.
Playlist audio is also tagged with the same album, album artist
and track number, so music players group the folder as one record.

The default `auto` theme uses your terminal's own foreground and background,
so it follows light and dark terminal themes without guessing. Press `^t` or
click the theme control in the footer to cycle through `auto`, `light`, and
`dark` for the current session. Use `--theme auto`, `--theme light`, or
`--theme dark` to choose the starting theme for one launch.

<img src="assets/download-options.png" alt="yoinks format picker — resolutions with estimated file sizes, plus audio-only mp3" width="100%">

## How it works

- Powered by [yt-dlp](https://github.com/yt-dlp/yt-dlp). On first run,
  yoinks downloads the standalone yt-dlp binary to `~/.yoinks/bin` —
  no Python required. If you already have yt-dlp installed, it uses yours.
- ffmpeg (needed for merging high-res streams and mp3 extraction) is found
  on your PATH, with `ffmpeg-static` as a bundled fallback.
- The UI is [Ink](https://github.com/vadimdemedes/ink) — React for the
  terminal.

## Development

```sh
npm install
npm run build        # bundle to dist/ with tsup
npm run dev          # rebuild on change
node dist/cli.js <url>
npm run typecheck
```

To try it as a global command without publishing: `npm link`, then run
`yoinks` anywhere.

## Roadmap

- [x] `--best` / `--mp3` flags to skip the picker (scriptable mode)
- [x] `-o <dir>` to choose the output folder
- [x] Playlist / thread-with-multiple-videos support
- [ ] Clipboard detection: launch bare and auto-suggest the url you copied
- [ ] Self-update for the bundled yt-dlp binary (`yt-dlp -U`)
- [x] Publish to npm (`npm i -g yoinks` / `npx yoinks`)
- [ ] `curl yoinks.sh | sh` installer

## A note on fair use

yoinks is a personal-archiving tool. Downloading content may violate a
platform's terms of service — only download what you have the right to
keep, and be excellent to creators.

## License

[MIT](LICENSE)
