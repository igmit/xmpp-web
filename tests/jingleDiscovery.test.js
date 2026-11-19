import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { xml } from '@xmpp/client'
import { callCapabilities, iceServersFromServices } from '../src/services/jingleDiscovery.js'
import { EXTDISCO } from '../src/services/jingleNamespaces.js'

test('publishes an entity capabilities hash matching the discoverable feature set', async () => {
  const chatFeatures = ['http://jabber.org/protocol/chatstates', 'urn:xmpp:reactions:0']
  const caps = await callCapabilities(chatFeatures)
  const { node, ver } = caps.presence().attrs
  const query = caps.info(node + '#' + ver)
  assert.equal(query.attrs.node, node + '#' + ver)
  const { category, type, name } = query.getChild('identity').attrs
  const features = query.getChildren('feature').map(item => item.attrs.var)
  const canonical = [category + '/' + type + '//' + name, ...features.sort(), ''].join('<')
  assert.equal(createHash('sha1').update(canonical).digest('base64'), ver)
  assert.ok(features.includes('urn:xmpp:jingle:apps:rtp:video'))
  assert.ok(features.includes('urn:xmpp:jingle-message:0'))
  for (const feature of chatFeatures) assert.ok(features.includes(feature))
  assert.ok(caps.info('unknown').getChild('item-not-found'))
})

test('converts advertised STUN and TURN services to browser ICE configuration', async () => {
  const services = xml('services', { xmlns: EXTDISCO },
    xml('service', { type: 'stun', host: 'stun.example.org', port: '3478', transport: 'udp' }),
    xml('service', { type: 'turns', host: '2001:db8::1', port: '5349', transport: 'tcp', username: 'user', password: 'pass' }),
    xml('service', { type: 'turn', host: 'turn.example.org', restricted: 'true' }),
    xml('service', { type: 'turn', host: 'bad[host]', username: 'user', password: 'pass' }),
    xml('service', { type: 'unrelated', host: 'example.org' }),
    xml('service', { type: 'stun', host: 'example.org', port: '70000' }))
  assert.deepEqual(await iceServersFromServices(services), [
    { urls: 'stun:stun.example.org:3478' },
    { urls: 'turns:[2001:db8::1]:5349?transport=tcp', username: 'user', credential: 'pass' },
  ])
})

test('requests credentials for restricted TURN services and keeps working servers on failure', async () => {
  const services = xml('services', { xmlns: EXTDISCO },
    xml('service', { type: 'stun', host: 'stun.example.org' }),
    xml('service', { type: 'turns', host: 'relay.example.org', port: '5349', transport: 'tcp', restricted: '1' }),
    xml('service', { type: 'turn', host: 'unavailable.example.org', restricted: 'true' }),
    xml('service', { type: 'turn', host: 'inline.example.org', restricted: 'true', username: 'inline', password: 'inline-pass' }))
  const requests = []
  const servers = await iceServersFromServices(services, async request => {
    assert.ok(request.is('credentials', EXTDISCO))
    const service = request.getChild('service', EXTDISCO)
    requests.push(service.attrs)
    if (service.attrs.host === 'unavailable.example.org') throw new Error('service-unavailable')
    return xml('credentials', { xmlns: EXTDISCO },
      xml('service', { ...service.attrs, port: '443', username: 'unexpected', password: 'unexpected-pass' }),
      xml('service', { ...service.attrs, username: 'temporary', password: 'temporary-pass' }))
  })
  assert.deepEqual(requests, [
    { type: 'turns', host: 'relay.example.org', port: '5349' },
    { type: 'turn', host: 'unavailable.example.org' },
  ])
  assert.deepEqual(servers, [
    { urls: 'stun:stun.example.org' },
    { urls: 'turns:relay.example.org:5349?transport=tcp', username: 'temporary', credential: 'temporary-pass' },
    { urls: 'turn:inline.example.org', username: 'inline', credential: 'inline-pass' },
  ])
})
