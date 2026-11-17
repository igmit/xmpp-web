/// <reference types="cypress" />
/* eslint-disable no-undef */

import JingleCall from '../../src/services/JingleCall.js'

describe('Jingle browser media', () => {
  const callerJid = 'caller@example.test/cypress'
  const calleeJid = 'callee@example.test/cypress'
  const peers = new Map()
  let audio

  afterEach(() => {
    peers.forEach(peer => peer.reset())
    peers.clear()
    return audio?.close()
  })

  it('negotiates audio and video on both peers and releases the tracks on hangup', () => {
    const states = new Map()
    function createPeer (ownJid) {
      const peer = new JingleCall({
        ownJid,
        send: (to, jingle) => peers.get(to).receive(ownJid, jingle),
        onChange: state => states.set(ownJid, state),
      })
      peers.set(ownJid, peer)
      return peer
    }

    const caller = createPeer(callerJid)
    const callee = createPeer(calleeJid)
    let tracks

    cy.then(() => {
      audio = new AudioContext()
      const tone = audio.createOscillator()
      tone.start()
      cy.stub(navigator.mediaDevices, 'getUserMedia').callsFake(async ({ video }) => {
        const destination = audio.createMediaStreamDestination()
        tone.connect(destination)
        if (video) {
          const canvas = document.createElement('canvas')
          canvas.width = canvas.height = 64
          const stream = canvas.captureStream(10)
          canvas.getContext('2d').fillRect(0, 0, 64, 64)
          destination.stream.addTrack(stream.getVideoTracks()[0])
        }
        return destination.stream
      })
    })
    cy.then({ timeout: 20000 }, () => caller.start(calleeJid, true))
    cy.then({ timeout: 20000 }, () => {
      expect(states.get(calleeJid)?.phase, 'callee phase on receiving the offer').to.equal('incoming')
      return callee.accept()
    })

    cy.wrap(null, { timeout: 15000 }).should(() => {
      for (const jid of peers.keys()) {
        const state = states.get(jid)
        expect(state.phase, `${jid} phase`).to.equal('active')
        expect(state.remoteStream.getTracks().map(track => track.kind).sort()).to.deep.equal(['audio', 'video'])
      }
    })

    cy.then(() => {
      tracks = [...states.values()].flatMap(({ localStream, remoteStream }) => [...localStream.getTracks(), ...remoteStream.getTracks()])
      return caller.end()
    }).then(() => {
      for (const state of states.values()) {
        expect(state.phase).to.equal('ended')
        expect(state.localStream).to.be.null
        expect(state.remoteStream).to.be.null
      }
      tracks.forEach(track => expect(track.readyState, track.kind).to.equal('ended'))
    })
  })
})
