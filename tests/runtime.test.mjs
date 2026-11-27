import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { build } from 'esbuild'
import { convertV4MiniflareOptions, Miniflare } from 'miniflare'

async function setup(t, live) {
  const temp = await mkdtemp(join(tmpdir(), 'downloader-runtime-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  let ytdlp = process.env.YTDLP_BIN || 'yt-dlp'
  if (!live) {
    ytdlp = join(temp, 'yt-dlp.mjs')
    await copyFile('tests/fixture-yt-dlp.mjs', ytdlp)
    await chmod(ytdlp, 0o700)
    for (const [width, height] of [[320, 180], [640, 360]]) {
      execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=s=${width}x${height}:r=15`,
        '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '1', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac',
        '-movflags', '+faststart', join(temp, `${height}.mp4`)])
    }
  }

  const socket = createServer()
  socket.listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const { port } = socket.address()
  await new Promise(resolveClose => socket.close(resolveClose))
  const origin = `http://127.0.0.1:${port}`
  const adapter = spawn(process.execPath, ['container/main.ts'], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), TMPDIR: temp, YTDLP_BIN: ytdlp,
      MEDIA_CLOUDFLARE_EGRESS: '', DOWNLOADER_TEST_FIXTURE: temp }, stdio: ['ignore', 'ignore', 'inherit']
  })
  t.after(async () => {
    if (adapter.exitCode === null) { adapter.kill(); await once(adapter, 'exit') }
  })
  for (let attempt = 0; ; attempt++) {
    const readiness = await fetch(origin).catch(() => null)
    if (readiness?.ok) { await readiness.body.cancel(); break }
    if (attempt === 49 || adapter.exitCode !== null) throw new Error('Extractor did not become ready')
    await new Promise(ready => setTimeout(ready, 100))
  }

  const bundle = await build({ entryPoints: ['cloudflare/worker.ts'], bundle: true, write: false, format: 'esm',
    platform: 'neutral', external: ['cloudflare:*', 'node:*'], logLevel: 'silent', plugins: [{ name: 'container-binding',
      setup(plugin) {
        // Workerd runs the production Worker and Durable Object. Substitute only the SDK's VM transport.
        plugin.onResolve({ filter: /^@cloudflare\/containers$/ }, () => ({ path: 'container-binding', namespace: 'test' }))
        plugin.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: `
          import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
          export class Container extends DurableObject { fetch(request) { return this.env.EXTRACTOR.fetch(request) } }
          export class ContainerProxy extends WorkerEntrypoint {}` }))
      }
    }] })
  const fallbackRequests = []
  const upstreamRequests = []
  const inspections = []
  const options = convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-11-23', compatibilityFlags: ['nodejs_compat'],
    resourcePersistencePath: join(temp, 'worker-state'),
    durableObjects: { DOWNLOADER: { className: 'DownloaderContainer', useSQLite: true } },
    outboundService: live ? undefined : async request => {
      const url = new URL(request.url)
      upstreamRequests.push(url.href)
      if (url.href === 'https://video.fbcdn.net/standard.mp4') {
        return new Response(null, { status: 302, headers: { Location: 'https://example.org/other.mp4' } })
      }
      assert.equal(url.href, 'https://video.fbcdn.net/high.mp4')
      const bytes = await readFile(join(temp, '360.mp4'))
      return new Response(bytes, { headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(bytes.length) } })
    },
    serviceBindings: {
      EXTRACTOR: async request => {
        const path = new URL(request.url).pathname
        if (path === '/download') fallbackRequests.push(path)
        if (path === '/inspect') {
          const { url } = await request.clone().json()
          inspections.push(url)
          if (url.includes('Concurrent')) await new Promise(resolve => setTimeout(resolve, 150))
        }
        return fetch(new URL(path, origin), {
          method: request.method, headers: request.headers, body: request.body, duplex: 'half'
        })
      },
      ASSETS: async request => new Response(await readFile(resolve('.output/public', `.${new URL(request.url).pathname}`)))
    }
  })
  let runtime = new Miniflare(options)
  t.after(() => runtime.dispose())
  const request = (path, options = {}) => runtime.dispatchFetch(`https://downloader.test${path}`, {
    ...options, headers: { Accept: 'application/json', ...options.headers }
  })
  const restartWorker = async () => {
    await runtime.dispose()
    runtime = new Miniflare(options)
  }
  return { request, temp, upstreamRequests, fallbackRequests, inspections, restartWorker }
}

function inspect(request, url) {
  return request('/api/videos/inspect', { method: 'POST', body: JSON.stringify({ url }), headers: { 'Content-Type': 'application/json' } })
}

test('public Worker streams compatible MP4s and falls back for unsafe CDN redirects', { timeout: 45_000 }, async t => {
  const { request, temp, upstreamRequests, fallbackRequests } = await setup(t, false)
  const homepage = await request('/')
  assert.equal(homepage.status, 200)
  assert.match(await homepage.text(), /Save a Facebook video/)
  const css = (await readdir('.output/public/_nuxt')).find(name => name.endsWith('.css'))
  assert.equal((await request(`/_nuxt/${css}`)).status, 200)
  assert.equal((await inspect(request, 'x'.repeat(4100))).status, 400)
  assert.equal((await inspect(request, 'https://example.test/video')).status, 400)
  assert.equal((await inspect(request, 'https://www.facebook.com/reel/404/')).status, 422)
  const result = await inspect(request, 'https://www.facebook.com/share/v/Fixture/')
  assert.equal(result.status, 200)
  const video = await result.json()
  assert.deepEqual(video.qualities.map(quality => quality.resolution.height), [360, 180])
  for (const quality of video.qualities) {
    const returned = await request(`/api/downloads/${quality.id}`)
    assert.equal(returned.status, 200)
    assert.equal(returned.headers.get('Content-Type'), 'video/mp4')
    assert.deepEqual(Buffer.from(await returned.arrayBuffer()), await readFile(join(temp, `${quality.resolution.height}.mp4`)))
  }
  assert.equal((await request('/api/downloads/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')).status, 410)

  const direct = await inspect(request, 'https://www.facebook.com/share/r/SourceQuality/')
  assert.equal(direct.status, 200)
  const { qualities } = await direct.json()
  assert.deepEqual(qualities.map(quality => quality.sourceQuality), ['hd', 'sd'])
  assert.ok(qualities.every(quality => quality.resolution === null))

  const filenames = new Set()
  const previousFallbacks = fallbackRequests.length
  for (const quality of [qualities[0], qualities[1], qualities[0]]) {
    const file = await request(`/api/downloads/${quality.id}`)
    assert.equal(file.status, 200)
    if (quality.sourceQuality === 'hd') assert.match(file.headers.get('Server-Timing'), /facebook_cdn/)
    else assert.match(file.headers.get('Server-Timing'), /^container;dur=\d+;desc="upstream_status"$/)
    const filename = file.headers.get('Content-Disposition')
    assert.match(filename, /^attachment; filename="facebook-video-[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\.mp4"$/)
    filenames.add(filename)
    const height = quality.sourceQuality === 'hd' ? 360 : 180
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), await readFile(join(temp, `${height}.mp4`)))
  }
  assert.equal(filenames.size, 3)
  assert.equal(fallbackRequests.length, previousFallbacks + 1)
  assert.deepEqual(upstreamRequests, [
    'https://video.fbcdn.net/high.mp4', 'https://video.fbcdn.net/standard.mp4', 'https://video.fbcdn.net/high.mp4'
  ])

  const duplicate = await inspect(request, 'https://www.facebook.com/share/r/SourceQualityDuplicate/')
  assert.equal(duplicate.status, 200)
  assert.deepEqual((await duplicate.json()).qualities.map(quality => quality.sourceQuality), ['hd'])
})

test('shares inspections, gives cache hits fresh tickets, and keeps tickets across Worker restarts', { timeout: 45_000 }, async t => {
  const { request, inspections, restartWorker, fallbackRequests } = await setup(t, false)
  const url = 'https://www.facebook.com/share/r/SourceQualityConcurrent/'
  const first = await Promise.all([inspect(request, url), inspect(request, url)])
  for (const res of first) assert.equal(res.status, 200)
  assert.deepEqual(first.map(res => res.headers.get('Server-Timing').match(/desc="(miss|shared)"/)?.[1]).sort(), ['miss', 'shared'])
  assert.ok(first.some(res => /facebook_lookup;dur=\d+/.test(res.headers.get('Server-Timing'))))
  assert.deepEqual(inspections, [url])
  const repeated = await inspect(request, url)
  assert.equal(repeated.headers.get('Server-Timing'), 'inspect_cache;desc="hit"')
  assert.deepEqual(inspections, [url])
  const earlier = await first[0].json()
  await first[1].body.cancel()
  const cached = await repeated.json()
  assert.notEqual(cached.qualities[0].id, earlier.qualities[0].id)

  await restartWorker()
  const download = await request(`/api/downloads/${cached.qualities[0].id}`)
  assert.equal(download.status, 200)
  assert.match(download.headers.get('Server-Timing'), /facebook_cdn/)
  await download.body.cancel()
  assert.equal(fallbackRequests.length, 0)

  const failing = 'https://www.facebook.com/reel/404/'
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await inspect(request, failing)
    assert.equal(res.status, 422)
    await res.body.cancel()
  }
  assert.deepEqual(inspections, [url, failing, failing])
})

test('real authorized Facebook link through the production Worker and extractor adapter', {
  timeout: 220_000, skip: !process.env.DOWNLOADER_TEST_URL
}, async t => {
  const { request, temp } = await setup(t, true)
  const result = await inspect(request, process.env.DOWNLOADER_TEST_URL)
  assert.equal(result.status, 200, await result.clone().text())
  const video = await result.json()
  assert.ok(video.qualities.length > 0)
  const file = await request(`/api/downloads/${video.qualities[0].id}`)
  assert.equal(file.status, 200, file.status === 200 ? undefined : await file.clone().text())
  assert.equal(file.headers.get('Content-Type'), 'video/mp4')
  const path = join(temp, 'result.mp4')
  await writeFile(path, Buffer.from(await file.arrayBuffer()))
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-i', path, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'])
  console.log(file.headers.get('Content-Disposition'))
  console.log(file.headers.get('Server-Timing') ?? 'Used container fallback')
})
