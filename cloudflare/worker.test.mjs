import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

// Load the Worker handler in Node without starting the Cloudflare runtime or a container.
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@cloudflare/containers') {
      return { url: 'data:text/javascript,export%20class%20Container%20%7B%7D', shortCircuit: true }
    }
    return nextResolve(specifier, context)
  }
})
const { default: worker } = await import('./worker.ts')
hook.deregister()

test('blocks requests before resolving a container if Access is missing or for another app', async () => {
  const request = new Request('https://beta.example.test/api/videos/inspect', {
    headers: { 'Cf-Access-Jwt-Assertion': 'untrusted-header' }
  })
  const binding = { getByName() { assert.fail('The container must stay idle') } }
  for (const [audience, access, expected] of [
    ['', undefined, 503],
    ['beta-audience', undefined, 403],
    ['beta-audience', { aud: 'other-beta-audience' }, 403]
  ]) {
    const response = await worker.fetch(request, { BETA_ACCESS_AUD: audience, DOWNLOADER: binding }, { access })
    assert.equal(response.status, expected)
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
  }
})

test('forwards an authorized request to the named container without authentication headers', async () => {
  const request = new Request('https://beta.example.test/api/videos/inspect', {
    method: 'POST',
    body: '{"url":"example"}',
    headers: { 'Content-Type': 'application/json', Cookie: 'CF_Authorization=token', 'Cf-Access-Jwt-Assertion': 'token' }
  })
  const response = await worker.fetch(request, {
    BETA_ACCESS_AUD: 'beta-audience',
    DOWNLOADER: {
      getByName(name) {
        assert.equal(name, 'beta')
        return {
          async fetch(forwarded) {
            assert.equal(forwarded.method, 'POST')
            assert.equal(await forwarded.text(), '{"url":"example"}')
            assert.equal(forwarded.headers.get('Content-Type'), 'application/json')
            assert.equal(forwarded.headers.has('Cookie'), false)
            assert.equal(forwarded.headers.has('Cf-Access-Jwt-Assertion'), false)
            return new Response('forwarded')
          }
        }
      }
    }
  }, { access: { aud: ['beta-audience'] } })
  assert.equal(await response.text(), 'forwarded')
})
