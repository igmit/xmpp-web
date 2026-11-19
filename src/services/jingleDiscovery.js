import xml from '@xmpp/xml'
import { JINGLE, JINGLE_MESSAGE, RTP, AUDIO, VIDEO, ICE, DTLS, HEADER_EXT, FEEDBACK } from './jingleNamespaces.js'

export const EXTDISCO = 'urn:xmpp:extdisco:2'
export const CAPS = 'http://jabber.org/protocol/caps'
const DISCO = 'http://jabber.org/protocol/disco#info'
const NODE = 'https://github.com/nioc/xmpp-web'
const identity = { category: 'client', type: 'web', name: 'XMPP Web' }
const features = [
  DISCO, CAPS, JINGLE, JINGLE_MESSAGE, RTP, AUDIO, VIDEO, ICE, DTLS, HEADER_EXT, FEEDBACK,
  'urn:xmpp:ping', 'urn:ietf:rfc:3264', 'urn:ietf:rfc:5576', 'urn:ietf:rfc:5888',
]

// Advertise the same feature set in presence and in the node-specific disco reply (XEP-0115).
export async function callCapabilities (chatFeatures) {
  const advertisedFeatures = [...features, ...chatFeatures].sort()
  const canonical = identity.category + '/' + identity.type + '//' + identity.name + '<' + advertisedFeatures.join('<') + '<'
  const hash = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(canonical))
  const ver = btoa(String.fromCharCode(...new Uint8Array(hash)))
  return {
    presence: () => xml('c', { xmlns: CAPS, hash: 'sha-1', node: NODE, ver }),
    info (node) {
      if (node && node !== NODE + '#' + ver) return stanzaError('item-not-found')
      return xml('query', { xmlns: DISCO, node }, xml('identity', identity),
        ...advertisedFeatures.map(feature => xml('feature', { var: feature })))
    },
  }
}

export function stanzaError (condition, jingleCondition) {
  const errorTypes = {
    'bad-request': 'modify',
    'unexpected-request': 'wait',
    'forbidden': 'auth',
  }
  const type = errorTypes[condition] || 'cancel'
  return xml('error', { type }, xml(condition, { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' }),
    jingleCondition && xml(jingleCondition, { xmlns: 'urn:xmpp:jingle:errors:1' }))
}

// RTCIceServer URLs use a different syntax for STUN and TURN (RFC 7064/7065).
function iceServerUrl ({ type, host, port, transport }) {
  if (!['stun', 'turn', 'turns'].includes(type) || !host || /[^\w.:\-[\]]/.test(host)) return
  if (port && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) return
  if (transport && !['udp', 'tcp'].includes(transport)) return
  if (type === 'stun' && transport === 'tcp') return
  const hostname = host.includes(':') && !host.startsWith('[') ? '[' + host + ']' : host
  try {
    new URL('http://' + hostname)
  } catch {
    return
  }
  return type + ':' + hostname + (port ? ':' + port : '') +
    (type !== 'stun' && transport ? '?transport=' + transport : '')
}

async function resolveIceService (service, requestCredentials) {
  const { type, host, port, transport, restricted, username, password } = service.attrs
  const urls = iceServerUrl(service.attrs)
  if (!urls) return []
  if (type === 'stun') return [{ urls }]
  if (username && password) return [{ urls, username, credential: password }]
  if (!requestCredentials || !['1', 'true'].includes(restricted)) return []

  try {
    const request = xml('credentials', { xmlns: EXTDISCO }, xml('service', { host, type, port }))
    const reply = await requestCredentials(request)
    const servers = []
    for (const entry of reply?.getChildren('service', EXTDISCO) ?? []) {
      const credentials = entry.attrs
      if (credentials.host !== host || credentials.type !== type || !credentials.username || !credentials.password) continue
      if (port && credentials.port && Number(port) !== Number(credentials.port)) continue
      if (transport && credentials.transport && transport !== credentials.transport) continue
      const resolvedUrl = iceServerUrl({ type, host, port: port ?? credentials.port, transport: transport ?? credentials.transport })
      if (resolvedUrl) servers.push({ urls: resolvedUrl, username: credentials.username, credential: credentials.password })
    }
    return servers
  } catch {
    // One unavailable credential service should not discard other ICE servers.
    return []
  }
}

export async function iceServersFromServices (services, requestCredentials) {
  const servers = await Promise.all(services.getChildren('service', EXTDISCO)
    .map(service => resolveIceService(service, requestCredentials)))
  return servers.flat()
}
