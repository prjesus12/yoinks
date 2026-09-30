import assert from 'node:assert/strict'
import test from 'node:test'
import {albumTagArgs, buildChoices, buildPlaylistChoices, playlistFolderName, presetChoiceIndex, TITLE_NOISE, type VideoInfo} from './ytdlp.js'

const playlist = (title: string, channels: string[], owner?: string): VideoInfo => ({
  _type: 'playlist',
  title,
  uploader: owner,
  entries: channels.map((channel, i) => ({title: `track ${i + 1}`, channel})),
})

test('names album folders "artist - album"', () => {
  assert.equal(playlistFolderName(playlist('Beautiful Life', ['Rick Astley', 'Rick Astley'])), 'Rick Astley - Beautiful Life')
})

test('strips YouTube Music decorations', () => {
  assert.equal(
    playlistFolderName(playlist('Album - Discovery', ['Daft Punk - Topic', 'Daft Punk - Topic', 'Someone'])),
    'Daft Punk - Discovery',
  )
})

test('credits the owner of a mixed playlist', () => {
  assert.equal(playlistFolderName(playlist('Road trip', ['A', 'B', 'C'], 'Jesús')), 'Jesús - Road trip')
  assert.equal(playlistFolderName(playlist('Top Trending', ['A', 'B'], 'by YouTube')), 'YouTube - Top Trending')
  assert.equal(playlistFolderName(playlist('Road trip', ['A', 'B', 'C'])), 'Road trip')
})

test('keeps folder names filesystem-safe', () => {
  assert.equal(playlistFolderName(playlist('AC/DC: Live?', ['AC/DC', 'AC/DC'])), 'AC DC - AC DC Live')
  assert.equal(playlistFolderName(playlist('', [])), 'playlist')
})

test('tags tracks with literal album metadata', () => {
  assert.deepEqual(albumTagArgs({artist: 'AC/DC', album: 'Live: 100%'}), [
    '--parse-metadata',
    'playlist_index:%(meta_track)s',
    '--parse-metadata',
    '%(id&|)sLive\\: 100%%:%(meta_album)s',
    '--parse-metadata',
    '%(id&|)sAC/DC:%(meta_album_artist)s',
  ])
  assert.deepEqual(albumTagArgs({album: ''}), ['--parse-metadata', 'playlist_index:%(meta_track)s'])
})

test('strips video noise from titles but keeps the song\'s own version', () => {
  // yt-dlp runs it in Python; minus the inline (?i) it's the same in JS
  const noise = new RegExp(TITLE_NOISE.replace('(?i)', ''), 'gi')
  const clean = (title: string) => title.replace(noise, '')
  assert.equal(clean('Never Gonna Give You Up (Official Video) (4K Remaster)'), 'Never Gonna Give You Up')
  assert.equal(clean('DtMF (Video Oficial)'), 'DtMF')
  assert.equal(clean('Bohemian Rhapsody (Official Video Remastered)'), 'Bohemian Rhapsody')
  assert.equal(clean('Title [Official Lyric Video] (feat. X)'), 'Title (feat. X)')
  assert.equal(clean('Yellow (Live in Buenos Aires)'), 'Yellow (Live in Buenos Aires)')
  assert.equal(clean('Title (Remastered 2009)'), 'Title (Remastered 2009)')
  assert.equal(clean('Title (Remastered)'), 'Title (Remastered)')
})

test('maps presets to their choice', () => {
  const single = buildChoices({
    title: 'x',
    formats: [
      {format_id: '1', vcodec: 'avc1', acodec: 'none', height: 1080},
      {format_id: '2', vcodec: 'avc1', acodec: 'none', height: 720},
      {format_id: '3', vcodec: 'none', acodec: 'mp4a', ext: 'm4a', abr: 128},
    ],
  } as VideoInfo)
  assert.equal(single[presetChoiceIndex(single, 'best')]!.label, '1080p · mp4')
  assert.equal(single[presetChoiceIndex(single, 'mp3')]!.format, 'mp3')
  assert.equal(single[presetChoiceIndex(single, 'm4a')]!.format, 'm4a')

  const list = buildPlaylistChoices(playlist('Discovery', ['Daft Punk', 'Daft Punk']))
  assert.equal(list[presetChoiceIndex(list, 'm4a')]!.label, 'all 2 tracks · m4a')
  assert.equal(list[presetChoiceIndex(list, 'best')]!.label, 'all 2 videos · mp4')
})
