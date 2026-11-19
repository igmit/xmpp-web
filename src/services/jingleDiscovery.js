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
export function iceServersFromServices (services) {
  const servers = []
  for (const service of services.getChildren('service', EXTDISCO)) {
    const { type, host, port, transport, username, password } = service.attrs
    if (!['stun', 'turn', 'turns'].includes(type) || !host || /[^\w.:\-[\]]/.test(host)) continue
    if (port && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) continue
    if (transport && !['udp', 'tcp'].includes(transport)) continue
    if (type === 'stun' && transport === 'tcp') continue
    const hostname = host.includes(':') && !host.startsWith('[') ? '[' + host + ']' : host
    try {
      new URL('http://' + hostname)
    } catch {
      continue
    }
    const server = { urls: type + ':' + hostname + (port ? ':' + port : '') }
    if (type !== 'stun') {
      if (!username || !password) continue
      if (transport) server.urls += '?transport=' + transport
      server.username = username
      server.credential = password
    }
    servers.push(server)
  }
  return servers
}
