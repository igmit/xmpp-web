import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import jid from '@xmpp/jid'
import xml from '@xmpp/xml'
import { RING_TIMEOUT } from '../src/services/JingleCall.js'
import { invitationMessage, readInvitation, receiptMessage } from '../src/services/jingleMessages.js'
import { JINGLE, JINGLE_MESSAGE, RTP } from '../src/services/jingleNamespaces.js'
import { registerJingleCalls } from '../src/services/registerJingleCalls.js'

const CLIENT = 'jabber:client'
const CARBONS = 'urn:xmpp:carbons:2'
const FORWARDED = 'urn:xmpp:forward:0'
const DELAY = 'urn:xmpp:delay'
const RECEIPTS = 'urn:xmpp:receipts'
const HINTS = 'urn:xmpp:hints'
const ALICE = 'alice@example.test/Phone'
const BOB = { bare: 'bob@example.test', full: 'bob@example.test/Browser' }
const SIBLING = 'bob@example.test/Phone'

function stanza (attrs, ...children) {
  return xml('message', { xmlns: CLIENT, type: 'chat', from: ALICE, to: BOB.full, id: 'message-id', ...attrs }, ...children)
}

function action (name, id, ...children) {
  return xml(name, { xmlns: JINGLE_MESSAGE, id }, ...children)
}

function proposal (...media) {
  return action('propose', 'call-id', media.map(item => xml('description', { xmlns: RTP, media: item })))
}

function carbon (type, original, attrs, ...extra) {
  return stanza({ from: BOB.bare, to: BOB.full, ...attrs }, xml(type, { xmlns: CARBONS },
    xml('forwarded', { xmlns: FORWARDED }, original, ...extra)))
}

function delay (attrs) {
  return xml('delay', { xmlns: DELAY, stamp: new Date(Date.now()).toISOString(), ...attrs })
}

test('reads live direct RTP audio or video proposals and the optional receipt request', () => {
  assert.deepEqual(readInvitation(stanza({ to: BOB.bare }, proposal('audio', 'video'), xml('request', { xmlns: RECEIPTS })), BOB), {
    from: ALICE, to: BOB.bare, action: 'propose', id: 'call-id', media: ['audio', 'video'], reason: undefined, receiptId: 'message-id',
  })
  const namespaced = xml('jmi:propose', { 'xmlns:jmi': JINGLE_MESSAGE, id: 'prefixed' }, xml('description', { xmlns: RTP, media: 'audio' }))
  assert.deepEqual(readInvitation(stanza({}, namespaced), BOB), {
    from: ALICE, to: BOB.full, action: 'propose', id: 'prefixed', media: ['audio'], reason: undefined, receiptId: undefined,
  })
  const retract = action('retract', 'call-id', xml('reason', { xmlns: JINGLE }, xml('cancel')))
  assert.equal(readInvitation(stanza({}, retract), BOB).reason, 'cancel')
})

test('ignores malformed invitations, unexpected routing, and unsupported media', () => {
  const malformed = [
    stanza({ from: 'alice@example.test' }, proposal('audio')),
    stanza({ to: SIBLING }, proposal('audio')),
    stanza({ to: undefined }, proposal('audio')),
    stanza({ type: 'groupchat' }, proposal('audio')),
    stanza({ type: 'error' }, proposal('audio')),
    stanza({}, proposal()),
    stanza({}, proposal('video')),
    stanza({}, proposal('audio', 'audio')),
    stanza({}, proposal('audio', 'screen')),
    stanza({}, action('propose', 'call-id', xml('description', { xmlns: 'urn:example:unknown', media: 'audio' }))),
    stanza({}, action('retract', ' ')),
    stanza({}, action('retract', undefined)),
    stanza({}, action('retract', 'call-id'), proposal('audio')),
    stanza({ to: SIBLING }, action('reject', 'call-id')),
  ]
  malformed.forEach(message => assert.equal(readInvitation(message, BOB), null, message.toString()))
  assert.equal(readInvitation(stanza({ id: undefined }, proposal('audio'), xml('request', { xmlns: RECEIPTS })), BOB).receiptId, undefined)
})

test('checks carbon origins and direction before handling live proposals and sibling actions', () => {
  const received = carbon('received', stanza({ to: BOB.bare }, proposal('audio'), xml('request', { xmlns: RECEIPTS })))
  assert.deepEqual(readInvitation(received, BOB), {
    from: ALICE, to: BOB.bare, action: 'propose', id: 'call-id', media: ['audio'], reason: undefined, receiptId: undefined,
  })
  const forged = carbon('received', stanza({}, proposal('audio')), { from: ALICE })
  const wrongTarget = carbon('received', stanza({}, proposal('audio')), { to: SIBLING })
  const copiedFromOtherTarget = carbon('received', stanza({ to: SIBLING }, proposal('audio')))
  const sentFromPeer = carbon('sent', stanza({}, proposal('audio')))
  const wrongDirection = carbon('received', stanza({ from: SIBLING, to: ALICE }, action('proceed', 'call-id')))
  for (const message of [forged, wrongTarget, copiedFromOtherTarget, sentFromPeer, wrongDirection]) {
    assert.equal(readInvitation(message, BOB), null, message.toString())
  }
  const sent = carbon('sent', stanza({ from: SIBLING, to: ALICE }, action('proceed', 'call-id')))
  assert.deepEqual(readInvitation(sent, BOB), {
    from: SIBLING, to: ALICE, action: 'proceed', id: 'call-id', media: undefined, reason: undefined, receiptId: undefined,
  })
  const legacy = stanza({ from: SIBLING, to: BOB.bare }, action('accept', 'call-id'), xml('request', { xmlns: RECEIPTS }))
  assert.equal(readInvitation(legacy, BOB).action, 'accept')
  assert.equal(readInvitation(legacy, BOB).receiptId, undefined)
  assert.equal(readInvitation(stanza({ from: SIBLING }, action('proceed', 'call-id')), BOB), null)
})

test('reads the delivery timestamp on a direct XEP-0203 invitation', () => {
  const stamp = '2026-11-01T10:00:00.123Z'
  for (const from of [undefined, 'example.test', BOB.bare]) {
    const message = stanza({ to: BOB.bare }, proposal('audio'), delay({ from, stamp }))
    assert.equal(readInvitation(message, BOB).delayedAt, Date.parse(stamp))
  }
  const sibling = carbon('sent', stanza({ from: SIBLING, to: ALICE }, action('proceed', 'call-id')))
  sibling.append(delay({ from: 'example.test', stamp }))
  assert.equal(readInvitation(sibling, BOB).delayedAt, Date.parse(stamp))
})

test('ignores malformed delays, archived invitations and delayed forwarded copies', () => {
  const delayedCarbon = stanza({ from: BOB.bare }, delay(),
    ...carbon('received', stanza({}, proposal('audio'))).getChildElements())
  const delayedMessage = carbon('received', stanza({}, proposal('audio'), delay()))
  const archived = stanza({ from: BOB.bare }, proposal('audio'), delay(), xml('result', { xmlns: 'urn:xmpp:mam:2' },
    xml('forwarded', { xmlns: FORWARDED }, stanza({}, proposal('audio'), delay()))))
  const invalid = [
    delayedCarbon, delayedMessage, archived,
    stanza({ from: ALICE }, delay(),
      ...carbon('sent', stanza({ from: SIBLING, to: ALICE }, action('proceed', 'call-id'))).getChildElements()),
    stanza({}, proposal('audio'), delay({ from: ALICE })),
    stanza({}, proposal('audio'), delay({ from: 'other.test' })),
    stanza({}, proposal('audio'), delay({ stamp: undefined })),
    stanza({}, proposal('audio'), delay({ stamp: '2026-02-30T10:00:00Z' })),
    stanza({}, proposal('audio'), delay({ stamp: '2026-11-01' })),
    stanza({ to: SIBLING }, proposal('audio'), delay()),
    stanza({}, proposal('audio'), delay(), delay()),
    stanza({}, proposal('audio'), delay(), xml('x', { xmlns: 'jabber:x:delay' })),
  ]
  for (const message of invalid) assert.equal(readInvitation(message, BOB), null, message.toString())
  const inner = archived.getChild('result').getChild('forwarded').getChild('message')
  assert.equal(readInvitation(inner, BOB), null)
})

function registeredClient (t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date('2026-11-01T10:00:00Z') })
  const client = new EventEmitter()
  const sent = []
  const states = []
  const store = {
    contacts: [{ jid: 'alice@example.test' }],
    set call (value) { states.push(value) },
  }
  const socket = { client, context: { $store: store } }
  client.xmpp = { jid: BOB.full, send: async message => sent.push(message) }
  client.parseJid = address => {
    const parsed = jid(address)
    return { bare: parsed.bare().toString(), full: parsed.toString(), resource: parsed.getResource() }
  }
  client.enableCalls = (receive, handleInvitation) => { client.invitation = handleInvitation }
  registerJingleCalls(socket, client)
  client.emit('online', BOB.full)
  t.after(() => socket.calls?.reset())
  return { client, sent, socket, states }
}

function offlineProposal (id, age = 0, attrs) {
  return stanza({ to: BOB.bare, ...attrs }, action('propose', id, xml('description', { xmlns: RTP, media: 'audio' })),
    delay({ stamp: new Date(Date.now() - age).toISOString() }))
}

test('rings once for a fresh delayed proposal after reconnect, with its remaining lifetime', t => {
  const { client, sent, states } = registeredClient(t)
  client.emit('status', 'disconnect')
  client.emit('resumed')
  const message = offlineProposal('outstanding', RING_TIMEOUT - 1000)
  const duplicate = stanza({ to: BOB.bare }, action('propose', 'outstanding', xml('description', { xmlns: RTP, media: 'audio' })))
  assert.equal(client.invitation(message), true)
  assert.equal(client.invitation(offlineProposal('outstanding')), true)
  assert.equal(client.invitation(duplicate), true)
  assert.deepEqual(states, [])
  assert.deepEqual(sent, [])
  t.mock.timers.tick(750)
  assert.equal(states.at(-1).phase, 'incoming')
  assert.equal(sent[0].getChild('ringing', JINGLE_MESSAGE).attrs.id, 'outstanding')
  t.mock.timers.tick(249)
  assert.equal(states.at(-1).phase, 'incoming')
  t.mock.timers.tick(1)
  assert.equal(states.at(-1).reason, 'timeout')
  client.invitation(message)
  client.invitation(duplicate)
  t.mock.timers.tick(2000)
  assert.equal(states.filter(state => state?.phase === 'incoming').length, 1)
})

test('reconciles delayed and live terminal actions on either side of buffered proposals', t => {
  const { client, sent, states } = registeredClient(t)
  client.invitation(stanza({}, action('finish', 'finished'), delay()))
  client.invitation(offlineProposal('finished'))
  client.invitation(offlineProposal('canceled'))
  t.mock.timers.tick(600)
  client.invitation(offlineProposal('declined'))
  t.mock.timers.tick(200)
  client.invitation(stanza({}, action('retract', 'canceled'), delay()))
  client.invitation(carbon('sent', stanza({ from: SIBLING, to: ALICE }, action('proceed', 'answered'))))
  client.invitation(offlineProposal('answered'))
  const declined = carbon('sent', stanza({ from: SIBLING, to: ALICE }, action('reject', 'declined')))
  declined.append(delay({ from: 'example.test' }))
  assert.equal(client.invitation(declined), true)
  client.invitation(offlineProposal('legacy-rejection'))
  client.invitation(stanza({ from: SIBLING, to: BOB.bare }, action('reject', 'legacy-rejection'), delay()))

  t.mock.timers.tick(2000)
  assert.deepEqual(states, [])
  assert.deepEqual(sent, [])
})

test('ignores stale, future, unauthorized and still-buffered invitations that expire', t => {
  const { client, sent, states } = registeredClient(t)
  client.invitation(offlineProposal('already-expired', RING_TIMEOUT))
  client.invitation(offlineProposal('future', -1))
  client.invitation(offlineProposal('expires-in-queue', RING_TIMEOUT - 250))
  client.invitation(offlineProposal('unrecognized-contact', 0, { from: 'unknown@example.test/Other' }))
  t.mock.timers.tick(2000)
  assert.deepEqual(states, [])
  assert.deepEqual(sent, [])
})

test('matches terminal actions to the caller resource and clears pending invites on rebind or logout', t => {
  const { client, sent, socket, states } = registeredClient(t)
  client.invitation(offlineProposal('distinct-caller'))
  client.invitation(stanza({ from: 'alice@example.test/Other' }, action('retract', 'distinct-caller'), delay()))
  client.invitation(carbon('sent', stanza({ from: SIBLING, to: 'alice@example.test/Other' }, action('proceed', 'distinct-caller'))))
  t.mock.timers.tick(750)
  assert.equal(states.at(-1).phase, 'incoming')
  client.invitation(stanza({}, action('retract', 'distinct-caller')))
  assert.equal(states.at(-1).reason, 'cancel')

  client.invitation(offlineProposal('disconnect'))
  client.emit('status', 'disconnect')
  client.emit('resumed')
  t.mock.timers.tick(2000)
  assert.equal(states.at(-1).reason, 'cancel')

  client.invitation(offlineProposal('old-resource'))
  client.emit('online', 'bob@example.test/New')
  t.mock.timers.tick(2000)
  assert.equal(states.at(-1), null)

  client.invitation(offlineProposal('logout'))
  socket.client = null
  t.mock.timers.tick(2000)
  assert.equal(states.at(-1), null)
  assert.equal(sent.length, 1)
})

test('creates separate chat stanza IDs for JMI responses and receipts', () => {
  const proceed = invitationMessage(ALICE, 'proceed', 'call-id')
  const reject = invitationMessage(ALICE, 'reject', 'call-id', { reason: 'busy' })
  const receipt = receiptMessage(ALICE, 'message-id')
  for (const message of [proceed, reject, receipt]) {
    assert.equal(message.attrs.to, ALICE)
    assert.equal(message.attrs.type, 'chat')
    assert.ok(message.attrs.id)
  }
  assert.equal(new Set([proceed.attrs.id, reject.attrs.id, receipt.attrs.id, 'call-id', 'message-id']).size, 5)
  assert.ok(proceed.getChild('store', HINTS))
  assert.equal(proceed.getChild('proceed', JINGLE_MESSAGE).attrs.id, 'call-id')
  assert.ok(reject.getChild('reject', JINGLE_MESSAGE).getChild('reason', JINGLE).getChild('busy', JINGLE))
  assert.equal(receipt.getChild('received', RECEIPTS).attrs.id, 'message-id')
  assert.ok(receipt.getChild('no-store', HINTS))
  assert.ok(receipt.getChild('no-copy', HINTS))
})
