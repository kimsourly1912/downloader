#!/usr/bin/env node
import { copyFile } from 'node:fs/promises'

const args = process.argv.slice(2)
if (args.at(-1).endsWith('/reel/404/')) {
  console.error('ERROR: Login required')
  process.exit(1)
}
if (args.includes('--dump-single-json')) {
  console.log(JSON.stringify({ title: 'Generated clip', duration: 1, formats: [
    { format_id: '180', width: 320, height: 180, ext: 'mp4', protocol: 'https', vcodec: 'avc1', acodec: 'mp4a' },
    { format_id: '360', width: 640, height: 360, ext: 'mp4', protocol: 'https', vcodec: 'avc1', acodec: 'mp4a' }
  ] }))
} else {
  const format = args[args.indexOf('--format') + 1].match(/^all\[format_id=(180|360)\]$/)?.[1]
  if (!format) process.exit(1)
  const output = args[args.indexOf('--output') + 1].replace('%(ext)s', 'mp4').replaceAll('%%', '%')
  await copyFile(`${process.env.DOWNLOADER_TEST_FIXTURE}/${format}.mp4`, output)
}
