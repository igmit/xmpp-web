import JingleCall from './JingleCall.js'
import { readInvitation, invitationMessage, receiptMessage } from './jingleMessages.js'

export function registerJingleCalls (socket, client) {
  let controller
  let address

  function bind (jid) {
    if (client !== socket.client) return
    const ownJid = client.parseJid(jid)
    if (address?.full !== ownJid.full) {
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
      ($route.name === 'chat' && $route.params.jid === from.bare) ||
      (controller.session?.peer === from.full && controller.session.sid === sid)
  }

  client.on('online', jid => {
    if (client !== socket.client) return
    socket.context.$store.callResources = []
    bind(jid)
  })
  client.on('resumed', () => bind(client.xmpp.jid))
  client.on('status', status => {
    if (client === socket.client && ['close', 'disconnect', 'offline'].includes(status)) {
      controller?.signalingLost()
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
    if (client !== socket.client || !socket.calls) return false
    const invitation = readInvitation(stanza, address)
    if (!invitation) return false
    const { from, to, action, id, media, reason, receiptId } = invitation
    const sender = client.parseJid(from)
    const pendingProposal = controller.session?.proposedTo === sender.bare && controller.session.sid === id
    if (sender.bare === address.bare || pendingProposal || allowsCaller(sender, id)) {
      if (receiptId) client.xmpp.send(receiptMessage(sender.full, receiptId)).catch(() => {})
      controller.receiveInvitation(sender.full, action, id, media || reason, to).catch(() => {})
    }
    return true
  })
}
