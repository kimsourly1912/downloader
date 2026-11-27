#!/usr/bin/env node
import { copyFile } from 'node:fs/promises'

const args = process.argv.slice(2)
if (args.at(-1).endsWith('/reel/404/')) {
  console.error('ERROR: Login required')
  process.exit(1)
}
if (args.includes('--dump-single-json')) {
  const source = args.at(-1)
  const fields = { ext: 'mp4', protocol: 'https', vcodec: 'avc1', acodec: 'mp4a' }
  const hdUrl = 'https://video.fbcdn.net/high.mp4'
  const formats = source.includes('SourceQuality') ? [
    { ...fields, format_id: 'sd', url: source.includes('Duplicate') ? hdUrl : 'https://video.fbcdn.net/standard.mp4' },
    { ...fields, format_id: 'hd', url: hdUrl }
  ] : [
    { ...fields, format_id: '180', width: 320, height: 180 },
    { ...fields, format_id: '360', width: 640, height: 360 }
  ]
  console.log(JSON.stringify({ title: 'Generated clip', duration: 1, formats }))
} else {
  const format = args[args.indexOf('--format') + 1].match(/^all\[format_id=(180|360|sd|hd)\]$/)?.[1]
  if (!format) process.exit(1)
  const height = { sd: '180', hd: '360' }[format] ?? format
  const output = args[args.indexOf('--output') + 1].replace('%(ext)s', 'mp4').replaceAll('%%', '%')
  await copyFile(`${process.env.DOWNLOADER_TEST_FIXTURE}/${height}.mp4`, output)
}
