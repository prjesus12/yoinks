import assert from 'node:assert/strict'
import {test} from 'node:test'
import {pickFormats, videoId, type Format, type VideoInfo} from './youtube'

test('videoId', () => {
  for (const url of [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1',
    'https://youtu.be/dQw4w9WgXcQ?si=x',
    'https://youtube.com/shorts/dQw4w9WgXcQ',
    'https://m.youtube.com/watch?feature=share&v=dQw4w9WgXcQ',
    'https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RD',
    'dQw4w9WgXcQ',
  ])
    assert.equal(videoId(url), 'dQw4w9WgXcQ', url)
  assert.throws(() => videoId('https://example.com'))
})

test('pickFormats takes H.264 + default, non-drc m4a', () => {
  const f = (itag: number, kind: Format['kind'], codec: string, extra: Partial<Format> = {}): Format => ({
    itag, url: '', kind, codec, container: 'mp4', bitrate: 0, defaultAudio: true, drc: false, ...extra,
  })
  const info: VideoInfo = {id: 'x', title: 'x', author: 'x', duration: 1, formats: [
    f(313, 'video', 'vp9', {height: 2160}),
    f(137, 'video', 'avc1.640028', {height: 1080}),
    f(136, 'video', 'avc1.4D401F', {height: 720}),
    f(1, 'audio', 'mp4a.40.2', {bitrate: 999, drc: true}),
    f(2, 'audio', 'mp4a.40.2', {bitrate: 900, defaultAudio: false}),
    f(140, 'audio', 'mp4a.40.2', {bitrate: 130}),
    f(139, 'audio', 'mp4a.40.5', {bitrate: 50}),
    f(251, 'audio', 'opus', {bitrate: 160}),
  ]}
  assert.deepEqual(Object.values(pickFormats(info)).map(x => x?.itag), [137, 140])
  assert.equal(pickFormats(info, {maxHeight: 720}).video?.itag, 136)
  assert.equal(pickFormats(info, {audioOnly: true}).video, undefined)
})
