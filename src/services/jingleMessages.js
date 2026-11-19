import jid from '@xmpp/jid'
import xml from '@xmpp/xml'
import { nanoid } from 'nanoid'
import { JINGLE, JINGLE_MESSAGE, RTP } from './jingleNamespaces.js'

const CLIENT = 'jabber:client'
const CARBONS = 'urn:xmpp:carbons:2'
const FORWARDED = 'urn:xmpp:forward:0'
const DELAY = 'urn:xmpp:delay'
const RECEIPTS = 'urn:xmpp:receipts'
const HINTS = 'urn:xmpp:hints'
const REMOTE_ACTIONS = ['propose', 'retract', 'finish']
const SIBLING_ACTIONS = ['accept', 'proceed', 'reject']

function address (value) {
  if (typeof value !== 'string') return null
  try {
    const parsed = jid(value)
    return parsed.getLocal() ? parsed : null
  } catch {
    return null
  }
}

function liveMessage (stanza) {
  if (!stanza?.is('message', CLIENT)) return false
  const type = stanza.attrs.type || 'normal'
  return (type === 'chat' || type === 'normal') && !stanza.getChildElements().some(child =>
    child.is('delay', DELAY) || child.is('x', 'jabber:x:delay') || child.is('forwarded', FORWARDED) ||
    (child.getName() === 'result' && /^urn:xmpp:mam:[0-9]+$/.test(child.getNS())))
}

function idPresent (value) {
  return typeof value === 'string' && value.length > 0 && !/\s/.test(value)
}

export function readReason (reason) {
  return reason?.getChildElements()
    .find(child => child.getName() !== 'text' && child.getNS() === JINGLE)?.getName()
}

export function readInvitation (stanza, ownJid) {
  if (!ownJid?.bare || !ownJid.full || !liveMessage(stanza) || stanza.parent?.is('forwarded', FORWARDED)) return null

  let message = stanza
  const carbons = stanza.getChildElements().filter(child => child.is('sent', CARBONS) || child.is('received', CARBONS))
  const carbon = carbons[0]
  if (carbon) {
    if (carbons.length !== 1 || stanza.attrs.from !== ownJid.bare || stanza.attrs.to !== ownJid.full ||
        stanza.getChildElements().some(child => child.getNS() === JINGLE_MESSAGE)) return null
    const [forwarded, extra] = carbon.getChildElements()
    if (extra || !forwarded?.is('forwarded', FORWARDED)) return null
    const [original, extraForwardedChild] = forwarded.getChildElements()
    if (extraForwardedChild || !liveMessage(original)) return null
    message = original
  }

  const candidates = message.getChildElements().filter(child => child.getNS() === JINGLE_MESSAGE)
  if (candidates.length !== 1) return null
  const [payload] = candidates
  const action = payload.getName()
  const { id } = payload.attrs
  const sender = address(message.attrs.from)
  const recipient = address(message.attrs.to)
  if (!idPresent(id) || !sender?.getResource() || !recipient) return null
  const from = sender.toString()
  const to = recipient.toString()
  const ownTarget = to === ownJid.bare || to === ownJid.full
  const ownSender = sender.bare().toString() === ownJid.bare
  const sentCarbon = carbon?.is('sent', CARBONS)
  if (ownSender) {
    if (from === ownJid.full || !SIBLING_ACTIONS.includes(action)) return null
    const legacyCopy = to === ownJid.bare && action !== 'proceed'
    if (sentCarbon) {
      if (!legacyCopy && (recipient.bare().toString() === ownJid.bare || !recipient.getResource())) return null
    } else if (!legacyCopy) return null
  } else if (sentCarbon || !ownTarget || !REMOTE_ACTIONS.includes(action)) return null

  let media
  if (action === 'propose') {
    const descriptions = payload.getChildElements()
    if (!descriptions.every(child => child.is('description', RTP))) return null
    media = descriptions.map(child => child.attrs.media)
    if (!media.includes('audio') || !(media.length === 1 || (media.length === 2 && media.includes('video')))) return null
  }

  const reason = readReason(payload.getChild('reason', JINGLE))
  const requestsReceipt = !carbon && !ownSender && message.getChild('request', RECEIPTS) && !message.getChild('received', RECEIPTS)
  const receiptId = requestsReceipt && idPresent(message.attrs.id) ? message.attrs.id : undefined
  return { from, to, action, id, media, reason, receiptId }
}

export function invitationMessage (to, action, id, reason) {
  const condition = reason ? xml('reason', { xmlns: JINGLE }, xml(reason)) : null
  return xml('message', { to, type: 'chat', id: nanoid() },
    xml(action, { xmlns: JINGLE_MESSAGE, id }, condition),
    xml('store', { xmlns: HINTS }))
}

export function receiptMessage (to, receiptId) {
  return xml('message', { to, type: 'chat', id: nanoid() },
    xml('received', { xmlns: RECEIPTS, id: receiptId }),
    xml('no-store', { xmlns: HINTS }),
    xml('no-copy', { xmlns: HINTS }))
}
