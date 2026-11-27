#!/usr/bin/env node
import { copyFile } from 'node:fs/promises'

const args = process.argv.slice(2)
const source = new URL(args.at(-1))
const youtube = source.hostname === 'www.youtube.com'
// The adapter must send all extractor traffic through its loopback egress proxy.
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(args[args.indexOf('--proxy') + 1] ?? '')) process.exit(3)
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
  }
  const thumbnail = youtube ? 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg'
    : source.hostname.endsWith('.tiktok.com') ? 'https://image.tiktokcdn.com/thumb.jpg' : null
  console.log(JSON.stringify({ title: 'Generated clip', duration: 1, formats, thumbnail }))
} else {
  const selection = args[args.indexOf('--format') + 1]
  const format = selection === 'all[format_id="134"]+all[format_id="140"]' && youtube
    ? '360' : selection.match(/^all\[format_id="(180|360|sd|hd)"\]$/)?.[1]
  if (!format) process.exit(1)
  const height = { sd: '180', hd: '360' }[format] ?? format
  const output = args[args.indexOf('--output') + 1].replace('%(ext)s', 'mp4').replaceAll('%%', '%')
  await copyFile(`${process.env.DOWNLOADER_TEST_FIXTURE}/${height}.mp4`, output)
}
