import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { build } from 'esbuild'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { convertV4MiniflareOptions, Miniflare } from 'miniflare'

const issuer = 'https://beta-fixture.cloudflareaccess.com'
const audience = 'test-app-audience'

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
        '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '1', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', join(temp, `${height}.mp4`)])
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

  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const publicJwk = { ...await exportJWK(publicKey), kid: 'fixture', alg: 'RS256' }
  const signed = target => new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'fixture' })
    .setIssuer(issuer).setAudience(target).setExpirationTime('5m').sign(privateKey)
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
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-11-23', compatibilityFlags: ['nodejs_compat'],
    bindings: { BETA_ACCESS_AUD: audience, BETA_ACCESS_TEAM: new URL(issuer).hostname },
    durableObjects: { DOWNLOADER: { className: 'DownloaderContainer', useSQLite: true } },
    outboundService: request => request.url === `${issuer}/cdn-cgi/access/certs`
      ? Response.json({ keys: [publicJwk] }) : new Response('Unexpected outbound fetch', { status: 502 }),
    serviceBindings: {
      EXTRACTOR: request => fetch(new URL(new URL(request.url).pathname, origin), {
        method: request.method, headers: request.headers, body: request.body, duplex: 'half'
      }),
      ASSETS: async request => new Response(await readFile(resolve('.output/public', `.${new URL(request.url).pathname}`)))
    }
  }))
  t.after(() => runtime.dispose())
  const token = await signed(audience)
  const request = (path, options = {}, credential = token) => runtime.dispatchFetch(`https://downloader.test${path}`, {
    ...options, headers: { Accept: 'application/json', ...(credential ? { 'Cf-Access-Jwt-Assertion': credential } : {}), ...options.headers }
  })
  return { request, signed, temp }
}

function inspect(request, url) {
  return request('/api/videos/inspect', { method: 'POST', body: JSON.stringify({ url }), headers: { 'Content-Type': 'application/json' } })
}

test('built Worker checks Access, uses Nitro and streams valid files from its container binding', { timeout: 45_000 }, async t => {
  const { request, signed, temp } = await setup(t, false)
  assert.equal((await request('/', {}, null)).status, 403)
  assert.equal((await request('/', {}, await signed('wrong-audience'))).status, 403)
  assert.match(await (await request('/')).text(), /Save a Facebook video/)
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
})
