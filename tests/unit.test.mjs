import assert from 'node:assert/strict'
import { test } from 'node:test'
import { facebookUrl, resolveVideoLink, validSelection } from '../shared/extraction.ts'

test('allows supported Facebook URLs and rejects non-video or unsafe destinations', () => {
  for (const path of ['/share/v/Video_Abc/', '/share/r/Reel_Abc/', '/watch/?v=123', '/reel/123/', '/page/videos/123']) {
    assert.ok(facebookUrl(`https://www.facebook.com${path}`))
  }
  assert.ok(facebookUrl('https://fb.watch/test_token/'))
  for (const input of [null, 'file:///etc/passwd', 'http://www.facebook.com/reel/123',
    'https://facebook.com@127.0.0.1/reel/123', 'https://www.facebook.com.evil.test/reel/123',
    'https://www.facebook.com:8443/reel/123', 'https://www.facebook.com/watch?v=123&v=456',
    'https://www.facebook.com/share/v/test\n/', 'https://www.facebook.com/l.php?u=https://localhost']) {
    assert.equal(facebookUrl(input), null)
  }
})

test('normalizes YouTube links to a single video and TikTok shares to clean URLs', () => {
  for (const input of ['https://m.youtube.com/watch?v=abcdefghijk&list=abc', 'https://youtu.be/abcdefghijk?si=share',
    'https://www.youtube.com/shorts/abcdefghijk#video']) {
    assert.deepEqual(resolveVideoLink(input), { platform: 'youtube', url: 'https://www.youtube.com/watch?v=abcdefghijk' })
  }
  assert.deepEqual(resolveVideoLink('https://m.tiktok.com/@demo.user/video/123456/?_r=1#video'), {
    platform: 'tiktok', url: 'https://www.tiktok.com/@demo.user/video/123456'
  })
  for (const url of ['https://www.tiktok.com/t/Z123/', 'https://vm.tiktok.com/Z123/', 'https://vt.tiktok.com/Z123/']) {
    assert.deepEqual(resolveVideoLink(`${url}?share=1`), { platform: 'tiktok', url })
  }
})

test('rejects unsupported paths and deceptive YouTube and TikTok origins', () => {
  for (const input of ['https://www.youtube.com/playlist?list=abc', 'https://www.youtube.com/watch?v=abcdefghijk&v=12345678901',
    'https://youtu.be/invalid', 'https://www.youtube.com/redirect?q=https%3A%2F%2Fexample.test',
    'https://www.tiktok.com/@demo/photo/123456', 'https://www.tiktok.com/@demo', 'https://vm.tiktok.com/Z123/other',
    'https://www.youtube.com@127.0.0.1/watch?v=abcdefghijk', 'https://www.tiktok.com.evil.test/@demo/video/123456',
    'http://www.tiktok.com/@demo/video/123456', 'https://www.tiktok.com:8443/@demo/video/123456']) {
    assert.equal(resolveVideoLink(input), null)
  }
})

test('only accepts literal IDs and optional audio pairing', () => {
  assert.ok(validSelection('hd'))
  assert.ok(validSelection('video-a+audio.b'))
  for (const value of ['', '+', 'hd,sd', 'a+b+c', 'a[height=720]', 'a;whoami', '$HOME', 'a b', 'hd\n']) {
    assert.equal(validSelection(value), false)
  }
})
