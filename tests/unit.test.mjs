import assert from 'node:assert/strict'
import { test } from 'node:test'
import { facebookUrl, validSelection } from '../shared/extraction.ts'

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

test('only accepts literal IDs and optional audio pairing', () => {
  assert.ok(validSelection('hd'))
  assert.ok(validSelection('video-a+audio.b'))
  for (const value of ['', '+', 'hd,sd', 'a+b+c', 'a[height=720]', 'a;whoami', '$HOME', 'a b', 'hd\n']) {
    assert.equal(validSelection(value), false)
  }
})
