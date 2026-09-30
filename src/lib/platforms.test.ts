import assert from 'node:assert/strict'
import test from 'node:test'
import {playlistUrlFor} from './platforms.js'

test('offers the playlist behind a youtube watch link', () => {
  assert.equal(
    playlistUrlFor('https://www.youtube.com/watch?v=abc&list=PL123&index=2'),
    'https://www.youtube.com/playlist?list=PL123',
  )
  assert.equal(
    playlistUrlFor('https://music.youtube.com/watch?v=abc&list=OLAK5uy_x'),
    'https://www.youtube.com/playlist?list=OLAK5uy_x',
  )
})

test('ignores links that are already playlists, mixes, or not youtube', () => {
  assert.equal(playlistUrlFor('https://www.youtube.com/playlist?list=PL123'), undefined)
  assert.equal(playlistUrlFor('https://www.youtube.com/watch?v=abc&list=RDabc'), undefined)
  assert.equal(playlistUrlFor('https://www.youtube.com/watch?v=abc'), undefined)
  assert.equal(playlistUrlFor('https://vimeo.com/123?list=PL123'), undefined)
  assert.equal(playlistUrlFor('not a url'), undefined)
})
