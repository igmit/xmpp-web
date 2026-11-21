import jid from '@xmpp/jid'
import xml from '@xmpp/xml'
import { nanoid } from 'nanoid'
import { descriptionToJingle, jingleToDescription, rejectedContents, transportCandidates, trickleToJingle } from './jingleMedia.js'
import { readReason } from './jingleMessages.js'
import { JINGLE, RTP, RTP_INFO } from './jingleNamespaces.js'

export const RING_TIMEOUT = 60000
const CONNECTION_TIMEOUT = 35000
const RECOVERY_TIMEOUT = 10000
const SIGNALING_TIMEOUT = 30000
const SIGNALING_ERROR = 'The call ended because the XMPP connection was lost.'
const RECENT_INVITATION_LIMIT = 128
const CONNECTION_ERROR = 'Could not connect the call. The networks may require a TURN relay.'
const ANSWERED_ELSEWHERE = 'The call was answered on another device.'
const REMOTE_END_MESSAGES = {
  busy: 'The other contact is busy.',
  cancel: 'The caller canceled the call.',
  'connectivity-error': CONNECTION_ERROR,
  decline: 'The other contact declined the call.',
  expired: 'The call expired.',
  'failed-application': 'The other contact could not set up the call.',
  'failed-transport': CONNECTION_ERROR,
  'general-error': 'The call ended because of an error.',
  gone: 'The other contact disconnected.',
  'incompatible-parameters': 'The other contact could not negotiate call media.',
  'media-error': 'The other contact encountered a media error.',
  'security-error': 'Could not establish a secure call.',
  success: undefined,
  timeout: 'The call timed out.',
  'unsupported-applications': 'The other contact does not support this call type.',
  'unsupported-transports': 'The other contact does not support this call transport.',
}

function stanzaError (condition, jingleCondition) {
  return Object.assign(new Error(jingleCondition || condition), { condition, jingleCondition })
}

function stopTracks (stream) {
  stream?.getTracks().forEach(track => track.stop())
}

function microphoneStatus (track) {
  if (track.readyState === 'ended') return 'unavailable'
  return track.muted ? 'muted' : null
}

function callJid (address) {
  if (typeof address !== 'string') return null
  try {
    const parsed = jid(address)
    return parsed.getLocal() ? parsed : null
  } catch {
    return null
  }
}

function fullJid (address) {
  const parsed = callJid(address)
  return parsed?.getResource() ? parsed : null
}

function validSid (sid) {
  return typeof sid === 'string' && !!sid && !/\s/.test(sid)
}

function supportedMedia (media) {
  return Array.isArray(media) && media.includes('audio') &&
    (media.length === 1 || (media.length === 2 && media.includes('video')))
}

function localError (error, video) {
  const devices = video ? 'microphone and camera' : 'microphone'
  switch (error?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return `Allow ${devices} access in your browser to make calls.`
    case 'NotFoundError':
    case 'OverconstrainedError':
      return `Could not find the ${devices} needed for this call.`
    case 'NotReadableError':
    case 'AbortError':
      return `Could not access your ${devices}. Check whether another app is using ${video ? 'them' : 'it'}.`
    case 'CallSetupError':
      return error.message
  }
  switch (error?.condition) {
    case 'service-unavailable':
    case 'recipient-unavailable':
    case 'remote-server-not-found':
    case 'feature-not-implemented':
      return 'The other contact is unavailable for calls.'
  }
  return 'Could not set up the call.'
}

function setupError (message) {
  return Object.assign(new Error(message), { name: 'CallSetupError' })
}

export class JingleCall {
  constructor ({ ownJid, send, sendInvitation, onChange, iceServers = [] }) {
    this.ownJid = fullJid(ownJid)
    this.send = send
    this.sendInvitation = sendInvitation
    this.onChange = onChange
    this.iceServers = iceServers
    this.session = null
    this.preferredMicrophone = null
    this.generation = 0
    this.recentInvitations = new Set()
    this.signalingOffline = false
    this.pendingTeardowns = []
  }

  createSession (sid, peer, video, phase, details) {
    const abort = new AbortController()
    const session = {
      sid, peer, video, phase, abort,
      candidates: [],
      localStream: null,
      remoteStream: null,
      ...details,
    }
    this.session = session
    this.phase(session, phase)
    return session
  }

  phase (session, phase) {
    session.phase = phase
    this.schedulePhaseTimeout(session)
    this.publish(session)
  }

  schedulePhaseTimeout (session) {
    clearTimeout(session.phaseTimer)
    const { phase } = session
    if (phase === 'outgoing' && session.proceeded) {
      session.phaseTimer = setTimeout(() => this.finish(session, 'connectivity-error', CONNECTION_ERROR), CONNECTION_TIMEOUT)
    } else if (phase === 'incoming' || phase === 'outgoing') {
      const timeout = phase === 'incoming' && session.expiresAt !== undefined
        ? Math.max(0, session.expiresAt - Date.now())
        : RING_TIMEOUT
      session.phaseTimer = setTimeout(() => {
        const error = phase === 'incoming' ? 'The incoming call timed out.' :
          session.signalled || session.proposedTo ? 'The other contact did not answer.' : 'Call setup timed out.'
        this.finish(session, 'timeout', error)
      }, timeout)
    } else if (phase === 'connecting') {
      session.phaseTimer = setTimeout(() => {
        if (session.invitation && !session.signalled) {
          this.finish(session, 'timeout', 'The caller did not start the call.')
        } else {
          this.finish(session, 'connectivity-error', CONNECTION_ERROR)
        }
      }, CONNECTION_TIMEOUT)
    }
  }

  publish (session, ended) {
    const { phase, peer, video, localStream, remoteStream, ringing } = session
    const { microphoneStatus, microphoneError } = session
    this.onChange({ phase, peer, video, localStream, remoteStream, microphoneStatus, microphoneError, ringing, ...ended })
  }

  async sendAction (session, action, children, timeout) {
    const attrs = { xmlns: JINGLE, action, sid: session.sid }
    if (action === 'session-initiate') attrs.initiator = this.ownJid.toString()
    if (action === 'session-accept') attrs.responder = this.ownJid.toString()
    await this.send(session.peer, xml('jingle', attrs, ...children), timeout)
  }

  async sendSetup (session, send) {
    while (this.session === session) {
      if (this.signalingOffline) {
        if (!session.signalingReady) {
          session.signalingReady = new Promise(resolve => { session.resumeSignaling = resolve })
        }
        await session.signalingReady
        continue
      }
      try {
        await send()
        return this.session === session
      } catch (error) {
        // Stream management handles replay after a successful write. An IQ timeout
        // or stanza error can follow delivery, so don't send that request again.
        if (!this.signalingOffline || error?.condition || error?.name === 'TimeoutError') throw error
      }
    }
    return false
  }

  async sendTeardown (send, expiresAt = Date.now() + RING_TIMEOUT) {
    if (expiresAt <= Date.now()) return
    if (this.signalingOffline) {
      this.pendingTeardowns.push({ send, expiresAt })
      return
    }
    const generation = this.generation
    try {
      await send()
    } catch (error) {
      if (this.signalingOffline && generation === this.generation && !error?.condition && error?.name !== 'TimeoutError' && expiresAt > Date.now()) {
        this.pendingTeardowns.push({ send, expiresAt })
      }
    }
  }

  signalTermination ({ peer, sid }, reason) {
    return this.sendTeardown(() => this.sendAction({ peer, sid }, 'session-terminate', [xml('reason', {}, xml(reason))]))
  }

  async signalInvitation (peer, action, sid, details) {
    try {
      await this.sendInvitation(peer, action, sid, details)
    } catch {
      // The invitation can still be handled locally if a status message is lost.
    }
  }

  rememberInvitation (sid) {
    this.recentInvitations.delete(sid)
    this.recentInvitations.add(sid)
    if (this.recentInvitations.size > RECENT_INVITATION_LIMIT) {
      this.recentInvitations.delete(this.recentInvitations.values().next().value)
    }
  }

  later (send) {
    const generation = this.generation
    // Let the incoming IQ handler acknowledge the request before replying with a new IQ.
    setTimeout(() => {
      if (generation === this.generation) send()
    }, 0)
  }

  cleanup (session) {
    this.session = null
    if (session.invitation) this.rememberInvitation(session.sid)
    clearTimeout(session.phaseTimer)
    clearTimeout(session.recoveryTimer)
    clearTimeout(session.signalingTimer)
    clearTimeout(session.peerPresenceTimer)
    session.resumeSignaling?.()
    session.unwatchMicrophone?.()
    session.abort.abort()
    if (session.pc) {
      session.pc.ontrack = null
      session.pc.onconnectionstatechange = null
      session.pc.onicecandidate = null
      session.pc.close()
    }
    stopTracks(session.localStream)
    stopTracks(session.remoteStream)
    session.localStream = null
    session.remoteStream = null
  }

  finish (session, reason, error, notifyPeer = true) {
    if (this.session !== session) return
    this.cleanup(session)
    session.phase = 'ended'
    const pending = []
    if (notifyPeer && session.signalled) pending.push(this.signalTermination(session, reason))
    if (notifyPeer && session.invitation) {
      const { peer, sid } = session
      const action = session.proceeded ? 'finish' : session.proposedTo ? 'retract' : 'reject'
      // JMI uses its default busy reason for a reject, including a user decline.
      const condition = reason === 'success' || reason === 'connectivity-error' ? reason :
        reason === 'decline' && action === 'reject' ? 'busy' :
          reason === 'cancel' && action === 'retract' ? 'cancel' : 'expired'
      pending.push(this.sendTeardown(() => this.sendInvitation(peer, action, sid, { reason: condition })))
    }
    this.publish(session, { reason, error })
    return Promise.all(pending)
  }

  reset () {
    this.generation += 1
    this.pendingTeardowns = []
    if (this.session) this.cleanup(this.session)
    this.onChange(null)
  }

  signalingLost () {
    this.signalingOffline = true
    const session = this.session
    if (session && !session.signalingTimer) {
      session.signalingTimer = setTimeout(() => {
        this.finish(session, 'connectivity-error', SIGNALING_ERROR)
      }, SIGNALING_TIMEOUT)
    }
  }

  signalingRestored () {
    this.signalingOffline = false
    for (const { send, expiresAt } of this.pendingTeardowns.splice(0)) this.sendTeardown(send, expiresAt)
    const session = this.session
    if (!session) return
    clearTimeout(session.signalingTimer)
    session.signalingTimer = null
    session.resumeSignaling?.()
    session.resumeSignaling = null
    session.signalingReady = null
    this.sendLocalCandidates(session)
  }

  peerAvailabilityChanged (peer, available) {
    const session = this.session
    if (session?.peer !== peer) return
    if (available) {
      clearTimeout(session.peerPresenceTimer)
      session.peerPresenceTimer = null
    } else if (session.phase !== 'active') {
      this.finish(session, 'gone', REMOTE_END_MESSAGES.gone, false)
    } else if (!session.peerPresenceTimer) {
      session.peerPresenceTimer = setTimeout(() => {
        this.finish(session, 'gone', REMOTE_END_MESSAGES.gone)
      }, SIGNALING_TIMEOUT)
    }
  }

  async end () {
    const session = this.session
    if (!session) {
      this.onChange(null)
      return
    }
    const declined = session.remoteOffer || (session.invitation && !session.proposedTo && !session.proceeded)
    const reason = session.accepted ? 'success' : declined ? 'decline' : 'cancel'
    await this.finish(session, reason)
  }

  async openPeer (session) {
    if (this.session !== session) return null
    const media = globalThis.navigator?.mediaDevices
    if (!media?.getUserMedia || !globalThis.RTCPeerConnection || !globalThis.MediaStream) {
      throw setupError('Calls require a browser with WebRTC and a secure connection (HTTPS).')
    }
    const { signal } = session.abort
    const canceled = new Promise(resolve => {
      signal.addEventListener('abort', () => resolve(null), { once: true })
    })
    const audio = this.preferredMicrophone ? { deviceId: { ideal: this.preferredMicrophone } } : true
    const capture = media.getUserMedia({ audio, video: session.video }).then(stream => {
      if (this.session === session) session.localStream = stream
      else stopTracks(stream)
    })
    const iceConfiguration = Promise.resolve().then(() => {
      if (typeof this.iceServers === 'function') return signal.aborted ? [] : this.iceServers()
      return this.iceServers
    })
    const setup = await Promise.race([Promise.all([capture, iceConfiguration]), canceled])
    if (!setup || this.session !== session) return null

    const [, iceServers] = setup
    const stream = session.localStream
    const pc = new globalThis.RTCPeerConnection({ iceServers })
    session.pc = pc
    pc.ontrack = ({ track }) => {
      if (this.session !== session) return
      if (!session.remoteStream) session.remoteStream = new globalThis.MediaStream()
      session.remoteStream.addTrack(track)
      this.publish(session)
    }
    pc.onconnectionstatechange = () => this.connectionChanged(session)
    pc.onicecandidate = () => this.sendLocalCandidates(session)
    for (const track of stream.getTracks()) {
      const sender = pc.addTrack(track, stream)
      if (track.kind === 'audio') session.microphoneSender = sender
    }
    this.watchMicrophone(session)
    this.publish(session)
    return this.session === session ? pc : null
  }

  watchMicrophone (session) {
    const track = session.microphoneSender?.track
    if (!track) return
    session.microphoneStatus = microphoneStatus(track)
    const update = () => {
      if (this.session !== session || session.microphoneSender.track !== track || session.microphoneStatus === 'reconnecting') return
      const status = microphoneStatus(track)
      if (status === session.microphoneStatus) return
      session.microphoneStatus = status
      session.microphoneError = null
      this.publish(session)
    }
    const events = ['mute', 'unmute', 'ended']
    for (const event of events) track.addEventListener(event, update)
    // MediaStreamTrack.stop() changes readyState without firing an ended event.
    const timer = setInterval(update, 1000)
    session.unwatchMicrophone = () => {
      clearInterval(timer)
      for (const event of events) track.removeEventListener(event, update)
    }
  }

  async reconnectMicrophone (deviceId) {
    const session = this.session
    if (session?.microphoneStatus !== 'unavailable') return
    session.microphoneStatus = 'reconnecting'
    session.microphoneError = null
    this.publish(session)

    let replacement
    try {
      const audio = deviceId ? { deviceId: { exact: deviceId } } : true
      replacement = await navigator.mediaDevices.getUserMedia({ audio })
      if (this.session !== session) return
      const [track] = replacement.getAudioTracks()
      if (track?.readyState !== 'live') throw setupError('The microphone stopped during capture.')
      await session.microphoneSender.replaceTrack(track)
      if (this.session !== session) return
      session.unwatchMicrophone()
      for (const old of session.localStream.getAudioTracks()) {
        session.localStream.removeTrack(old)
        old.stop()
      }
      session.localStream.addTrack(track)
      replacement.removeTrack(track)
      this.preferredMicrophone = deviceId || null
      this.watchMicrophone(session)
    } catch (error) {
      if (this.session !== session) return
      session.microphoneStatus = 'unavailable'
      session.microphoneError = localError(error, false)
    } finally {
      stopTracks(replacement)
      if (this.session === session) this.publish(session)
    }
  }

  connectionChanged (session) {
    if (this.session !== session) return
    clearTimeout(session.recoveryTimer)
    const state = session.pc.connectionState
    if (state === 'connected' && session.negotiated && session.phase === 'connecting') {
      this.phase(session, 'active')
    } else if (state === 'failed' || state === 'closed') {
      this.finish(session, 'connectivity-error', CONNECTION_ERROR)
    } else if (state === 'disconnected') {
      session.recoveryTimer = setTimeout(() => this.finish(session, 'connectivity-error', CONNECTION_ERROR), RECOVERY_TIMEOUT)
    }
  }

  async localDescription (session, description, role) {
    if (this.session !== session) return null
    const pc = session.pc
    await pc.setLocalDescription(description)
    if (this.session !== session) return null
    session.sentCandidates = new Set()
    return descriptionToJingle(pc.localDescription.sdp, role, session.sentCandidates)
  }

  async sendDescription (session, action, children) {
    const sent = await this.sendSetup(session, () => {
      if (action === 'session-initiate') session.signalled = true
      if (action === 'session-accept') session.accepted = true
      // The call's phase deadline governs setup, including time spent reconnecting.
      return this.sendAction(session, action, children, RING_TIMEOUT)
    })
    if (!sent) return false
    session.localDescriptionSent = true
    this.sendLocalCandidates(session)
    return true
  }

  sendLocalCandidates (session) {
    if (this.session !== session || !session.localDescriptionSent || this.signalingOffline) return
    // The browser adds gathered candidates to local SDP before dispatching icecandidate.
    const contents = trickleToJingle(session.pc.localDescription.sdp, session.sentCandidates)
    if (contents.length) this.sendAction(session, 'transport-info', contents).catch(() => {})
  }

  async remoteDescription (session, description) {
    await session.pc.setRemoteDescription(description)
    if (this.session !== session) return
    session.remoteReady = true
    const pending = session.candidates.splice(0)
    // A rejected early candidate should not prevent other candidates from being tried.
    await Promise.allSettled(pending.map(candidate => session.pc.addIceCandidate(candidate)))
  }

  async start (address, video = false) {
    const peer = callJid(address)
    if (!this.ownJid || !peer || peer.bare().toString() === this.ownJid.bare().toString()) {
      throw new Error('Choose a contact with an available calling device.')
    }
    if (this.session) throw new Error('There is already a call in progress.')
    if (peer.getResource()) {
      return this.offer(this.createSession(nanoid(), peer.toString(), Boolean(video), 'outgoing'))
    }
    if (!this.sendInvitation) throw new Error('Choose a contact with an available calling device.')

    const proposedTo = peer.toString()
    const session = this.createSession(crypto.randomUUID(), proposedTo, Boolean(video), 'outgoing', {
      invitation: true,
      proposedTo,
      proposalMessageId: nanoid(),
    })
    if (this.session !== session) return
    try {
      await this.sendSetup(session, () => this.sendInvitation(proposedTo, 'propose', session.sid, {
        messageId: session.proposalMessageId,
        media: video ? ['audio', 'video'] : ['audio'],
      }))
    } catch {
      if (!session.proceeded) this.finish(session, 'failed-application', 'Could not send the call invitation.', false)
    }
  }

  async offer (session) {
    try {
      const pc = await this.openPeer(session)
      if (!pc) return
      const children = await this.localDescription(session, await pc.createOffer(), 'initiator')
      if (!children) return
      session.mids = children.filter(child => child.name === 'content').map(content => content.attrs.name)
      this.schedulePhaseTimeout(session)
      await this.sendDescription(session, 'session-initiate', children)
    } catch (error) {
      if (session.phase === 'outgoing') {
        if (error?.condition) session.signalled = false
        this.finish(session, 'failed-application', localError(error, session.video))
      }
    }
  }

  async accept () {
    const session = this.session
    if (session?.phase !== 'incoming') return
    this.phase(session, 'connecting')
    if (this.session !== session) return
    if (session.invitation) {
      try {
        await this.sendSetup(session, () => {
          session.proceeded = true
          return this.sendInvitation(session.peer, 'proceed', session.sid)
        })
      } catch {
        if (!session.signalled) this.finish(session, 'failed-application', 'Could not accept the call invitation.', false)
      }
      return
    }
    await this.answer(session)
  }

  async answer (session) {
    try {
      const pc = await this.openPeer(session)
      if (!pc) return
      await this.remoteDescription(session, { type: 'offer', sdp: session.remoteOffer })
      if (this.session !== session) return
      const children = await this.localDescription(session, await pc.createAnswer(), 'responder')
      if (!children) return
      if (!await this.sendDescription(session, 'session-accept', children)) return
      session.negotiated = true
      this.connectionChanged(session)
    } catch (error) {
      this.finish(session, 'failed-application', localError(error, session.video))
    }
  }

  async receiveInvitation (address, action, sid, mediaOrReason, target, expiresAt) {
    const from = fullJid(address)
    if (!this.sendInvitation || !this.ownJid || !from || !validSid(sid)) return

    const current = this.session
    const ownBare = this.ownJid.bare().toString()
    const peer = from.toString()
    const bare = from.bare().toString()
    if (bare === ownBare) {
      if (peer === this.ownJid.toString() || !current?.invitation || current.sid !== sid || current.phase !== 'incoming') return
      const legacyCopy = target === ownBare && (action === 'accept' || action === 'reject')
      if (!legacyCopy && fullJid(target)?.toString() !== current.peer) return
      if (action === 'accept' || action === 'proceed') {
        this.finish(current, 'success', ANSWERED_ELSEWHERE, false)
      } else if (action === 'reject') {
        this.finish(current, 'decline', 'The call was declined on another device.', false)
      }
      return
    }

    if (action === 'propose') {
      if (expiresAt !== undefined && expiresAt <= Date.now()) return
      if (!supportedMedia(mediaOrReason) || this.recentInvitations.has(sid) ||
          (current?.invitation && !current.proposedTo && current.sid === sid)) return
      this.rememberInvitation(sid)
      if (current?.proposedTo === bare && !current.proceeded) {
        const details = { reason: 'expired', tieBreak: true }
        if (current.sid < sid || (current.sid === sid && this.ownJid.toString() < peer)) {
          return this.signalInvitation(peer, 'reject', sid, details)
        }
        this.cleanup(current)
        this.signalInvitation(bare, 'retract', current.sid, details)
      } else if (current) {
        return this.signalInvitation(peer, 'reject', sid, { reason: 'busy' })
      }
      const session = this.createSession(sid, peer, mediaOrReason.includes('video'), 'incoming', { invitation: true, expiresAt })
      if (this.session === session && session.phase === 'incoming') return this.signalInvitation(peer, 'ringing', sid)
    } else if (current?.proposedTo === bare && current.sid === sid && (!current.proceeded || action === 'proceed')) {
      return this.receiveProposalResponse(current, peer, action, mediaOrReason)
    } else if (current?.invitation && current.peer === peer && current.sid === sid) {
      if (action === 'finish' && mediaOrReason === 'alternative-session') {
        if (target !== this.ownJid.toString()) return
        if (!current.proposedTo && !current.signalled) {
          return this.finish(current, 'success', ANSWERED_ELSEWHERE, false)
        }
      }
      if (action === 'finish' || (action === 'retract' && current.phase !== 'active')) {
        const reason = typeof mediaOrReason === 'string' && Object.hasOwn(REMOTE_END_MESSAGES, mediaOrReason) ? mediaOrReason :
          action === 'retract' ? 'cancel' : 'success'
        this.finish(current, reason, REMOTE_END_MESSAGES[reason], false)
      }
    }
  }

  receiveProposalResponse (session, peer, action, reason) {
    if (action === 'ringing' && !session.ringing) {
      session.ringing = true
      this.publish(session)
    } else if (action === 'reject') {
      const condition = Object.hasOwn(REMOTE_END_MESSAGES, reason) && reason !== 'success' ? reason : 'decline'
      return this.finish(session, condition, REMOTE_END_MESSAGES[condition], false)
    } else if (action === 'proceed') {
      if (session.proceeded) {
        if (peer !== session.peer) {
          return this.signalInvitation(peer, 'finish', session.sid, { reason: 'alternative-session' })
        }
        return
      }
      // Lock the resource before any asynchronous work. Another device may also answer.
      session.peer = peer
      session.proceeded = true
      session.ringing = false
      this.schedulePhaseTimeout(session)
      this.publish(session)
      return this.offer(session)
    }
  }

  receiveOffer (peer, jingle) {
    const { sid, initiator } = jingle.attrs
    if (initiator && fullJid(initiator)?.toString() !== peer) throw stanzaError('bad-request')
    const contents = jingle.getChildren('content', JINGLE)
    const media = contents.map(content => content.getChild('description', RTP)?.attrs.media)
    const video = media.includes('video')
    const current = this.session
    if (current?.invitation && current.sid === sid) {
      if (current.peer !== peer) throw stanzaError('item-not-found', 'unknown-session')
      if (current.proposedTo || !current.proceeded || current.signalled) throw stanzaError('unexpected-request', 'out-of-order')
      if (!supportedMedia(media) || current.video !== video) throw stanzaError('bad-request')
      current.remoteOffer = this.offerDescription(jingle)
      current.mids = contents.map(content => content.attrs.name)
      current.signalled = true
      this.schedulePhaseTimeout(current)
      this.later(() => this.answer(current))
      return
    }
    if (this.recentInvitations.has(sid)) throw stanzaError('item-not-found', 'unknown-session')
    if (current) {
      const glare = current.peer === peer && current.phase === 'outgoing' && (!current.signalled || current.video === video)
      if (!glare && current.peer === peer && current.sid === sid) throw stanzaError('unexpected-request', 'out-of-order')
      if (glare && current.signalled && (current.sid < sid || (current.sid === sid && this.ownJid.toString() < peer))) {
        throw stanzaError('conflict', 'tie-break')
      }
      if (!glare) {
        this.later(() => this.signalTermination({ sid, peer }, 'busy'))
        return
      }
    }

    const remoteOffer = this.offerDescription(jingle)
    if (current) this.cleanup(current)
    const mids = contents.map(content => content.attrs.name)
    const session = this.createSession(sid, peer, video, 'incoming', { remoteOffer, mids, signalled: true })
    this.later(() => {
      if (this.session === session && session.phase === 'incoming') {
        this.sendAction(session, 'session-info', [xml('ringing', { xmlns: RTP_INFO })]).catch(() => {})
      }
    })
  }

  offerDescription (jingle) {
    try {
      return jingleToDescription(jingle, 'initiator')
    } catch {
      throw stanzaError('bad-request')
    }
  }

  async receiveAnswer (session, jingle) {
    if (session.phase !== 'outgoing') throw stanzaError('unexpected-request', 'out-of-order')
    const responder = jingle.attrs.responder
    if (responder && fullJid(responder)?.toString() !== session.peer) throw stanzaError('bad-request')
    session.accepted = true
    this.phase(session, 'connecting')
    if (this.session !== session) return
    try {
      const sdp = jingleToDescription(jingle, 'responder', session.mids)
      await this.remoteDescription(session, { type: 'answer', sdp })
    } catch {
      this.finish(session, 'incompatible-parameters', 'The other contact sent an incompatible call answer.', false)
      throw stanzaError('bad-request')
    }
    session.negotiated = true
    this.connectionChanged(session)
  }

  async receiveCandidates (session, jingle) {
    try {
      const candidates = transportCandidates(jingle, session.mids)
      if (!session.remoteReady) {
        if (session.candidates.length + candidates.length > 256) throw new Error('Too many pending candidates')
        session.candidates.push(...candidates)
      } else {
        await Promise.allSettled(candidates.map(candidate => session.pc.addIceCandidate(candidate)))
      }
    } catch {
      throw stanzaError('bad-request')
    }
  }

  rejectContentAddition (session, jingle) {
    let contents
    try {
      contents = rejectedContents(jingle, session.mids)
    } catch {
      throw stanzaError('bad-request')
    }
    this.later(() => {
      if (this.session === session) this.sendAction(session, 'content-reject', contents).catch(() => {})
    })
  }

  async receive (address, jingle) {
    const peer = fullJid(address)
    if (!this.ownJid || !peer || peer.bare().toString() === this.ownJid.bare().toString() || !jingle?.is('jingle', JINGLE)) {
      throw stanzaError('bad-request')
    }
    const { sid, action } = jingle.attrs
    if (!validSid(sid) || !action) throw stanzaError('bad-request')
    if (action === 'session-initiate') return this.receiveOffer(peer.toString(), jingle)

    const session = this.session
    if (!session?.signalled || session.peer !== peer.toString() || session.sid !== sid) throw stanzaError('item-not-found', 'unknown-session')
    switch (action) {
      case 'session-accept':
        return this.receiveAnswer(session, jingle)
      case 'session-terminate': {
        const reason = jingle.getChild('reason', JINGLE)
        const condition = readReason(reason) ?? (reason?.getChildElements().length ? 'general-error' : 'success')
        const code = Object.hasOwn(REMOTE_END_MESSAGES, condition) ? condition : 'general-error'
        this.finish(session, code, REMOTE_END_MESSAGES[code], false)
        return
      }
      case 'transport-info':
        return this.receiveCandidates(session, jingle)
      case 'content-add':
        return this.rejectContentAddition(session, jingle)
      case 'session-info':
        if (jingle.getChildElements().every(info => info.is('ringing', RTP_INFO) || info.is('active', RTP_INFO))) return
        throw stanzaError('feature-not-implemented', 'unsupported-info')
      default:
        throw stanzaError('feature-not-implemented')
    }
  }
}

export default JingleCall
