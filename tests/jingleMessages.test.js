import assert from 'node:assert/strict'
import { test } from 'node:test'
import xml from '@xmpp/xml'
import { invitationMessage, readInvitation, receiptMessage } from '../src/services/jingleMessages.js'
import { JINGLE, JINGLE_MESSAGE, RTP } from '../src/services/jingleNamespaces.js'

const CLIENT = 'jabber:client'
const CARBONS = 'urn:xmpp:carbons:2'
const FORWARDED = 'urn:xmpp:forward:0'
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
    stanza({}, action('reject', 'call-id')),
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

test('ignores delayed and archived invitations, including forwarded copies', () => {
  const delay = () => xml('delay', { xmlns: 'urn:xmpp:delay', stamp: '2026-11-01T10:00:00Z' })
  const old = stanza({}, proposal('audio'), delay())
  const delayedCarbon = carbon('received', stanza({}, proposal('audio')), {}, delay())
  const delayedMessage = carbon('received', old)
  const archived = stanza({ from: BOB.bare }, xml('result', { xmlns: 'urn:xmpp:mam:2' },
    xml('forwarded', { xmlns: FORWARDED }, stanza({}, proposal('audio')))))
  for (const message of [old, delayedCarbon, delayedMessage, archived]) assert.equal(readInvitation(message, BOB), null)
  const inner = archived.getChild('result').getChild('forwarded').getChild('message')
  assert.equal(readInvitation(inner, BOB), null)
})

test('creates separate chat stanza IDs for JMI responses and receipts', () => {
  const proceed = invitationMessage(ALICE, 'proceed', 'call-id')
  const reject = invitationMessage(ALICE, 'reject', 'call-id', 'busy')
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
