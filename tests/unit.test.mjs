import assert from 'node:assert/strict'
import { once } from 'node:events'
import { request } from 'node:http'
import { test } from 'node:test'
import { publicAddress, startEgressProxy, tunnelTarget } from '../container/egress-proxy.ts'
import { allowedExtractionHost, facebookUrl, maxMediaBytes, resolveVideoLink, validInfoKey, validSelection } from '../shared/extraction.ts'
import { chooseFormats } from '../shared/video-formats.ts'

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

test('only accepts saved inspection keys in UUID form', () => {
  assert.ok(validInfoKey('0f8fad5b-d9cb-469f-a165-70867728950e'))
  for (const value of [undefined, null, 1, '', '../info.json', '0F8FAD5B-D9CB-469F-A165-70867728950E', '0f8fad5b-d9cb-469f-a165-70867728950e\n']) {
    assert.equal(validInfoKey(value), false)
  }
})

test('egress allowlist matches platform names and rejects lookalikes and literals', () => {
  for (const host of ['www.youtube.com', 'rr2---sn-2imern7r.googlevideo.com', 'youtu.be', 'v16-webapp-prime.us.tiktok.com',
    'v19.tiktokcdn-us.com', 'video.xx.fbcdn.net', 'WWW.TIKTOK.COM.']) {
    assert.ok(allowedExtractionHost(host), host)
  }
  for (const host of ['googlevideo.com', 'eviltiktok.com', 'www.tiktok.com.evil.test', 'localhost', '127.0.0.1',
    '[::1]', 'www.youtube.com:443', 'a..youtube.com', '']) {
    assert.equal(allowedExtractionHost(host), false, host)
  }
  assert.equal(tunnelTarget('www.tiktok.com:443'), 'www.tiktok.com')
  for (const target of ['www.tiktok.com:80', 'www.tiktok.com', '142.250.0.1:443', '[2a00:1450::1]:443', 'example.com:443', undefined]) {
    assert.equal(tunnelTarget(target), null, String(target))
  }
})

test('egress only connects to public addresses', () => {
  for (const [address, family] of [['142.250.72.14', 4], ['2a00:1450:4001::200e', 6]]) assert.ok(publicAddress(address, family), address)
  for (const [address, family] of [['127.0.0.1', 4], ['10.1.2.3', 4], ['172.20.0.1', 4], ['192.168.1.1', 4], ['169.254.169.254', 4],
    ['100.100.0.1', 4], ['0.0.0.0', 4], ['::1', 6], ['::', 6], ['::ffff:127.0.0.1', 6], ['fd00::1', 6], ['fe80::1', 6],
    ['64:ff9b::a00:1', 6], ['2002:a00:1::', 6], ['1.1.1.1', 0]]) {
    assert.equal(publicAddress(address, family), false, address)
  }
})

test('egress proxy refuses plain HTTP, disallowed targets, and private DNS answers', async (t) => {
  const answers = { 'www.tiktok.com': [{ address: '142.250.72.14', family: 4 }, { address: '10.0.0.5', family: 4 }],
    'www.youtube.com': [{ address: '127.0.0.1', family: 4 }] }
  const resolved = []
  const proxy = await startEgressProxy({ resolve: async (host) => { resolved.push(host); return answers[host] ?? [] } })
  t.after(() => proxy.close())
  const { port } = new URL(proxy.url)

  async function tunnel(path) {
    const pending = request({ host: '127.0.0.1', port, method: 'CONNECT', path })
    pending.end()
    const [response, socket] = await once(pending, 'connect')
    socket.destroy()
    return response.statusCode
  }
  for (const target of ['example.com:443', 'www.tiktok.com:80', '127.0.0.1:443', 'www.tiktok.com:443', 'www.youtube.com:443']) {
    assert.equal(await tunnel(target), 403, target)
  }
  assert.equal(await tunnel('www.facebook.com:443'), 502)
  assert.deepEqual(resolved, ['www.tiktok.com', 'www.youtube.com', 'www.facebook.com'])

  const plain = request({ host: '127.0.0.1', port, path: 'http://www.youtube.com/' })
  plain.end()
  const [response] = await once(plain, 'response')
  response.resume()
  assert.equal(response.statusCode, 405)
})

test('accepts videos up to two hours and only offers qualities that fit the file limit', () => {
  const format = (id, height, sizeBytes) => ({ id, ext: 'mp4', protocol: 'https', videoCodec: 'avc1.4d401f', audioCodec: 'none',
    width: height * 16 / 9, height, sizeBytes })
  const audio = { id: '140', ext: 'm4a', protocol: 'https', videoCodec: 'none', audioCodec: 'mp4a.40.2', sizeBytes: 100 * 1024 * 1024 }
  const source = duration => ({ title: 'Long video', duration, thumbnail: null, live: false, formats: [
    format('134', 360, 300 * 1024 * 1024), format('136', 720, 900 * 1024 * 1024), audio] })
  const choices = chooseFormats(source(2 * 60 * 60))
  assert.deepEqual(choices.map(choice => [choice.selection, choice.resolution.height]), [['134+140', 360]])
  assert.ok(choices[0].sizeBytes <= maxMediaBytes)
  assert.equal(chooseFormats(source(2 * 60 * 60 + 1)), 'TOO_LONG')

  // A format with only an estimated size is dropped when the estimate is over the limit, and the estimate is never shown.
  const estimated = chooseFormats({ ...source(36 * 60), formats: [format('134', 360, 95_000_000),
    { ...format('137', 1080, undefined), approxBytes: 870_000_000 }, { ...format('136', 720, undefined), approxBytes: 280_000_000 }, audio] })
  assert.deepEqual(estimated.map(choice => [choice.resolution.height, choice.sizeBytes]), [[720, null], [360, 95_000_000 + audio.sizeBytes]])
})
