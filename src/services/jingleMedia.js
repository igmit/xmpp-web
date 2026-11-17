import xml from '@xmpp/xml'
import { nanoid } from 'nanoid'
import sdpTransform from 'sdp-transform'
import * as NS from './jingleNamespaces.js'

function validate(condition, field) {
  if (!condition) throw new Error(`Invalid Jingle media ${field}`)
}

function text(value, field) {
  validate(typeof value === 'string' && !/\p{Cc}/u.test(value), field)
  return value
}

function token(value, field) {
  validate(typeof value === 'string' && /^[!#$%&'*+\-.0-9A-Z^_`a-z{|}~]+$/.test(value), field)
  return value
}

function int(value, min, max, field) {
  const number = Number(value)
  validate(/^\d+$/.test(value) && number >= min && number <= max, field)
  return number
}

function validateRole(role) {
  validate(role === 'initiator' || role === 'responder', 'role')
}

function directionToSenders(direction, role) {
  if (direction === 'sendonly') return role
  if (direction === 'recvonly') return role === 'initiator' ? 'responder' : 'initiator'
  return direction === 'inactive' ? 'none' : 'both'
}

function sendersToDirection(senders, role) {
  if (senders === undefined || senders === 'both') return 'sendrecv'
  if (senders === 'none') return 'inactive'
  validateRole(senders)
  return senders === role ? 'sendonly' : 'recvonly'
}

function validateMedia(media) {
  const types = media.map(section => section.type)
  validate(types.length === 1 && types[0] === 'audio' ||
    types.length === 2 && types.includes('audio') && types.includes('video'), 'contents')
  const mids = media.map(section => token(String(section.mid ?? ''), 'content name'))
  validate(new Set(mids).size === mids.length, 'duplicate content name')
  return mids
}

function checkGroup(type, mids, availableMids) {
  token(type, 'group semantics')
  validate(mids.length && new Set(mids).size === mids.length &&
    mids.every(mid => availableMids.includes(mid)), 'group contents')
}

function writeParameters(config, separator) {
  return config.split(separator).map(parameter => parameter.trim()).filter(Boolean).map(parameter => {
    const equal = parameter.indexOf('=')
    return equal === -1
      ? xml('parameter', { name: parameter, value: '' })
      : xml('parameter', { name: parameter.slice(0, equal).trim(), value: parameter.slice(equal + 1).trim() })
  })
}

function readParameters(element, namespace, separator) {
  return element.getChildren('parameter', namespace).map(({ attrs }) => {
    const name = text(attrs.name, 'parameter name')
    const value = text(attrs.value ?? '', 'parameter value')
    return value ? `${name}=${value}` : name
  }).join(separator)
}

function writeFeedback(media, payload) {
  const feedback = (media.rtcpFb ?? []).filter(item => item.payload === payload)
  const intervals = (media.rtcpFbTrrInt ?? []).filter(item => item.payload === payload)
  return [
    ...feedback.map(({ type, subtype }) => xml('rtcp-fb', { xmlns: NS.FEEDBACK, type, subtype })),
    ...intervals.map(({ value }) => xml('rtcp-fb-trr-int', { xmlns: NS.FEEDBACK, value })),
  ]
}

function writeSources(media) {
  const sources = new Map()
  for (const { id, attribute, value } of media.ssrcs ?? []) {
    if (!sources.has(id)) sources.set(id, [])
    sources.get(id).push(xml('parameter', { name: attribute, value }))
  }
  return [
    ...(media.ssrcGroups ?? []).map(group => xml('ssrc-group', { xmlns: NS.SSMA, semantics: group.semantics },
      String(group.ssrcs).split(/ +/).map(ssrc => xml('source', { ssrc })))),
    ...Array.from(sources, ([ssrc, parameters]) => {
      // Some browsers put MSID only at the media level. SSMA carries it in Jingle.
      if (!parameters.some(parameter => parameter.attrs.name === 'msid')) {
        for (const { id, appdata } of media.msid ?? []) {
          parameters.push(xml('parameter', { name: 'msid', value: [id, appdata].filter(Boolean).join(' ') }))
        }
      }
      return xml('source', { xmlns: NS.SSMA, ssrc }, parameters)
    }),
  ]
}

function writeRtpDescription(session, media, role) {
  const payloadTypes = String(media.payloads).split(/ +/).map(id => {
    const mapping = media.rtp.find(codec => String(codec.payload) === id)
    const parameters = media.fmtp.filter(fmtp => String(fmtp.payload) === id)
    return xml('payload-type', {
      id,
      name: mapping?.codec,
      clockrate: mapping?.rate,
      channels: mapping?.encoding,
      ptime: media.ptime,
      maxptime: media.maxptime,
    }, parameters.flatMap(({ config }) => writeParameters(config, ';')), writeFeedback(media, Number(id)))
  })
  const ext = (media.ext ?? session.ext ?? []).filter(extension =>
    !extension['encrypt-uri'] && extension.direction !== 'inactive')
  return xml('description', { xmlns: NS.RTP, media: media.type },
    payloadTypes,
    xml('rtcp-mux'),
    writeFeedback(media, '*'),
    ext.map(extension => xml('rtp-hdrext', {
      xmlns: NS.HEADER_EXT,
      id: extension.value,
      uri: extension.uri,
      senders: directionToSenders(extension.direction, role),
    }, extension.config ? writeParameters(extension.config, ' ') : [])),
    (media.extmapAllowMixed || session.extmapAllowMixed) ? xml('extmap-allow-mixed', { xmlns: NS.HEADER_EXT }) : [],
    writeSources(media))
}

function writeIceTransport(session, media) {
  const fingerprint = media.fingerprint ?? session.fingerprint
  const ufrag = media.iceUfrag ?? session.iceUfrag
  const pwd = media.icePwd ?? session.icePwd
  const setup = media.setup ?? session.setup
  validate(fingerprint && ufrag && pwd && setup, 'local ICE/DTLS description')
  const candidates = (media.candidates ?? []).filter(candidate => candidate.transport.toLowerCase() === 'udp')
  return xml('transport', { xmlns: NS.ICE, ufrag, pwd },
    xml('fingerprint', { xmlns: NS.DTLS, hash: fingerprint.type, setup }, fingerprint.hash),
    candidates.map(candidate => xml('candidate', {
      id: 'c' + nanoid(12),
      foundation: candidate.foundation,
      component: candidate.component,
      protocol: 'udp',
      priority: candidate.priority,
      ip: candidate.ip,
      port: candidate.port,
      type: candidate.type,
      'rel-addr': candidate.raddr,
      'rel-port': candidate.rport,
      generation: candidate.generation ?? 0,
    })))
}

export function descriptionToJingle(sdp, role) {
  validateRole(role)
  const session = sdpTransform.parse(sdp)
  const mids = validateMedia(session.media)
  const groups = (session.groups ?? []).map(group => {
    const names = String(group.mids).split(/ +/)
    checkGroup(group.type, names, mids)
    return xml('group', { xmlns: NS.GROUP, semantics: group.type }, names.map(name => xml('content', { name })))
  })
  const contents = session.media.map((media, index) => {
    validate((media.port > 0 || media.bundleOnly) && media.rtcpMux && media.protocol === 'UDP/TLS/RTP/SAVPF',
      'local RTP description')
    return xml('content', {
      xmlns: NS.JINGLE,
      creator: 'initiator',
      name: mids[index],
      senders: directionToSenders(media.direction ?? session.direction, role),
    }, writeRtpDescription(session, media, role), writeIceTransport(session, media))
  })
  return [...groups, ...contents]
}

function requiredChild(element, name, namespace) {
  const children = element.getChildren(name)
  validate(children.length === 1 && children[0].is(name, namespace), name)
  return children[0]
}

function iceCredential(value, size, field) {
  validate(typeof value === 'string' && value.length >= size && value.length <= 256 && /^[a-z0-9+/]+$/i.test(value), field)
  return value
}

function candidateAddress(value) {
  // Browsers also signal mDNS host candidates to avoid exposing private IP addresses.
  validate(typeof value === 'string' && /^(?:[0-9a-f:.]+|[a-z0-9-]+\.local\.?)$/i.test(value), 'candidate address')
  return value
}

function readCandidates(transport) {
  return transport.getChildren('candidate', NS.ICE)
    .filter(({ attrs }) => attrs.protocol?.toLowerCase() === 'udp')
    .map(({ attrs }) => {
      validate(['host', 'srflx', 'prflx', 'relay'].includes(attrs.type), 'candidate type')
      validate(typeof attrs.foundation === 'string' && /^[a-z0-9+/]{1,32}$/i.test(attrs.foundation), 'candidate foundation')
      return {
        foundation: attrs.foundation,
        component: int(attrs.component, 1, 2, 'candidate component'),
        transport: 'udp',
        priority: int(attrs.priority, 1, 2 ** 32 - 1, 'candidate priority'),
        ip: candidateAddress(attrs.ip),
        port: int(attrs.port, 1, 65535, 'candidate port'),
        type: attrs.type,
        raddr: attrs['rel-addr'] === undefined ? undefined : candidateAddress(attrs['rel-addr']),
        rport: attrs['rel-addr'] === undefined ? undefined : int(attrs['rel-port'], 0, 65535, 'candidate related port'),
        generation: int(attrs.generation ?? 0, 0, 255, 'candidate generation'),
      }
    })
}

function readIceTransport(transport, role) {
  const fingerprint = requiredChild(transport, 'fingerprint', NS.DTLS)
  const { setup, hash: type } = fingerprint.attrs
  validate(role === 'initiator' ? setup === 'actpass' : setup === 'active' || setup === 'passive', 'DTLS setup')
  const bytes = { 'sha-256': 32, 'sha-384': 48, 'sha-512': 64 }[type]
  const hash = fingerprint.getText().trim()
  validate(bytes && hash.length === 3 * bytes - 1 && /^(?:[0-9a-f]{2}:)*[0-9a-f]{2}$/i.test(hash), 'DTLS fingerprint')
  return {
    iceUfrag: iceCredential(transport.attrs.ufrag, 4, 'ICE ufrag'),
    icePwd: iceCredential(transport.attrs.pwd, 22, 'ICE password'),
    fingerprint: { type, hash: hash.toUpperCase() },
    setup,
    candidates: readCandidates(transport),
  }
}

function readFeedback(parent, payload, media) {
  for (const { attrs } of parent.getChildren('rtcp-fb', NS.FEEDBACK)) {
    media.rtcpFb.push({
      payload,
      type: token(attrs.type, 'RTCP feedback type'),
      subtype: attrs.subtype === undefined ? undefined : token(attrs.subtype, 'RTCP feedback subtype'),
    })
  }
  for (const { attrs } of parent.getChildren('rtcp-fb-trr-int', NS.FEEDBACK)) {
    media.rtcpFbTrrInt.push({ payload, value: int(attrs.value, 0, 2 ** 32 - 1, 'RTCP feedback interval') })
  }
}

function readSources(description) {
  const ssrcs = description.getChildren('source', NS.SSMA).flatMap(source => {
    const id = int(source.attrs.ssrc, 0, 2 ** 32 - 1, 'source id')
    return source.getChildren('parameter', NS.SSMA).map(({ attrs }) => ({
      id,
      attribute: token(attrs.name, 'source parameter name'),
      value: attrs.value === undefined ? undefined : text(attrs.value, 'source parameter value'),
    }))
  })
  const streamIds = new Set(ssrcs.filter(source => source.attribute === 'msid' && source.value).map(source => source.value))
  const msid = Array.from(streamIds, stream => {
    const [id, appdata] = stream.split(/ +/)
    return { id: token(id, 'stream id'), appdata: appdata ? token(appdata, 'track id') : '' }
  })
  const ssrcGroups = description.getChildren('ssrc-group', NS.SSMA).map(group => {
    const ids = group.getChildren('source', NS.SSMA).map(({ attrs }) => int(attrs.ssrc, 0, 2 ** 32 - 1, 'source id'))
    const semantics = token(group.attrs.semantics, 'source group semantics')
    validate(ids.length > 1, 'source group')
    if (semantics === 'FID' && ids.length === 2) {
      // Chromium needs a source line for RTX even when Jingle signals it only in the group.
      const [primary, repair] = ids
      const cname = ssrcs.find(source => source.id === primary && source.attribute === 'cname')
      if (cname?.value && !ssrcs.some(source => source.id === repair && source.attribute === 'cname')) {
        ssrcs.push({ ...cname, id: repair })
      }
    }
    return { semantics, ssrcs: ids.join(' ') }
  })
  return { ssrcs, ssrcGroups, msid }
}

function readRtpDescription(description, role) {
  validate(description.getChild('rtcp-mux', NS.RTP), 'RTCP multiplexing')
  const media = {
    type: description.attrs.media,
    protocol: 'UDP/TLS/RTP/SAVPF',
    port: 9,
    connection: { version: 4, ip: '0.0.0.0' },
    rtcpMux: 'rtcp-mux',
    rtp: [],
    fmtp: [],
    rtcpFb: [],
    rtcpFbTrrInt: [],
  }
  const payloads = description.getChildren('payload-type', NS.RTP).map(element => {
    const { id, name, clockrate, channels, ptime, maxptime } = element.attrs
    const payload = int(id, 0, 127, 'payload id')
    if (name && clockrate || payload >= 96) {
      media.rtp.push({
        payload,
        codec: token(name, 'codec name'),
        rate: int(clockrate, 1, 2 ** 32 - 1, 'codec clock rate'),
        encoding: channels === undefined ? undefined : int(channels, 1, 255, 'codec channels'),
      })
    }
    if (ptime !== undefined && media.ptime === undefined) media.ptime = int(ptime, 1, 2 ** 32 - 1, 'packet time')
    if (maxptime !== undefined && media.maxptime === undefined) media.maxptime = int(maxptime, 1, 2 ** 32 - 1, 'maximum packet time')
    const config = readParameters(element, NS.RTP, ';')
    if (config) media.fmtp.push({ payload, config })
    readFeedback(element, payload, media)
    return payload
  })
  validate(payloads.length && new Set(payloads).size === payloads.length, 'payload ids')
  media.payloads = payloads.join(' ')
  readFeedback(description, '*', media)
  media.ext = description.getChildren('rtp-hdrext', NS.HEADER_EXT).map(element => {
    const { id, uri, senders } = element.attrs
    validate(/^\S+$/.test(text(uri, 'header extension URI')), 'header extension URI')
    const direction = sendersToDirection(senders, role)
    return {
      value: int(id, 1, 4351, 'header extension id'),
      uri,
      direction: direction === 'sendrecv' ? undefined : direction,
      config: readParameters(element, NS.HEADER_EXT, ' '),
    }
  })
  if (description.getChild('extmap-allow-mixed', NS.HEADER_EXT)) media.extmapAllowMixed = 'extmap-allow-mixed'
  return { ...media, ...readSources(description) }
}

function getContents(jingle) {
  validate(jingle?.is('jingle', NS.JINGLE), 'namespace')
  const contents = jingle.getChildren('content')
  validate(contents.length && contents.every(content => content.is('content', NS.JINGLE)), 'contents')
  const mids = new Set()
  for (const { attrs } of contents) {
    const mid = token(attrs.name, 'content name')
    validate(!mids.has(mid), 'duplicate content name')
    validate(attrs.creator === 'initiator', 'content creator')
    validate(attrs.disposition === undefined || attrs.disposition === 'session', 'content disposition')
    mids.add(mid)
  }
  return contents
}

export function jingleToDescription(jingle, role, expectedMids) {
  validateRole(role)
  const contents = getContents(jingle)
  let media = contents.map(content => {
    const description = requiredChild(content, 'description', NS.RTP)
    const transport = requiredChild(content, 'transport', NS.ICE)
    return {
      mid: content.attrs.name,
      direction: sendersToDirection(content.attrs.senders, role),
      ...readRtpDescription(description, role),
      ...readIceTransport(transport, role),
    }
  })
  const mids = validateMedia(media)
  if (expectedMids) {
    validate(expectedMids.length === mids.length && new Set(expectedMids).size === mids.length &&
      expectedMids.every(mid => mids.includes(mid)), 'answer contents')
    media = expectedMids.map(mid => media.find(section => section.mid === mid))
  }
  const groups = jingle.getChildren('group', NS.GROUP).map(group => {
    const type = group.attrs.semantics
    const names = group.getChildren('content', NS.GROUP).map(({ attrs }) => attrs.name)
    checkGroup(type, names, mids)
    return { type, mids: names.join(' ') }
  })
  return sdpTransform.write({
    name: '-',
    origin: { username: '-', sessionId: Date.now(), sessionVersion: 0, netType: 'IN', ipVer: 4, address: '127.0.0.1' },
    timing: { start: 0, stop: 0 },
    msidSemantic: { semantic: 'WMS', token: '*' },
    iceOptions: 'trickle',
    groups,
    media,
  })
}

export function transportCandidates(jingle, mids) {
  return getContents(jingle).flatMap(content => {
    const sdpMid = content.attrs.name
    const sdpMLineIndex = mids.indexOf(sdpMid)
    validate(sdpMLineIndex >= 0, 'candidate content name')
    const transport = requiredChild(content, 'transport', NS.ICE)
    const usernameFragment = transport.attrs.ufrag === undefined
      ? undefined
      : iceCredential(transport.attrs.ufrag, 4, 'candidate ICE ufrag')
    return readCandidates(transport).map(item => {
      const candidate = `${item.foundation} ${item.component} ${item.transport} ${item.priority} ${item.ip} ${item.port} typ ${item.type}`
      const related = item.raddr ? ` raddr ${item.raddr} rport ${item.rport}` : ''
      return {
        candidate: `candidate:${candidate}${related} generation ${item.generation}`,
        sdpMid,
        sdpMLineIndex,
        usernameFragment,
      }
    })
  })
}
