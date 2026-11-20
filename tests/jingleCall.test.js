import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, test } from 'node:test'
import { setImmediate, setTimeout } from 'node:timers/promises'
import { xml } from '@xmpp/client'
import JingleCall from '../src/services/JingleCall.js'
import { JINGLE, RTP } from '../src/services/jingleNamespaces.js'
import { descriptionToJingle } from '../src/services/jingleMedia.js'
import { registerJingleCalls } from '../src/services/registerJingleCalls.js'

const ALICE = 'alice@example.org/Browser'
const BOB = 'bob@example.org/Browser'
const ICE = 'urn:xmpp:jingle:transports:ice-udp:1'
const fingerprint = Array(32).fill('A1').join(':')
const candidate = 'candidate:1 1 UDP 2122260223 192.0.2.1 50900 typ host generation 0'

function offerSdp (video) {
  const media = (kind, mid, id, codec) => [
    `m=${kind} 9 UDP/TLS/RTP/SAVPF ${id}`, 'c=IN IP4 0.0.0.0', `a=mid:${mid}`, 'a=sendrecv', 'a=rtcp-mux',
    'a=ice-ufrag:test', 'a=ice-pwd:abcdefghijklmnopqrstuvwxyz', 'a=setup:actpass',
    `a=fingerprint:sha-256 ${fingerprint}`, `a=rtpmap:${id} ${codec}`,
  ]
  return [
    'v=0', 'o=- 123 1 IN IP4 127.0.0.1', 's=-', 't=0 0',
    ...(video ? ['a=group:BUNDLE 0 1'] : []),
    ...media('audio', 0, 111, 'opus/48000/2'),
    ...(video ? media('video', 1, 96, 'VP8/90000') : []),
    '',
  ].join('\r\n')
}

function setup (ownJid, options = {}) {
  const sent = []
  const invitations = []
  const states = []
  const controller = new JingleCall({
    ownJid,
    send: async (peer, stanza) => sent.push({ peer, stanza }),
    sendInvitation: async (peer, action, sid, { reason, ...details } = {}) => invitations.push({ peer, action, sid, reason, ...details }),
    onChange: state => states.push(state),
    ...options,
  })
  return { controller, invitations, sent, states }
}

function request (action, sid, ...children) {
  return xml('jingle', { xmlns: JINGLE, action, sid }, ...children)
}

function invitationOffer (sid, video = false) {
  return request('session-initiate', sid, ...descriptionToJingle(offerSdp(video), 'initiator'))
}

class FakeTrack extends EventTarget {
  constructor (kind) {
    super()
    this.kind = kind
    this.stopped = false
    this.readyState = 'live'
    this.muted = false
  }

  setMuted (muted) {
    this.muted = muted
    this.dispatchEvent(new Event(muted ? 'mute' : 'unmute'))
  }

  stop () {
    this.stopped = true
    this.readyState = 'ended'
  }
}

class FakeStream {
  constructor (tracks = []) { this.tracks = tracks }
  getTracks () { return this.tracks }
  getAudioTracks () { return this.tracks.filter(track => track.kind === 'audio') }
  removeTrack (track) { this.tracks = this.tracks.filter(item => item !== track) }
  addTrack (track) { this.tracks.push(track) }
}

class FakePeer extends EventTarget {
  constructor (config) {
    super()
    this.config = config
    this.tracks = []
    this.candidates = []
    this.connectionState = 'new'
    this.iceGatheringState = 'new'
    FakePeer.instances.push(this)
  }

  addTrack (track) {
    this.tracks.push(track)
    return { track, async replaceTrack (replacement) { this.track = replacement } }
  }

  async createOffer () {
    return { type: 'offer', sdp: offerSdp(this.tracks.some(track => track.kind === 'video')) }
  }

  async createAnswer () {
    return { type: 'answer', sdp: this.remoteDescription.sdp.replaceAll('a=setup:actpass', 'a=setup:active') }
  }

  async setLocalDescription (description) {
    this.localDescription = description
    this.iceGatheringState = 'gathering'
  }

  async setRemoteDescription (description) { this.remoteDescription = description }

  gather (value = candidate) {
    this.localDescription.sdp += `a=${value}\r\n`
    this.onicecandidate?.()
  }

  async addIceCandidate (value) { this.candidates.push(value) }

  connect () {
    this.connectionState = 'connected'
    this.onconnectionstatechange?.()
  }

  close () { this.connectionState = 'closed' }
}

const globals = ['navigator', 'MediaStream', 'RTCPeerConnection']
const descriptors = globals.map(key => Object.getOwnPropertyDescriptor(globalThis, key))
let captureRequests

function mockCapture (getUserMedia) {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia } } })
}

beforeEach(() => {
  captureRequests = []
  FakePeer.instances = []
  mockCapture(async constraints => {
    captureRequests.push(constraints)
    return new FakeStream([new FakeTrack('audio'), ...(constraints.video ? [new FakeTrack('video')] : [])])
  })
  globalThis.MediaStream = FakeStream
  globalThis.RTCPeerConnection = FakePeer
})

afterEach(() => {
  globals.forEach((key, index) => {
    if (descriptors[index]) Object.defineProperty(globalThis, key, descriptors[index])
    else delete globalThis[key]
  })
})

async function startActiveCall (controller, sent) {
  await controller.start(BOB)
  const pc = FakePeer.instances.at(-1)
  const [{ stanza: offer }] = sent
  const answer = offerSdp(false).replaceAll('a=setup:actpass', 'a=setup:active')
  await controller.receive(BOB, request('session-accept', offer.attrs.sid, ...descriptionToJingle(answer, 'responder')))
  pc.connect()
  return pc
}

function registerTestClient (t) {
  const client = new EventEmitter()
  const sent = []
  client.xmpp = { jid: ALICE }
  client.parseJid = full => ({ full })
  client.getIceServers = async () => []
  client.sendJingle = async (peer, stanza) => sent.push({ peer, stanza })
  client.enableCalls = () => {}
  const store = {}
  const socket = { client, context: { $store: store } }
  registerJingleCalls(socket, client)
  client.emit('online', ALICE)
  t.after(() => socket.calls.reset())
  return { client, sent, socket, store }
}

test('keeps active media on XMPP resume or a fresh bind with the same full JID', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { client, sent, socket, store } = registerTestClient(t)
  const controller = socket.calls
  const pc = await startActiveCall(controller, sent)

  client.emit('status', 'disconnect')
  t.mock.timers.tick(20000)
  client.emit('resumed')
  t.mock.timers.tick(15000)
  client.emit('status', 'close')
  t.mock.timers.tick(20000)
  client.emit('online', ALICE)
  t.mock.timers.tick(15000)
  assert.equal(store.call.phase, 'active')
  assert.equal(socket.calls, controller)
  assert.equal(pc.connectionState, 'connected')
  assert.equal(pc.tracks[0].stopped, false)

  client.emit('status', 'disconnect')
  client.emit('online', 'alice@example.org/New')
  assert.notEqual(socket.calls, controller)
  assert.equal(pc.connectionState, 'closed')
  assert.equal(store.call, null)
})

test('ends active media when loss of XMPP signaling exceeds the grace period', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { client, sent, socket, store } = registerTestClient(t)
  const pc = await startActiveCall(socket.calls, sent)
  client.emit('status', 'close')
  t.mock.timers.tick(29000)
  assert.equal(pc.connectionState, 'connected')
  client.emit('status', 'disconnect')
  t.mock.timers.tick(1000)
  assert.equal(pc.connectionState, 'closed')
  assert.ok(pc.tracks[0].stopped)
  assert.equal(store.call.phase, 'ended')
  assert.match(store.call.error, /XMPP connection was lost/)
  client.emit('resumed')
  assert.equal(store.call.phase, 'ended')
})

test('gives the call peer time to return on the same resource', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { controller, sent, states } = setup(ALICE)
  t.after(() => controller.reset())
  const pc = await startActiveCall(controller, sent)
  controller.peerAvailabilityChanged(BOB, false)
  t.mock.timers.tick(20000)
  controller.peerAvailabilityChanged(BOB, true)
  t.mock.timers.tick(15000)
  assert.equal(pc.connectionState, 'connected')

  controller.peerAvailabilityChanged(BOB, false)
  controller.peerAvailabilityChanged('bob@example.org/Other', true)
  t.mock.timers.tick(30000)
  assert.equal(pc.connectionState, 'closed')
  assert.equal(states.at(-1).reason, 'gone')
  assert.equal(sent.at(-1).stanza.attrs.action, 'session-terminate')
})

for (const video of [false, true]) {
  test(`connects and ends a ${video ? 'video and audio' : 'voice'} call using trickle ICE`, async t => {
    const iceServers = [{ urls: 'turn:turn.example.org', username: 'user', credential: 'credential' }]
    const alice = setup(ALICE, { iceServers: async () => iceServers })
    const bob = setup(BOB)
    t.after(() => {
      alice.controller.reset()
      bob.controller.reset()
    })

    const starting = alice.controller.start(BOB, video)
    assert.equal(alice.states.at(-1).phase, 'outgoing')
    await starting
    const [alicePc] = FakePeer.instances
    assert.deepEqual(alicePc.config.iceServers, iceServers)

    const offer = alice.sent[0].stanza
    assert.equal(offer.attrs.action, 'session-initiate')
    assert.equal(offer.attrs.initiator, ALICE)
    assert.equal(alice.sent[0].peer, BOB)
    assert.equal(offer.getChildren('content').length, video ? 2 : 1)
    assert.equal(offer.getChildren('content').at(-1).getChild('transport', ICE).getChild('candidate', ICE), undefined)
    await bob.controller.receive(ALICE, offer)
    assert.equal(bob.states.at(-1).phase, 'incoming')
    assert.equal(bob.states.at(-1).video, video)
    assert.equal(captureRequests.length, 1)
    alicePc.gather()
    const trickle = alice.sent.at(-1).stanza
    assert.equal(trickle.attrs.action, 'transport-info')
    assert.ok(trickle.getChild('content').getChild('transport', ICE).getChild('candidate', ICE))
    await bob.controller.receive(ALICE, trickle)

    const accepting = bob.controller.accept()
    assert.equal(bob.states.at(-1).phase, 'connecting')
    await accepting
    const bobPc = FakePeer.instances[1]
    assert.deepEqual(captureRequests, [{ audio: true, video }, { audio: true, video }])
    assert.equal(bobPc.candidates.length, 1)

    const answer = bob.sent.find(({ stanza }) => stanza.attrs.action === 'session-accept').stanza
    assert.equal(answer.attrs.sid, offer.attrs.sid)
    assert.equal(answer.attrs.responder, BOB)
    await alice.controller.receive(BOB, answer)
    bobPc.gather()
    await alice.controller.receive(BOB, bob.sent.at(-1).stanza)
    assert.equal(alicePc.candidates.length, 1)
    assert.equal(alice.states.at(-1).phase, 'connecting')
    alicePc.connect()
    bobPc.connect()
    assert.equal(alice.states.at(-1).phase, 'active')
    assert.equal(bob.states.at(-1).phase, 'active')
    const remoteTrack = new FakeTrack('audio')
    alicePc.ontrack({ track: remoteTrack })
    assert.deepEqual(alice.states.at(-1).remoteStream.getTracks(), [remoteTrack])

    await alice.controller.end()
    const goodbye = alice.sent.at(-1).stanza
    assert.equal(goodbye.attrs.action, 'session-terminate')
    assert.ok(goodbye.getChild('reason').getChild('success'))
    await bob.controller.receive(ALICE, goodbye)
    for (const [call, pc] of [[alice, alicePc], [bob, bobPc]]) {
      assert.equal(call.states.at(-1).phase, 'ended')
      assert.equal(call.states.at(-1).localStream, null)
      assert.equal(call.states.at(-1).remoteStream, null)
      assert.equal(pc.connectionState, 'closed')
      assert.ok(pc.tracks.every(track => track.stopped))
    }
    assert.ok(remoteTrack.stopped)
    await alice.controller.end()
    assert.equal(alice.states.at(-1), null)
  })
}

test('buffers valid trickle ICE and rejects actions from another resource or session', async t => {
  const bob = setup(BOB)
  t.after(() => bob.controller.reset())
  const offer = request('session-initiate', 'main', ...descriptionToJingle(offerSdp(false), 'initiator'))
  await bob.controller.receive(ALICE, offer)
  const content = xml('content', { creator: 'initiator', name: '0' }, xml('transport', { xmlns: ICE, ufrag: 'test' },
    xml('candidate', { foundation: '1', component: '1', protocol: 'udp', priority: '2122260223', ip: '192.0.2.2', port: '50901', type: 'host' })))
  const trickle = request('transport-info', 'main', content)
  await assert.rejects(bob.controller.receive('alice@example.org/Other', trickle), { condition: 'item-not-found', jingleCondition: 'unknown-session' })
  await assert.rejects(bob.controller.receive(ALICE, request('session-terminate', 'old')), { condition: 'item-not-found', jingleCondition: 'unknown-session' })
  await assert.rejects(bob.controller.receive(ALICE, request('session-accept', 'main')), { condition: 'unexpected-request', jingleCondition: 'out-of-order' })
  await bob.controller.receive(ALICE, trickle)
  assert.equal(FakePeer.instances.length, 0)

  await bob.controller.accept()
  const [pc] = FakePeer.instances
  assert.deepEqual(pc.candidates.map(value => value.sdpMid), ['0'])
  assert.match(pc.candidates[0].candidate, /192\.0\.2\.2/)
})

test('uses the Jingle termination condition when explanatory text comes first', async t => {
  const { controller, states } = setup(BOB)
  t.after(() => controller.reset())
  await controller.receive(ALICE, invitationOffer('call'))
  await controller.receive(ALICE, request('session-terminate', 'call', xml('reason', {},
    xml('text', {}, 'The contact declined.'), xml('busy', { xmlns: 'urn:example:other' }), xml('decline'))))
  assert.equal(states.at(-1).reason, 'decline')
  assert.match(states.at(-1).error, /declined/)
})

test('rejects an offered video upgrade without renegotiating the current call', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { controller, sent, states } = setup(ALICE)
  t.after(() => controller.reset())
  const pc = await startActiveCall(controller, sent)
  const sid = sent[0].stanza.attrs.sid
  const upgrade = name => request('content-add', sid, xml('content', { name, creator: 'responder', senders: 'responder' },
    xml('description', { xmlns: RTP, media: 'video' }, xml('payload-type', { id: '96', name: 'VP8' })),
    xml('transport', { xmlns: ICE, ufrag: 'test', pwd: 'abcdefghijklmnopqrstuvwxyz' })))
  await assert.rejects(controller.receive(BOB, upgrade('0')), { condition: 'bad-request' })
  await controller.receive(BOB, upgrade('camera'))
  assert.equal(sent.length, 1)
  t.mock.timers.tick(1)
  const reject = sent.at(-1).stanza
  assert.equal(reject.attrs.action, 'content-reject')
  assert.equal(reject.attrs.sid, sid)
  const content = reject.getChild('content', JINGLE)
  assert.deepEqual(content.attrs, { name: 'camera', creator: 'responder', senders: 'responder' })
  assert.equal(content.getChild('description', RTP).attrs.media, 'video')
  assert.ok(content.getChild('transport', ICE))
  assert.equal(states.at(-1).phase, 'active')
  assert.equal(pc.connectionState, 'connected')
})

test('signals busy for another call and decline for the currently ringing call', async t => {
  const bob = setup(BOB)
  t.after(() => bob.controller.reset())
  const offer = sid => request('session-initiate', sid, ...descriptionToJingle(offerSdp(false), 'initiator'))
  const other = 'carol@example.org/Browser'
  await bob.controller.receive(ALICE, offer('main'))
  await bob.controller.receive(other, offer('second'))
  await setTimeout(5)
  const busy = bob.sent.find(({ peer }) => peer === other).stanza
  assert.equal(busy.attrs.sid, 'second')
  assert.ok(busy.getChild('reason').getChild('busy'))
  assert.equal(bob.states.at(-1).peer, ALICE)
  assert.equal(bob.states.at(-1).phase, 'incoming')

  await bob.controller.end()
  const decline = bob.sent.at(-1).stanza
  assert.equal(decline.attrs.sid, 'main')
  assert.ok(decline.getChild('reason').getChild('decline'))
  assert.equal(captureRequests.length, 0)
})

test('cleans up a stale permission request after canceling the outgoing call', async t => {
  const alice = setup(ALICE)
  t.after(() => alice.controller.reset())
  let grant
  mockCapture(() => new Promise(resolve => { grant = resolve }))
  const starting = alice.controller.start(BOB)
  await alice.controller.end()
  await starting
  assert.equal(alice.states.at(-1).reason, 'cancel')
  assert.equal(alice.sent.length, 0)

  const track = new FakeTrack('audio')
  grant(new FakeStream([track]))
  await setImmediate()
  assert.ok(track.stopped)
  assert.equal(FakePeer.instances.length, 0)
})

test('can retry a microphone that is already ended at setup and releases a late grant on hangup', async t => {
  const alice = setup(ALICE)
  t.after(() => alice.controller.reset())
  const ended = new FakeTrack('audio')
  ended.stop()
  mockCapture(async () => new FakeStream([ended]))
  await alice.controller.start(BOB)
  assert.equal(alice.states.at(-1).microphoneStatus, 'unavailable')

  mockCapture(async () => { throw Object.assign(new Error(), { name: 'NotAllowedError' }) })
  await alice.controller.reconnectMicrophone()
  assert.equal(alice.states.at(-1).microphoneStatus, 'unavailable')
  assert.match(alice.states.at(-1).microphoneError, /Allow microphone access/)

  let grant
  let requests = 0
  mockCapture(() => {
    requests++
    return new Promise(resolve => { grant = resolve })
  })
  const recovery = alice.controller.reconnectMicrophone()
  await alice.controller.reconnectMicrophone()
  assert.equal(requests, 1)
  assert.equal(alice.states.at(-1).microphoneStatus, 'reconnecting')
  await alice.controller.end()
  const late = new FakeTrack('audio')
  grant(new FakeStream([late]))
  await recovery
  assert.ok(late.stopped)
  assert.equal(alice.states.at(-1).phase, 'ended')
})

test('distinguishes microphone mute, unmute and loss and observes the replacement track', async t => {
  const { controller, sent, states } = setup(ALICE)
  t.after(() => controller.reset())
  const pc = await startActiveCall(controller, sent)
  const [track] = pc.tracks
  track.setMuted(true)
  assert.equal(states.at(-1).microphoneStatus, 'muted')
  track.setMuted(false)
  assert.equal(states.at(-1).microphoneStatus, null)
  track.setMuted(true)
  track.stop()
  track.dispatchEvent(new Event('ended'))
  assert.equal(states.at(-1).microphoneStatus, 'unavailable')

  await controller.reconnectMicrophone()
  const [replacement] = states.at(-1).localStream.getAudioTracks()
  assert.notEqual(replacement, track)
  const state = states.at(-1)
  track.setMuted(false)
  assert.equal(states.at(-1), state)
  replacement.setMuted(true)
  assert.equal(states.at(-1).microphoneStatus, 'muted')
  replacement.setMuted(false)
  assert.equal(states.at(-1).microphoneStatus, null)
  await controller.end()
  const ended = states.at(-1)
  replacement.setMuted(true)
  assert.equal(states.at(-1), ended)
})

test('cancels an async ICE lookup and closes captured media on disconnect', async t => {
  let resolveIceServers
  const alice = setup(ALICE, { iceServers: () => new Promise(resolve => { resolveIceServers = resolve }) })
  t.after(() => alice.controller.reset())
  const track = new FakeTrack('audio')
  mockCapture(async () => new FakeStream([track]))
  const starting = alice.controller.start(BOB)
  await setImmediate()
  alice.controller.reset()
  await starting
  assert.equal(alice.states.at(-1), null)
  assert.ok(track.stopped)
  resolveIceServers([])
  await setImmediate()
  assert.equal(alice.sent.length, 0)
  assert.equal(FakePeer.instances.length, 0)
})

test('reports denied camera permission after acceptance and signals a failed session', async t => {
  const bob = setup(BOB)
  t.after(() => bob.controller.reset())
  mockCapture(async () => { throw new DOMException('Permission denied', 'NotAllowedError') })
  await bob.controller.receive(ALICE, request('session-initiate', 'offer', ...descriptionToJingle(offerSdp(true), 'initiator')))
  assert.equal(bob.states.at(-1).phase, 'incoming')
  await bob.controller.accept()
  assert.equal(bob.states.at(-1).phase, 'ended')
  assert.match(bob.states.at(-1).error, /microphone and camera access/)
  assert.ok(bob.sent.at(-1).stanza.getChild('reason').getChild('failed-application'))
  assert.equal(FakePeer.instances.length, 0)
})

test('queues gathered candidates until the offer is acknowledged and sends each once', async t => {
  let acknowledgeOffer
  const sent = []
  const alice = setup(ALICE, { send: async (peer, stanza) => {
    sent.push(stanza)
    if (stanza.attrs.action === 'session-initiate') await new Promise(resolve => { acknowledgeOffer = resolve })
  } })
  t.after(() => alice.controller.reset())
  const starting = alice.controller.start(BOB)
  await setImmediate()
  const [pc] = FakePeer.instances
  pc.gather()
  assert.deepEqual(sent.map(stanza => stanza.attrs.action), ['session-initiate'])
  acknowledgeOffer()
  await starting
  pc.gather()
  assert.deepEqual(sent.map(stanza => stanza.attrs.action), ['session-initiate', 'transport-info'])
  pc.gather(candidate.replace('50900', '50901'))
  assert.equal(sent.at(-1).getChild('content').getChild('transport', ICE).getChild('candidate', ICE).attrs.port, '50901')
})

test('closes media when the outgoing call times out while ICE is still gathering', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const alice = setup(ALICE)
  t.after(() => alice.controller.reset())
  await alice.controller.start(BOB)
  const [pc] = FakePeer.instances
  t.mock.timers.tick(60000)
  assert.deepEqual(alice.sent.map(({ stanza }) => stanza.attrs.action), ['session-initiate', 'session-terminate'])
  assert.equal(alice.states.at(-1).phase, 'ended')
  assert.match(alice.states.at(-1).error, /did not answer/)
  assert.ok(pc.tracks.every(track => track.stopped))
  assert.equal(pc.connectionState, 'closed')
})

test('resolves simultaneous equivalent calls by the lower session ID', async t => {
  const alice = setup(ALICE)
  const bob = setup(BOB)
  t.after(() => {
    alice.controller.reset()
    bob.controller.reset()
  })
  await Promise.all([alice.controller.start(BOB), bob.controller.start(ALICE)])

  const aliceOffer = alice.sent[0].stanza
  const bobOffer = bob.sent[0].stanza
  const [winner, loser, winningOffer, losingOffer] = aliceOffer.attrs.sid <= bobOffer.attrs.sid
    ? [alice, bob, aliceOffer, bobOffer]
    : [bob, alice, bobOffer, aliceOffer]
  await assert.rejects(winner.controller.receive(losingOffer.attrs.initiator, losingOffer), { condition: 'conflict', jingleCondition: 'tie-break' })
  await loser.controller.receive(winningOffer.attrs.initiator, winningOffer)
  assert.equal(winner.states.at(-1).phase, 'outgoing')
  assert.equal(loser.states.at(-1).phase, 'incoming')
  assert.equal(loser.states.at(-1).localStream, null)
  const loserPc = FakePeer.instances[loser === alice ? 0 : 1]
  assert.equal(loserPc.connectionState, 'closed')
  assert.ok(loserPc.tracks.every(track => track.stopped))
})

test('accepts a same-peer invitation while the local outgoing offer is unsent', async t => {
  const alice = setup(ALICE)
  t.after(() => alice.controller.reset())
  let grant
  mockCapture(() => new Promise(resolve => { grant = resolve }))
  const starting = alice.controller.start(BOB)
  const incoming = request('session-initiate', 'z'.repeat(32), ...descriptionToJingle(offerSdp(false), 'initiator'))
  await alice.controller.receive(BOB, incoming)
  await starting
  assert.equal(alice.states.at(-1).phase, 'incoming')

  const track = new FakeTrack('audio')
  grant(new FakeStream([track]))
  await setImmediate()
  assert.ok(track.stopped)
  assert.ok(!alice.sent.some(({ stanza }) => stanza.attrs.action === 'session-initiate'))
})

test('rings two devices and starts a Jingle session only with the first device that proceeds', async t => {
  const alice = setup(ALICE)
  const phone = setup(BOB)
  const tabletJid = 'bob@example.org/Tablet'
  const tablet = setup(tabletJid)
  t.after(() => [alice, phone, tablet].forEach(call => call.controller.reset()))

  await alice.controller.start('bob@example.org', true)
  const [proposal] = alice.invitations
  const { sid } = proposal
  assert.deepEqual(proposal, { peer: 'bob@example.org', action: 'propose', sid, reason: undefined, media: ['audio', 'video'] })
  assert.deepEqual(captureRequests, [])
  assert.deepEqual(alice.sent, [])
  await phone.controller.receiveInvitation(ALICE, 'propose', sid, proposal.media, proposal.peer)
  await tablet.controller.receiveInvitation(ALICE, 'propose', sid, proposal.media, proposal.peer)
  assert.equal(phone.states.at(-1).phase, 'incoming')
  assert.equal(tablet.states.at(-1).phase, 'incoming')
  await alice.controller.receiveInvitation(BOB, 'ringing', sid)
  assert.equal(alice.states.at(-1).ringing, true)

  await alice.controller.receiveInvitation('mallory@example.org/Phone', 'proceed', sid)
  await alice.controller.receiveInvitation(BOB, 'proceed', 'another-session')
  assert.deepEqual(captureRequests, [])

  await Promise.all([phone.controller.accept(), tablet.controller.accept()])
  assert.equal(phone.invitations.at(-1).action, 'proceed')
  assert.equal(tablet.invitations.at(-1).action, 'proceed')
  await phone.controller.receiveInvitation(tabletJid, 'proceed', sid, undefined, ALICE)
  await tablet.controller.receiveInvitation(BOB, 'proceed', sid, undefined, ALICE)
  assert.equal(phone.states.at(-1).phase, 'connecting')
  assert.equal(tablet.states.at(-1).phase, 'connecting')

  const proceeding = alice.controller.receiveInvitation(BOB, 'proceed', sid)
  await alice.controller.receiveInvitation(tabletJid, 'proceed', sid)
  const finish = alice.invitations.at(-1)
  assert.deepEqual(finish, { peer: tabletJid, action: 'finish', sid, reason: 'alternative-session' })
  await alice.controller.receiveInvitation(tabletJid, 'proceed', sid)
  assert.deepEqual(alice.invitations.at(-1), finish)
  const invitations = alice.invitations.length
  await alice.controller.receiveInvitation(BOB, 'proceed', sid)
  assert.equal(alice.invitations.length, invitations)
  await tablet.controller.receiveInvitation('alice@example.org/Other', finish.action, sid, finish.reason, tabletJid)
  await tablet.controller.receiveInvitation(ALICE, finish.action, 'unrelated-session', finish.reason, tabletJid)
  await tablet.controller.receiveInvitation(ALICE, finish.action, sid, finish.reason, BOB)
  assert.equal(tablet.states.at(-1).phase, 'connecting')
  await tablet.controller.receiveInvitation(ALICE, finish.action, sid, finish.reason, finish.peer)
  await phone.controller.receiveInvitation(ALICE, finish.action, sid, finish.reason, finish.peer)
  assert.equal(phone.states.at(-1).phase, 'connecting')
  await proceeding
  await tablet.controller.receiveInvitation(BOB, 'proceed', sid, undefined, ALICE)
  assert.equal(tablet.states.at(-1).phase, 'ended')
  assert.match(tablet.states.at(-1).error, /answered on another device/)
  assert.deepEqual(captureRequests, [{ audio: true, video: true }])
  assert.equal(alice.states.at(-1).ringing, false)
  const [{ peer, stanza }] = alice.sent
  assert.equal(alice.sent.length, 1)
  assert.equal(peer, BOB)
  assert.equal(stanza.attrs.sid, sid)
  assert.equal(stanza.attrs.action, 'session-initiate')

  await assert.rejects(alice.controller.receive(tabletJid, request('session-accept', sid)), { condition: 'item-not-found' })
  await alice.controller.receiveInvitation(tabletJid, 'finish', sid, 'success')
  assert.equal(alice.states.at(-1).phase, 'outgoing')
  await phone.controller.receive(ALICE, stanza)
  await setTimeout(5)
  assert.equal(phone.sent[0].stanza.attrs.action, 'session-accept')
  await alice.controller.receive(BOB, phone.sent[0].stanza)
  FakePeer.instances.forEach(pc => pc.connect())
  assert.equal(alice.states.at(-1).phase, 'active')
  assert.equal(phone.states.at(-1).phase, 'active')
  await phone.controller.receiveInvitation(ALICE, finish.action, sid, finish.reason, finish.peer)
  assert.equal(phone.states.at(-1).phase, 'active')
  await phone.controller.receiveInvitation(ALICE, finish.action, sid, finish.reason, BOB)
  assert.equal(phone.states.at(-1).phase, 'ended')
  assert.equal(phone.states.at(-1).error, undefined)
  await alice.controller.end()
  assert.deepEqual(alice.invitations.at(-1), { peer: BOB, action: 'finish', sid, reason: 'success' })
})

test('retracts a canceled or unanswered proposal and ignores a late proceed', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const alice = setup(ALICE)
  t.after(() => alice.controller.reset())
  const bare = 'bob@example.org'
  await alice.controller.start(bare)
  const sid = alice.invitations.at(-1).sid
  await alice.controller.end()
  assert.deepEqual(alice.invitations.at(-1), { peer: bare, action: 'retract', sid, reason: 'cancel' })
  await alice.controller.receiveInvitation(BOB, 'proceed', sid)
  assert.deepEqual(captureRequests, [])
  assert.deepEqual(alice.sent, [])

  await alice.controller.start(bare)
  const timedOut = alice.invitations.at(-1).sid
  t.mock.timers.tick(60000)
  assert.deepEqual(alice.invitations.at(-1), { peer: bare, action: 'retract', sid: timedOut, reason: 'expired' })
  assert.match(alice.states.at(-1).error, /did not answer/)
})

test('ends a rejected proposal without capturing media and breaks competing proposals by session ID', async t => {
  const alice = setup(ALICE)
  t.after(() => alice.controller.reset())
  const bare = 'bob@example.org'
  await alice.controller.start(bare)
  const rejected = alice.invitations.at(-1).sid
  await alice.controller.receiveInvitation(BOB, 'reject', rejected, 'busy')
  assert.equal(alice.states.at(-1).reason, 'busy')
  assert.deepEqual(captureRequests, [])

  await alice.controller.start(bare)
  const outgoing = alice.invitations.at(-1).sid
  await alice.controller.receiveInvitation(BOB, 'propose', 'z', ['audio'])
  assert.deepEqual(alice.invitations.at(-1), { peer: BOB, action: 'reject', sid: 'z', reason: 'expired', tieBreak: true })
  await alice.controller.receiveInvitation(BOB, 'propose', '0', ['audio'])
  assert.deepEqual(alice.invitations.at(-2), { peer: bare, action: 'retract', sid: outgoing, reason: 'expired', tieBreak: true })
  assert.equal(alice.invitations.at(-1).action, 'ringing')
  assert.equal(alice.states.at(-1).phase, 'incoming')
})

test('answers a message invitation only after consent and a matching Jingle offer', async t => {
  const bob = setup(BOB)
  t.after(() => bob.controller.reset())
  const sid = 'video-invitation'
  const offer = invitationOffer(sid, true)
  await bob.controller.receiveInvitation(ALICE, 'propose', sid, ['video', 'audio'])
  await bob.controller.receiveInvitation(ALICE, 'propose', sid, ['video', 'audio'])
  assert.equal(bob.states.at(-1).phase, 'incoming')
  assert.equal(bob.states.at(-1).video, true)
  assert.deepEqual(bob.invitations.map(({ action }) => action), ['ringing'])
  await assert.rejects(bob.controller.receive(ALICE, offer), { condition: 'unexpected-request', jingleCondition: 'out-of-order' })
  assert.deepEqual(captureRequests, [])

  await bob.controller.accept()
  await bob.controller.accept()
  assert.equal(bob.states.at(-1).phase, 'connecting')
  assert.deepEqual(bob.invitations.map(({ action }) => action), ['ringing', 'proceed'])
  assert.equal(bob.invitations.at(-1).peer, ALICE)
  assert.equal(bob.invitations.at(-1).sid, sid)
  await bob.controller.receive(ALICE, invitationOffer('different-session', true))
  await assert.rejects(bob.controller.receive('alice@example.org/other', offer), { condition: 'item-not-found', jingleCondition: 'unknown-session' })
  await assert.rejects(bob.controller.receive(ALICE, invitationOffer(sid)), { condition: 'bad-request' })
  assert.deepEqual(captureRequests, [])

  await bob.controller.receive(ALICE, offer)
  assert.deepEqual(captureRequests, [])
  await setTimeout(5)
  assert.deepEqual(captureRequests, [{ audio: true, video: true }])
  assert.equal(bob.states.filter(state => state.phase === 'incoming').length, 1)
  const [pc] = FakePeer.instances
  await setImmediate()
  assert.equal(bob.sent.find(({ stanza }) => stanza.attrs.action === 'session-accept').stanza.attrs.sid, sid)
  pc.connect()
  assert.equal(bob.states.at(-1).phase, 'active')

  await bob.controller.end()
  assert.equal(bob.sent.at(-1).stanza.attrs.action, 'session-terminate')
  assert.deepEqual(bob.invitations.at(-1), { peer: ALICE, action: 'finish', sid, reason: 'success' })
  assert.ok(pc.tracks.every(track => track.stopped))
})

test('rejects a busy or declined proposal and ignores its late IQ and duplicate messages', async t => {
  const bob = setup(BOB)
  t.after(() => bob.controller.reset())
  const other = 'carol@example.org/device'
  await bob.controller.receiveInvitation(ALICE, 'propose', 'original', ['audio'])
  await bob.controller.receiveInvitation(other, 'propose', 'extra', ['audio'])
  await bob.controller.receiveInvitation(other, 'propose', 'extra', ['audio'])
  assert.equal(bob.states.at(-1).peer, ALICE)
  assert.deepEqual(bob.invitations.at(-1), { peer: other, action: 'reject', sid: 'extra', reason: 'busy' })
  await bob.controller.end()
  assert.deepEqual(bob.invitations.at(-1), { peer: ALICE, action: 'reject', sid: 'original', reason: 'busy' })
  await bob.controller.receiveInvitation(ALICE, 'propose', 'original', ['audio'])
  await assert.rejects(bob.controller.receive(ALICE, invitationOffer('original')), { condition: 'item-not-found' })
  await assert.rejects(bob.controller.receive(other, invitationOffer('extra')), { condition: 'item-not-found' })
  assert.equal(bob.states.at(-1).phase, 'ended')
  assert.equal(bob.invitations.length, 3)
  assert.deepEqual(captureRequests, [])
})

test('a caller retracts only its own live proposal, including while the local user awaits the offer', async t => {
  const bob = setup(BOB)
  t.after(() => bob.controller.reset())
  const sid = 'retract'
  await bob.controller.receiveInvitation(ALICE, 'propose', sid, ['audio'])
  await bob.controller.accept()
  await bob.controller.receiveInvitation('alice@example.org/other', 'retract', sid)
  await bob.controller.receiveInvitation(ALICE, 'retract', 'other')
  assert.equal(bob.states.at(-1).phase, 'connecting')
  await bob.controller.receiveInvitation(ALICE, 'retract', sid)
  assert.equal(bob.states.at(-1).reason, 'cancel')
  assert.deepEqual(bob.invitations.map(({ action }) => action), ['ringing', 'proceed'])
  await assert.rejects(bob.controller.receive(ALICE, invitationOffer(sid)), { condition: 'item-not-found' })
  assert.deepEqual(captureRequests, [])
})

test('suppresses an authenticated sibling answer for the current invitation', async t => {
  const bob = setup(BOB)
  t.after(() => bob.controller.reset())
  const otherDevice = 'bob@example.org/Phone'
  const sid = 'sibling-answer'
  await bob.controller.receiveInvitation(ALICE, 'propose', sid, ['audio'])
  await bob.controller.receiveInvitation(BOB, 'proceed', sid, undefined, ALICE)
  await bob.controller.receiveInvitation(otherDevice, 'proceed', sid, undefined, 'other@example.org/device')
  assert.equal(bob.states.at(-1).phase, 'incoming')
  await bob.controller.receiveInvitation(otherDevice, 'proceed', sid, undefined, ALICE)
  assert.equal(bob.states.at(-1).phase, 'ended')
  assert.match(bob.states.at(-1).error, /answered on another device/)
  await assert.rejects(bob.controller.receive(ALICE, invitationOffer(sid)), { condition: 'item-not-found' })
  assert.deepEqual(captureRequests, [])
})

test('times out an invitation that never gets a matching IQ and remembers its ID across reset', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const bob = setup(BOB)
  t.after(() => bob.controller.reset())
  const sid = 'timeout'
  await bob.controller.receiveInvitation(ALICE, 'propose', sid, ['audio'])
  await bob.controller.accept()
  t.mock.timers.tick(35000)
  assert.equal(bob.states.at(-1).phase, 'ended')
  assert.equal(bob.states.at(-1).reason, 'timeout')
  assert.deepEqual(bob.invitations.at(-1), { peer: ALICE, action: 'finish', sid, reason: 'expired' })

  bob.controller.reset()
  await assert.rejects(bob.controller.receive(ALICE, invitationOffer(sid)), { condition: 'item-not-found' })
  await bob.controller.receive(ALICE, invitationOffer('direct'))
  assert.equal(bob.states.at(-1).phase, 'incoming')
  assert.deepEqual(captureRequests, [])
})

test('disconnecting after the matching IQ prevents deferred media setup', async t => {
  const bob = setup(BOB)
  t.after(() => bob.controller.reset())
  const sid = 'disconnect'
  const offer = invitationOffer(sid)
  await bob.controller.receiveInvitation(ALICE, 'propose', sid, ['audio'])
  await bob.controller.accept()
  await bob.controller.receive(ALICE, offer)
  bob.controller.reset()
  await setTimeout(5)
  await assert.rejects(bob.controller.receive(ALICE, offer), { condition: 'item-not-found' })
  assert.equal(bob.states.at(-1), null)
  assert.equal(bob.sent.length, 0)
  assert.deepEqual(captureRequests, [])
})
