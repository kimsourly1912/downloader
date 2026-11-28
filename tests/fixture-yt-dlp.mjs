#!/usr/bin/env node
import { appendFile, copyFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const args = process.argv.slice(2)
const infoPath = args.includes('--load-info-json') ? args[args.indexOf('--load-info-json') + 1] : undefined
const info = infoPath ? JSON.parse(await readFile(infoPath, 'utf8')) : undefined
const source = new URL(info ? info.webpage_url : args.at(-1))
const youtube = source.hostname === 'www.youtube.com'
// The adapter must send all extractor traffic through its loopback egress proxy.
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(args[args.indexOf('--proxy') + 1] ?? '')) process.exit(3)
// Reusing the cache dir keeps YouTube player data between runs.
if (args.includes('--no-cache-dir') || !args[args.indexOf('--cache-dir') + 1]) process.exit(4)
const visionos = args.includes('youtube:player_client=visionos')
const mode = args.includes('--dump-single-json') ? `inspect${visionos ? '-visionos' : ''}` : info ? 'download-info' : 'download-url'
await appendFile(join(process.env.DOWNLOADER_TEST_FIXTURE, 'calls.log'), `${mode} ${source.href}\n`)
if (source.pathname === '/@test/video/429') {
  console.error('ERROR: [tiktok] Unable to download webpage: HTTP Error 429: Too Many Requests https://www.tiktok.com/?secret=private')
  process.exit(1)
}
if (youtube && args[args.indexOf('--js-runtimes') + 1] !== 'node') process.exit(2)
if (source.href.endsWith('/reel/404/')) {
  console.error('ERROR: Login required')
  process.exit(1)
}
if (source.searchParams.get('v') === 'bcdefghijkl') {
  console.error('ERROR: Sign in to confirm you’re not a bot')
  process.exit(1)
}
if (args.includes('--dump-single-json')) {
  const fields = { ext: 'mp4', protocol: 'https', vcodec: 'avc1', acodec: 'mp4a' }
  const hdUrl = 'https://video.fbcdn.net/high.mp4'
  const formats = source.pathname.includes('SourceQuality') ? [
    { ...fields, format_id: 'sd', url: source.pathname.includes('Duplicate') ? hdUrl : 'https://video.fbcdn.net/standard.mp4' },
    { ...fields, format_id: 'hd', url: hdUrl }
  ] : [
    { ...fields, format_id: '180', width: 320, height: 180 },
    { ...fields, format_id: '360', width: 640, height: 360 }
  ]
  if (youtube) {
    formats[1] = { ...formats[1], format_id: '134', acodec: 'none' }
    formats.push({ ...fields, ext: 'm4a', format_id: '140', vcodec: 'none' })
    // This video's visionOS response has no H.264 MP4, so the adapter must fall back to the default clients.
    if (visionos && source.searchParams.get('v') === 'cdefghijklm') {
      formats.splice(0, formats.length, { ...fields, ext: 'webm', vcodec: 'vp9', format_id: '243', width: 640, height: 360 })
    }
  }
  const thumbnail = youtube ? 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg'
    : source.hostname.endsWith('.tiktok.com') ? 'https://image.tiktokcdn.com/thumb.jpg' : null
  console.log(JSON.stringify({ title: 'Generated clip', duration: 1, formats, thumbnail, webpage_url: source.href }))
} else {
  if (source.searchParams.get('v') === 'defghijklmn') {
    console.error('ERROR: unable to write data: [Errno 27] File too large')
    process.exit(1)
  }
  const selection = args[args.indexOf('--format') + 1]
  // Like yt-dlp, a saved inspection only offers the formats it listed.
  const ids = [...selection.matchAll(/format_id="([^"]+)"/g)].map(match => match[1])
  if (info && !ids.every(id => info.formats.some(format => format.format_id === id))) process.exit(1)
  const format = selection === 'all[format_id="134"]+all[format_id="140"]' && youtube
    ? '360' : selection.match(/^all\[format_id="(180|360|sd|hd)"\]$/)?.[1]
  if (!format) process.exit(1)
  const height = { sd: '180', hd: '360' }[format] ?? format
  const output = args[args.indexOf('--output') + 1].replace('%(ext)s', 'mp4').replaceAll('%%', '%')
  await copyFile(`${process.env.DOWNLOADER_TEST_FIXTURE}/${height}.mp4`, output)
}
