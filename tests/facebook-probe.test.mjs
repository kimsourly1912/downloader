import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mediaUrl, parsePage } from '../cloudflare/facebook-probe/facebook.ts'

const hd = 'https://video.example.fbcdn.net/high.mp4?token=abc'
const sd = 'https://video.example.fbcdn.net/standard.mp4?token=def'
const script = data => `<script type="application/json" data-sjs>${JSON.stringify(data)}</script>`

test('selects streams for the video requested by a share link', () => {
  const page = '<meta property="og:url" content="https://www.facebook.com/reel/42/">' + script([
    { id: '77', browser_native_hd_url: 'https://fbcdn.net/unrelated.mp4' },
    { id: '42', videoDeliveryLegacyFields: { browser_native_hd_url: hd, browser_native_sd_url: sd } }
  ])
  assert.deepEqual(parsePage(page, 'https://www.facebook.com/share/r/shortcode/'), { id: '42', choices: { hd, sd } })
})

test('uses progressive variants and suppresses duplicate HD and SD URLs', () => {
  const page = script({ videoId: '42', videoDeliveryResponseFragment: { videoDeliveryResponseResult: {
    progressive_urls: ['HD', 'SD'].map(quality => ({ progressive_url: hd, metadata: { quality } }))
  } } })
  assert.deepEqual(parsePage(page, 'https://www.facebook.com/watch/?v=42'), { id: '42', choices: { hd } })
})

test('rejects other origins, playlists, and videos without a matching progressive stream', () => {
  for (const url of ['https://fbcdn.net.attacker.test/x.mp4', 'https://fbcdn.net@localhost/x.mp4',
    'https://video.fbcdn.net/x.mpd', 'http://video.fbcdn.net/x.mp4']) assert.equal(mediaUrl(url), null)
  const otherVideo = script({ id: '99', browser_native_hd_url: hd })
  assert.throws(() => parsePage(otherVideo, 'https://www.facebook.com/reel/42/'), /NO_PROGRESSIVE_MP4/)
})
