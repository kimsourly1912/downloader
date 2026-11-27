import { lookup } from 'node:dns/promises'
import { createServer, STATUS_CODES } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { BlockList, connect } from 'node:net'
import type { AddressInfo, Socket } from 'node:net'
import { allowedExtractionHost } from '../shared/extraction.ts'

// yt-dlp sends every request through this loopback CONNECT proxy. TLS stays end to end, so platforms see
// the extractor's own client, and only allowlisted names on port 443 that resolve to public addresses are reachable.
const maxTunnels = 16
const connectTimeout = 10_000
const idleTimeout = 60_000

// Separate lists because BlockList also matches IPv4 addresses against IPv6 rules through ::ffff:0:0/96.
const reserved = { ipv4: new BlockList(), ipv6: new BlockList() }
const reservedNetworks: Array<[string, number, 'ipv4' | 'ipv6']> = [
  ['0.0.0.0', 8, 'ipv4'], ['10.0.0.0', 8, 'ipv4'], ['100.64.0.0', 10, 'ipv4'], ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'], ['172.16.0.0', 12, 'ipv4'], ['192.0.0.0', 24, 'ipv4'], ['192.0.2.0', 24, 'ipv4'],
  ['192.88.99.0', 24, 'ipv4'], ['192.168.0.0', 16, 'ipv4'], ['198.18.0.0', 15, 'ipv4'], ['198.51.100.0', 24, 'ipv4'],
  ['203.0.113.0', 24, 'ipv4'], ['224.0.0.0', 4, 'ipv4'], ['240.0.0.0', 4, 'ipv4'],
  // IPv6 ranges that are local or can embed an IPv4 address, such as mapped, NAT64, Teredo, and 6to4.
  ['::', 96, 'ipv6'], ['::ffff:0:0', 96, 'ipv6'], ['64:ff9b::', 96, 'ipv6'], ['64:ff9b:1::', 48, 'ipv6'],
  ['100::', 64, 'ipv6'], ['2001::', 32, 'ipv6'], ['2001:db8::', 32, 'ipv6'], ['2002::', 16, 'ipv6'],
  ['fc00::', 7, 'ipv6'], ['fe80::', 10, 'ipv6'], ['ff00::', 8, 'ipv6']
]
for (const [network, prefix, type] of reservedNetworks) reserved[type].addSubnet(network, prefix, type)

export function publicAddress(address: string, family: number): boolean {
  if (family !== 4 && family !== 6) return false
  const type = family === 4 ? 'ipv4' : 'ipv6'
  return !reserved[type].check(address, type)
}

/** Returns the allowlisted hostname from a `host:443` CONNECT target. IP literals and other ports are rejected. */
export function tunnelTarget(target: string | undefined): string | null {
  const host = target?.match(/^([^:[\]]+):443$/)?.[1]
  return host && allowedExtractionHost(host) ? host.toLowerCase().replace(/\.$/, '') : null
}

export interface EgressProxyOptions {
  resolve?: (hostname: string) => Promise<Array<{ address: string, family: number }>>
}

export interface EgressProxy {
  url: string
  close(): Promise<void>
}

function refuse(client: Socket, status: number) {
  if (client.destroyed) return
  client.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

export async function startEgressProxy(options: EgressProxyOptions = {}): Promise<EgressProxy> {
  const resolve = options.resolve ?? (hostname => lookup(hostname, { all: true }))
  let tunnels = 0

  async function openTunnel(request: IncomingMessage, client: Socket, head: Buffer) {
    client.on('error', () => client.destroy())
    const host = tunnelTarget(request.url)
    if (!host) return refuse(client, 403)
    if (tunnels >= maxTunnels) return refuse(client, 429)
    tunnels += 1
    client.once('close', () => { tunnels -= 1 })

    const addresses = await resolve(host).catch(() => [])
    if (client.destroyed) return
    if (!addresses.length) return refuse(client, 502)
    // Reject the name if any record is private so a mixed answer cannot reach internal services.
    if (!addresses.every(item => publicAddress(item.address, item.family))) return refuse(client, 403)
    const address = addresses.find(item => item.family === 4) ?? addresses[0]!

    // Connect to the checked address, not the name, so DNS cannot change between the check and the connection.
    const upstream = connect({ host: address.address, port: 443 })
    let established = false
    upstream.setTimeout(connectTimeout, () => upstream.destroy())
    upstream.on('error', () => upstream.destroy())
    upstream.once('connect', () => {
      established = true
      upstream.setTimeout(idleTimeout)
      client.setTimeout(idleTimeout, () => client.destroy())
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
    })
    upstream.once('close', () => established ? client.destroy() : refuse(client, 502))
    client.once('close', () => upstream.destroy())
  }

  const server = createServer((_request, response) => {
    response.writeHead(405, { Connection: 'close' }).end()
  })
  server.on('connect', (request: IncomingMessage, client: Socket, head: Buffer) => {
    void openTunnel(request, client, head).catch(() => client.destroy())
  })
  server.on('clientError', (_error, socket) => socket.destroy())
  server.maxConnections = 64

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }
}
