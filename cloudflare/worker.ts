import { Container } from '@cloudflare/containers'

interface Env {
  DOWNLOADER: DurableObjectNamespace<DownloaderContainer>
  BETA_ACCESS_AUD: string
}

export class DownloaderContainer extends Container<Env> {
  defaultPort = 3000
  sleepAfter = '10m'
  enableInternet = true
}

function denied(message: string, status: number) {
  return new Response(message, { status, headers: { 'Cache-Control': 'no-store' } })
}

export default {
  async fetch(request, env, ctx) {
    if (!env.BETA_ACCESS_AUD) return denied('Beta access is not configured.', 503)
    const audience = ctx.access?.aud
    const matchesAudience = Array.isArray(audience)
      ? audience.includes(env.BETA_ACCESS_AUD)
      : audience === env.BETA_ACCESS_AUD
    if (!matchesAudience) {
      return denied('This beta requires Cloudflare Access.', 403)
    }

    const forwarded = new Request(request)
    for (const name of [...forwarded.headers.keys()]) {
      if (name === 'cookie' || name === 'authorization' || name.startsWith('cf-access-')) {
        forwarded.headers.delete(name)
      }
    }
    return env.DOWNLOADER.getByName('beta').fetch(forwarded)
  }
} satisfies ExportedHandler<Env>
