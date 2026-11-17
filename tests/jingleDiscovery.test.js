import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { xml } from '@xmpp/client'
import { callCapabilities, EXTDISCO, iceServersFromServices } from '../src/services/jingleDiscovery.js'

test('publishes an entity capabilities hash matching the discoverable feature set', async () => {
  const caps = await callCapabilities()
  const { node, ver } = caps.presence().attrs
  const query = caps.info(node + '#' + ver)
  assert.equal(query.attrs.node, node + '#' + ver)
  const { category, type, name } = query.getChild('identity').attrs
  const features = query.getChildren('feature').map(item => item.attrs.var)
  const canonical = [category + '/' + type + '//' + name, ...features.sort(), ''].join('<')
  assert.equal(createHash('sha1').update(canonical).digest('base64'), ver)
  assert.ok(features.includes('urn:xmpp:jingle:apps:rtp:video'))
  assert.ok(caps.info('unknown').getChild('item-not-found'))
})

test('converts advertised STUN and TURN services to browser ICE configuration', () => {
  const services = xml('services', { xmlns: EXTDISCO },
    xml('service', { type: 'stun', host: 'stun.example.org', port: '3478', transport: 'udp' }),
    xml('service', { type: 'turns', host: '2001:db8::1', port: '5349', transport: 'tcp', username: 'user', password: 'pass' }),
    xml('service', { type: 'turn', host: 'turn.example.org', restricted: 'true' }),
    xml('service', { type: 'turn', host: 'bad[host]', username: 'user', password: 'pass' }),
    xml('service', { type: 'unrelated', host: 'example.org' }),
    xml('service', { type: 'stun', host: 'example.org', port: '70000' }))
  assert.deepEqual(iceServersFromServices(services), [
    { urls: 'stun:stun.example.org:3478' },
    { urls: 'turns:[2001:db8::1]:5349?transport=tcp', username: 'user', credential: 'pass' },
  ])
})
