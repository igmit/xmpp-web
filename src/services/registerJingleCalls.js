import JingleCall, { RING_TIMEOUT } from './JingleCall.js'
import { readInvitation, invitationMessage, receiptMessage } from './jingleMessages.js'

const OFFLINE_DELIVERY_QUIET_PERIOD = 750
const OFFLINE_DELIVERY_MAX_WAIT = 2000
const RECENT_INVITATION_LIMIT = 128

function invitationKey (peer, id) {
  return `${peer}\0${id}`
}

export function registerJingleCalls (socket, client) {
  let controller
  let address
  let replayTimer
  let replayDeadline
  const pending = new Map()
  const suppressed = new Map()

  function isCurrent () {
    return client === socket.client && controller && socket.calls === controller
  }

  function clearReplay () {
    clearTimeout(replayTimer)
    replayDeadline = undefined
    pending.clear()
  }

  function bind (jid) {
    if (client !== socket.client) return
    const ownJid = client.parseJid(jid)
    if (address?.full !== ownJid.full) {
      clearReplay()
      if (address?.bare !== ownJid.bare) suppressed.clear()
      controller?.reset()
      address = ownJid
      controller = new JingleCall({
        ownJid: address.full,
        send: (peer, jingle) => client.sendJingle(peer, jingle),
        sendInvitation: (peer, action, sid, details) => client.xmpp.send(invitationMessage(peer, action, sid, details)),
        onChange: call => { socket.context.$store.call = call },
        iceServers: () => client.getIceServers(),
      })
    }
    socket.calls = controller
    socket.context.$store.callAccount = address.bare
    controller.signalingRestored()
  }

  function allowsCaller (from, sid) {
    if (!from.resource) return false
    const { $store, $route } = socket.context
    return $store.contacts.some(contact => contact.jid === from.bare) ||
      ($route?.name === 'chat' && $route.params.jid === from.bare) ||
      (controller.session?.peer === from.full && controller.session.sid === sid)
  }

  function deliver ({ from, to, action, id, media, reason, receiptId, delayedAt }) {
    if (receiptId) client.xmpp.send(receiptMessage(from, receiptId)).catch(() => {})
    const expiresAt = delayedAt === undefined ? undefined : delayedAt + RING_TIMEOUT
    controller.receiveInvitation(from, action, id, media || reason, to, expiresAt).catch(() => {})
  }

  function suppress (key, now) {
    suppressed.delete(key)
    suppressed.set(key, now + RING_TIMEOUT)
    if (suppressed.size > RECENT_INVITATION_LIMIT) suppressed.delete(suppressed.keys().next().value)
  }

  function isSuppressed (key, id, now) {
    return (suppressed.get(key) || 0) > now || (suppressed.get(invitationKey(address.bare, id)) || 0) > now
  }

  function replayOfflineInvitations () {
    const invitations = [...pending]
    clearReplay()
    for (const [key, invitation] of invitations) {
      if (!isCurrent()) return
      const now = Date.now()
      if (isSuppressed(key, invitation.id, now) || !allowsCaller(client.parseJid(invitation.from), invitation.id)) continue
      suppress(key, now)
      if (invitation.delayedAt + RING_TIMEOUT > now) deliver(invitation)
    }
  }

  function scheduleReplay (now) {
    if (!pending.size) return
    // Automatic offline delivery has no completion stanza. Give the queued
    // messages time to arrive together without delaying an invitation indefinitely.
    if (!replayDeadline) replayDeadline = now + OFFLINE_DELIVERY_MAX_WAIT
    clearTimeout(replayTimer)
    replayTimer = setTimeout(replayOfflineInvitations,
      Math.min(OFFLINE_DELIVERY_QUIET_PERIOD, Math.max(0, replayDeadline - now)))
  }

  client.on('online', jid => {
    if (client !== socket.client) return
    socket.context.$store.callResources = []
    bind(jid)
  })
  client.on('resumed', () => bind(client.xmpp.jid))
  client.on('status', status => {
    if (['close', 'disconnect', 'offline'].includes(status)) {
      clearReplay()
      if (client === socket.client) controller?.signalingLost()
    }
  })
  client.enableCalls((peer, jingle) => {
    if (socket.client !== client || !socket.calls) {
      throw Object.assign(new Error('Offline'), { condition: 'service-unavailable' })
    }
    if (!peer) throw Object.assign(new Error('Missing sender'), { condition: 'bad-request' })
    const from = client.parseJid(peer)
    if (!allowsCaller(from, jingle.attrs.sid)) {
      throw Object.assign(new Error('Unknown contact'), { condition: 'forbidden' })
    }
    return controller.receive(from.full, jingle)
  }, stanza => {
    if (!isCurrent()) return false
    const invitation = readInvitation(stanza, address)
    if (!invitation) return false
    const { from, to, action, id, delayedAt } = invitation
    const sender = client.parseJid(from)
    const sibling = sender.bare === address.bare
    const pendingProposal = controller.session?.proposedTo === sender.bare && controller.session.sid === id
    if (!sibling && !pendingProposal && !allowsCaller(sender, id)) return true

    const now = Date.now()
    const key = invitationKey(from, id)
    if (delayedAt !== undefined) {
      if (delayedAt > now) return true
      if (delayedAt + RING_TIMEOUT <= now) {
        if (action === 'propose') suppress(key, now)
        return true
      }
    }
    if (action === 'propose') {
      if (isSuppressed(key, id, now)) return true
      const earlier = pending.get(key)
      if (delayedAt !== undefined) {
        if (earlier ? delayedAt < earlier.delayedAt : pending.size < RECENT_INVITATION_LIMIT) pending.set(key, invitation)
      } else if (!earlier) {
        deliver(invitation)
      }
    } else {
      if (sibling || action === 'retract' || action === 'finish') {
        suppress(sibling ? invitationKey(to, id) : key, now)
      }
      deliver(invitation)
    }
    if (delayedAt !== undefined) scheduleReplay(now)
    return true
  })
}
