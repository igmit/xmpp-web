import assert from 'node:assert/strict'
import test from 'node:test'
import { xml } from '@xmpp/client'
import { descriptionToJingle, jingleToDescription, transportCandidates } from '../src/services/jingleMedia.js'

const JINGLE = 'urn:xmpp:jingle:1'
const RTP = 'urn:xmpp:jingle:apps:rtp:1'
const ICE = 'urn:xmpp:jingle:transports:ice-udp:1'
const DTLS = 'urn:xmpp:jingle:apps:dtls:0'
const GROUP = 'urn:xmpp:jingle:apps:grouping:0'
const HEADER_EXT = 'urn:xmpp:jingle:apps:rtp:rtp-hdrext:0'
const SSMA = 'urn:xmpp:jingle:apps:rtp:ssma:0'
const fingerprint = Array.from({ length: 32 }, () => 'AB').join(':')

function fixture({ video = true, setup = 'actpass', direction = 'sendrecv' } = {}) {
  const transport = [
    'c=IN IP4 0.0.0.0',
    'a=ice-ufrag:ice1',
    'a=ice-pwd:1234567890123456789012',
    `a=fingerprint:sha-256 ${fingerprint}`,
    `a=setup:${setup}`,
    'a=rtcp-mux',
  ]
  return [
    'v=0',
    'o=- 42 1 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    `a=group:BUNDLE ${video ? 'voice webcam' : 'voice'}`,
    'a=extmap-allow-mixed',
    'a=msid-semantic: WMS *',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111 0 126',
    ...transport,
    'a=mid:voice',
    `a=${direction}`,
    'a=extmap:1/sendonly urn:ietf:params:rtp-hdrext:ssrc-audio-level',
    'a=rtpmap:0 PCMU/8000',
    'a=rtpmap:111 opus/48000/2',
    'a=fmtp:111 minptime=10;useinbandfec=1',
    'a=rtpmap:126 telephone-event/8000',
    'a=fmtp:126 0-15',
    'a=rtcp-fb:* transport-cc',
    'a=msid:mic-stream mic-track',
    'a=ssrc:1000 cname:mic',
    'a=candidate:123 1 udp 2122262783 192.0.2.1 43000 typ host generation 0 network-id 1',
    'a=candidate:456 1 tcp 1518280447 192.0.2.1 9 typ host tcptype active generation 0',
    'a=candidate:789 1 udp 1686052606 198.51.100.10 45001 typ srflx raddr 192.0.2.1 rport 43000 generation 0',
    ...(video ? [
      'm=video 9 UDP/TLS/RTP/SAVPF 96 97',
      ...transport,
      'a=mid:webcam',
      'a=sendrecv',
      'a=rtpmap:96 VP8/90000',
      'a=rtcp-fb:96 nack pli',
      'a=rtcp-fb:96 trr-int 200',
      'a=rtpmap:97 rtx/90000',
      'a=fmtp:97 apt=96',
      'a=ssrc-group:FID 2000 2001',
      'a=ssrc:2000 cname:camera',
      'a=ssrc:2000 msid:camera-stream camera-track',
      'a=ssrc:2001 cname:camera',
      'a=ssrc:2001 msid:camera-stream camera-track',
    ] : []),
    '',
  ].join('\r\n')
}

function envelope(sdp, role) {
  return xml('jingle', { xmlns: JINGLE }, descriptionToJingle(sdp, role))
}

test('converts audio and video SDP to Jingle and preserves negotiated parameters', () => {
  const jingle = envelope(fixture(), 'initiator')
  const group = jingle.getChild('group', GROUP)
  assert.equal(group.attrs.semantics, 'BUNDLE')
  assert.deepEqual(group.getChildren('content', GROUP).map(({ attrs }) => attrs.name), ['voice', 'webcam'])
  const [audio, video] = jingle.getChildren('content', JINGLE)
  const audioDescription = audio.getChild('description', RTP)
  assert.equal(audioDescription.attrs.media, 'audio')
  assert.equal(audioDescription.getChild('rtp-hdrext', HEADER_EXT).attrs.senders, 'initiator')
  assert.deepEqual(audioDescription.getChildren('payload-type', RTP).map(({ attrs }) => attrs.id), ['111', '0', '126'])
  assert.equal(audioDescription.getChild('source', SSMA).getChildByAttr('name', 'msid', SSMA).attrs.value, 'mic-stream mic-track')
  assert.equal(video.getChild('description', RTP).getChild('ssrc-group', SSMA).attrs.semantics, 'FID')
  const transport = audio.getChild('transport', ICE)
  assert.equal(transport.getChild('fingerprint', DTLS).getText(), fingerprint)
  const candidates = transport.getChildren('candidate', ICE)
  assert.equal(candidates.length, 2)
  assert.match(candidates[0].attrs.id, /^[A-Za-z_][\w.-]*$/)
  assert.notEqual(candidates[0].attrs.id, candidates[1].attrs.id)

  const sdp = jingleToDescription(jingle, 'initiator')
  for (const line of [
    'a=group:BUNDLE voice webcam',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111 0 126',
    'a=fmtp:111 minptime=10;useinbandfec=1',
    'a=fmtp:126 0-15',
    'a=msid:mic-stream mic-track',
    'a=rtcp-fb:* transport-cc',
    'a=extmap-allow-mixed',
    'a=extmap:1/sendonly urn:ietf:params:rtp-hdrext:ssrc-audio-level',
    'a=rtcp-fb:96 trr-int 200',
    'a=rtcp-fb:96 nack pli',
    'a=ssrc-group:FID 2000 2001',
    'a=ssrc:2001 msid:camera-stream camera-track',
    'a=candidate:789 1 udp 1686052606 198.51.100.10 45001 typ srflx raddr 192.0.2.1 rport 43000 generation 0',
  ]) {
    assert.ok(sdp.split('\r\n').includes(line), line)
  }
})

test('maps audio-only answer directions to the author and checks answer mids', () => {
  const answer = envelope(fixture({ video: false, setup: 'active', direction: 'recvonly' }), 'responder')
  assert.equal(answer.getChild('content', JINGLE).attrs.senders, 'initiator')
  assert.match(jingleToDescription(answer, 'responder', ['voice']), /a=recvonly\r\n/)
  assert.throws(() => jingleToDescription(answer, 'responder', ['audio']), /answer contents/)

  const reversed = envelope(fixture({ setup: 'active' }), 'responder')
  reversed.children.reverse()
  const sdp = jingleToDescription(reversed, 'responder', ['voice', 'webcam'])
  assert.ok(sdp.indexOf('m=audio') < sdp.indexOf('m=video'))
})

test('includes the RTX source in SDP when Jingle signals it only in the FID group', () => {
  const jingle = envelope(fixture(), 'initiator')
  const video = jingle.getChildren('content', JINGLE)[1].getChild('description', RTP)
  video.remove(video.getChildByAttr('ssrc', '2001', SSMA))
  const sdp = jingleToDescription(jingle, 'initiator')
  assert.match(sdp, /a=ssrc:2001 cname:camera\r\n/)
  assert.match(sdp, /a=ssrc-group:FID 2000 2001\r\n/)
})

test('converts incoming ICE candidates to their known media sections', () => {
  const jingle = xml('jingle', { xmlns: JINGLE, action: 'transport-info' },
    xml('content', { creator: 'initiator', name: 'webcam' },
      xml('transport', { xmlns: ICE, ufrag: 'ice2' }, xml('candidate', {
        id: 'external-candidate',
        foundation: '756',
        component: '1',
        protocol: 'udp',
        priority: '2122262783',
        ip: '2001:db8::1',
        port: '43000',
        type: 'host',
      }))))

  assert.deepEqual(transportCandidates(jingle, ['voice', 'webcam']), [{
    candidate: 'candidate:756 1 udp 2122262783 2001:db8::1 43000 typ host generation 0',
    sdpMid: 'webcam',
    sdpMLineIndex: 1,
    usernameFragment: 'ice2',
  }])
  assert.throws(() => transportCandidates(jingle, ['voice']), /candidate content name/)
})

test('rejects unsupported descriptions and invalid ICE/DTLS data', () => {
  const offer = () => envelope(fixture({ video: false }), 'initiator')
  const invalidNamespace = offer()
  invalidNamespace.getChild('content', JINGLE).getChild('transport', ICE).attrs.xmlns = 'urn:example:transport'
  assert.throws(() => jingleToDescription(invalidNamespace, 'initiator'), /transport/)
  const tamperedFingerprint = offer()
  tamperedFingerprint.getChild('content', JINGLE).getChild('transport', ICE).getChild('fingerprint', DTLS).text('xyz')
  assert.throws(() => jingleToDescription(tamperedFingerprint, 'initiator'), /DTLS fingerprint/)
  assert.throws(() => jingleToDescription(offer(), 'responder'), /DTLS setup/)
  const invalidDescription = offer()
  invalidDescription.getChild('content', JINGLE).getChild('description', RTP).attrs.media = 'application'
  assert.throws(() => jingleToDescription(invalidDescription, 'initiator'), /contents/)
  const invalidParameter = offer()
  invalidParameter.getChild('content', JINGLE).getChild('description', RTP).getChild('payload-type', RTP)
    .getChild('parameter', RTP).attrs.value = '10\r\na=inactive'
  assert.throws(() => jingleToDescription(invalidParameter, 'initiator'), /parameter value/)
})
