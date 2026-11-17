/// <reference types="cypress" />
/* eslint-disable no-undef */

import JingleCall from '../../src/services/JingleCall.js'

describe('Jingle browser media', () => {
  const callerJid = 'caller@example.test/cypress'
  const calleeJid = 'callee@example.test/cypress'
  const peers = new Map()
  let audio
  const players = []

  afterEach(() => {
    peers.forEach(peer => peer.reset())
    peers.clear()
    for (const player of players.splice(0)) {
      player.pause()
      player.srcObject = null
      player.remove()
    }
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
      const frequencies = [480, 960, 720]
      cy.stub(navigator.mediaDevices, 'getUserMedia').callsFake(async ({ video }) => {
        const tone = audio.createOscillator()
        tone.frequency.value = frequencies.shift()
        tone.start()
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
      return audio.resume()
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

    // Check the decoded sound as well as the presence of a remote audio track.
    const receivers = []
    cy.then(async () => {
      for (const [jid, expectedHz] of [[callerJid, 960], [calleeJid, 480]]) {
        const stream = states.get(jid).remoteStream
        const player = document.createElement('audio')
        players.push(player)
        document.body.append(player)
        player.srcObject = stream
        await player.play()
        const source = audio.createMediaStreamSource(stream)
        const spectrum = audio.createAnalyser()
        source.connect(spectrum)
        receivers.push({ jid, expectedHz, spectrum })
      }
    })
    cy.wrap(null, { timeout: 10000 }).should(() => {
      for (const { jid, expectedHz, spectrum } of receivers) {
        const levels = new Uint8Array(spectrum.frequencyBinCount)
        spectrum.getByteFrequencyData(levels)
        const peak = Math.max(...levels)
        expect(peak, `${jid} received an audible signal`).to.be.greaterThan(0)
        const hzPerBin = audio.sampleRate / spectrum.fftSize
        expect(levels.indexOf(peak) * hzPerBin, `${jid} hears the other microphone`).to.be.closeTo(expectedHz, hzPerBin * 2)
      }
    })

    // Reproduce a dead capture on the answering side while incoming media keeps playing.
    cy.then(() => callee.session.localStream.getAudioTracks()[0].stop())
    cy.wrap(null).should(() => {
      expect(states.get(calleeJid).microphoneStatus).to.equal('unavailable')
    })
    cy.then(() => callee.reconnectMicrophone())
    cy.wrap(null, { timeout: 10000 }).should(() => {
      expect(states.get(calleeJid).phase).to.equal('active')
      expect(states.get(calleeJid).microphoneStatus).to.be.null
      const { spectrum } = receivers.find(receiver => receiver.jid === callerJid)
      const levels = new Uint8Array(spectrum.frequencyBinCount)
      spectrum.getByteFrequencyData(levels)
      const hzPerBin = audio.sampleRate / spectrum.fftSize
      expect(levels.indexOf(Math.max(...levels)) * hzPerBin, 'replacement microphone at the far end').to.be.closeTo(720, hzPerBin * 2)
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
