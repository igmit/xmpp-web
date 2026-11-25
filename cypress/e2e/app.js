/// <reference types="cypress" />
/* eslint-disable no-undef */

import { MockServer } from '../support/mock-socket'
import { WebSocket } from 'mock-socket'
import 'cypress-real-events'
import { version } from '../../package.json'

let url = 'wss://chat.domain-web.ltd/xmpp-websocket'
const jidLocal = 'admin'
let jidDomain = 'domain-xmpp.ltd'

let mockServer

const onBeforeLoad = (win) => {
  // Keep the preview's service worker from serving a cached page outside Cypress's proxy.
  // Every navigation in this suite needs its test WebSocket installed before the app starts.
  if (win.navigator.serviceWorker) {
    cy.stub(win.navigator.serviceWorker, 'register').rejects(new Error('Service worker disabled in mock XMPP tests'))
  }
  // stub websocket requests
  cy.stub(win, 'WebSocket').callsFake(url => {
    return new WebSocket(url)
  }).as('WebSocket')
}

describe('XMPP Web for registered users', () => {
  before(() => {
    cy.clearAllCookies()
      .clearAllLocalStorage()
      .clearAllSessionStorage()
      .visit('/', {
        onBeforeLoad,
        onLoad: (win) => {
        // get config
          url = win.config.transports.websocket
          jidDomain = win.config.defaultDomain
          mockServer = MockServer({ url, jidLocal, jidDomain })
        },
      })
  })

  describe('Login', function () {
    it('displays login page with submit disabled', () => {
      cy.get('input[name="jid"]').should('have.attr', 'placeholder', `username@${jidDomain}`)
      cy.get('input[name="password"]').should('have.attr', 'placeholder', 'Password')
      cy.get('button[type="submit"]').should('be.disabled')
    })
    it('can login and route to main page', () => {
      cy.visit('/', {
        onBeforeLoad,
      })
        .get('input[name="jid"]').type(jidLocal)
        .get('button[type="submit"]').should('be.disabled')
        .get('input[name="password"]').type('pwd')
        .get('button[type="submit"]').should('be.enabled')
        .get('button[type="submit"]').click()
        .hash().should('eq', '#/')
        .get('#navbar-menu', { includeShadowDom: true }).should('contain', `${jidLocal}@${jidDomain}`)
    })
    it('does not store credentials', () => {
      cy.visit('/', {
        onBeforeLoad,
      })
        .hash().should('eq', '#/login?redirect=/')
    })
    it('can login and store credentials', () => {
      cy.visit('/', {
        onBeforeLoad,
      })
        .get('input[name="jid"]').clear().type('myuser')
        .get('input[name="password"]').type('pwd')
        .get('input[type="checkbox"]').check()
        .get('button[type="submit"]').click()
        .hash().should('eq', '#/')
        .get('#navbar-menu', { includeShadowDom: true }).should('contain', `${jidLocal}@${jidDomain}`)
      cy.visit('/', {
        onBeforeLoad,
      })
        .hash().should('eq', '#/')
    })
  })

  describe('Contacts', function () {
    it('displays contacts', () => {
      cy.get('#contactsList li').should('have.length', 1)
        .get('#contactsList li').first().should('have.text', `user2@${jidDomain}`)
    })
    it('can open conversation from contact and load history', () => {
      cy.get('#contactsList li').first().click()
        .get('#app').find('.sendbox').should('exist')
        .get('#messages-container').should('contain', 'Previous message')
    })
  })

  describe('Groups', function () {
    it('displays groups', () => {
      cy.get('#groupsList li').should('have.length', 1)
        .get('#groupsList li').first().should('have.text', 'Dev Team')
    })
    it('displays display contact in a group', () => {
      cy.get('#groupsList li:first-child a').click()
        .get('#groupsList li:first-child ul li').first().should('have.text', `user2@${jidDomain}`)
    })
    it('can open conversation from contact and load history', () => {
      cy.get('#contactsList li').first().click()
        .get('#app').find('.sendbox').should('exist')
        .get('#messages-container').should('contain', 'Previous message')
    })
  })

  describe('Chat', function () {
    it('can type message', () => {
      cy.get('.sendbox textarea').type('Hello, this is a new message')
    })
    it('can select an emoji', () => {
      cy.get('.sendbox button:not([type="submit"])[title="Choose an emoji"]').click()
        .get('.sendbox .emojiPicker [role="tab"]:first').next().click()
        .get('.sendbox .emojiPicker a[title="writing hand"]').click()
        .get('.sendbox button[type="submit"]').click()
    })
    it('display received message', () => {
      const msg = 'Hello, do you copy?'
      mockServer.emit('message', `<message type="chat" to="${jidLocal}@${jidDomain}" from="user2@${jidDomain}/dummyClient" id="C9Sojvuc_FSF-pTIN4QYz" xmlns="jabber:client"><body>${msg}</body><active xmlns="http://jabber.org/protocol/chatstates"/><origin-id xmlns="urn:xmpp:sid:0" id="C9Sojvuc_FSF-pTIN4QYz"/></message>`)
      cy.get('#messages-container').should('contain', msg)
    })
    it('display inline code formatted', () => {
      const code = 'inline code'
      const msg = 'This is inline code: `' + code + '`'
      mockServer.emit('message', `<message type="chat" to="${jidLocal}@${jidDomain}" from="user2@${jidDomain}/dummyClient" id="inline-code" xmlns="jabber:client"><body>${msg}</body><active xmlns="http://jabber.org/protocol/chatstates"/><origin-id xmlns="urn:xmpp:sid:0" id="inline-code"/></message>`)
      cy.get('#messages-container div:last-child code').should('have.text', code)
    })
    it('display code block formatted', () => {
      const code = 'code block'
      const msg = 'This is code block:\n``` js\n' + code + '\n```'
      mockServer.emit('message', `<message type="chat" to="${jidLocal}@${jidDomain}" from="user2@${jidDomain}/dummyClient" id="code-block" xmlns="jabber:client"><body>${msg}</body><active xmlns="http://jabber.org/protocol/chatstates"/><origin-id xmlns="urn:xmpp:sid:0" id="code-block"/></message>`)
      cy.get('#messages-container div:last-child pre code').should('have.text', code)
    })
  })

  describe('Calls', function () {
    const audioCall = 'button[aria-label="Start audio call"]'
    const videoCall = 'button[aria-label="Start video call"]'
    const callPanel = '[aria-label="Call controls"]'
    const jmi = 'urn:xmpp:jingle-message:0'
    const receipts = 'urn:xmpp:receipts'
    const rtp = 'urn:xmpp:jingle:apps:rtp:1'

    function sendProposal (peer, sid, stamp) {
      mockServer.emit('message', `<message from="${peer}" to="${jidLocal}@${jidDomain}" type="chat" id="proposal-${sid}" xmlns="jabber:client">
        <propose xmlns="${jmi}" id="${sid}"><description xmlns="${rtp}" media="audio"/></propose>
        ${stamp ? `<delay xmlns="urn:xmpp:delay" from="${jidDomain}" stamp="${stamp}"/>` : ''}
        <request xmlns="${receipts}"/><store xmlns="urn:xmpp:hints"/>
      </message>`)
    }

    function sendRetract (peer, sid, stamp) {
      mockServer.emit('message', `<message from="${peer}" to="${jidLocal}@${jidDomain}" type="chat" xmlns="jabber:client">
        <retract xmlns="${jmi}" id="${sid}"/><store xmlns="urn:xmpp:hints"/>
        ${stamp ? `<delay xmlns="urn:xmpp:delay" from="${jidDomain}" stamp="${stamp}"/>` : ''}
      </message>`)
    }

    function expectCallMessage (peer, namespace, action, id) {
      const parser = new DOMParser()
      cy.wrap(mockServer.receivedStanzas, { log: false }).should(stanzas => {
        const sent = stanzas.some(stanza => {
          if (!stanza.startsWith('<message ')) return false
          const message = parser.parseFromString(stanza, 'application/xml').documentElement
          const child = message.getElementsByTagNameNS(namespace, action)[0]
          return message.getAttribute('to') === peer && child?.getAttribute('id') === id
        })
        expect(sent, `${action} ${id} sent to ${peer}`).to.equal(true)
      })
    }

    it('proposes a video call to the account with no online resource and waits for proceed', () => {
      const bare = `user2@${jidDomain}`
      const phone = `${bare}/Conversations`
      let sid
      cy.window().then(win => {
        cy.stub(win.navigator.mediaDevices, 'getUserMedia')
          .rejects(new win.DOMException('Permission denied', 'NotAllowedError')).as('capture')
      })
      cy.get(videoCall).click()
      cy.get(callPanel).should('contain', 'Starting video call')
      cy.wrap(mockServer.receivedStanzas, { log: false }).should(stanzas => {
        const sent = stanzas.find(value => value.startsWith('<message ') && value.includes('<propose '))
        expect(sent, 'outgoing proposal').to.be.a('string')
        const message = new DOMParser().parseFromString(sent, 'application/xml').documentElement
        const proposal = message.getElementsByTagNameNS(jmi, 'propose')[0]
        expect(message.getAttribute('to')).to.equal(bare)
        expect([...proposal.getElementsByTagNameNS(rtp, 'description')].map(item => item.getAttribute('media')))
          .to.deep.equal(['audio', 'video'])
        sid = proposal.getAttribute('id')
      })
      cy.get('@capture').should('not.have.been.called')
      const respond = action => cy.then(() => {
        mockServer.emit('message', `<message from="${phone}" to="${jidLocal}@${jidDomain}" type="chat" xmlns="jabber:client">
          <${action} xmlns="${jmi}" id="${sid}"/>
        </message>`)
      })
      respond('ringing')
      cy.get(callPanel).should('contain', 'Ringing video call')
      cy.get('@capture').should('not.have.been.called')
      respond('proceed')
      cy.get('@capture').should('have.been.calledOnce')
      cy.get(callPanel).should('contain', 'Call ended')
      cy.then(() => expectCallMessage(phone, jmi, 'finish', sid))
      cy.contains(`${callPanel} button`, 'Dismiss').click()
    })

    it('shows call controls when a contact has a legacy callable resource', () => {
      cy.then(() => {
        mockServer.emit('message', `<presence from="user2@${jidDomain}/callClient" xmlns="jabber:client"/>`)
      })
      cy.get(audioCall).should('be.enabled')
      cy.get(videoCall).should('be.enabled')
    })

    it('shows a media permission failure and closes the ended call after counting down', () => {
      cy.clock(Date.now(), ['Date', 'setInterval', 'clearInterval'])
      cy.window().then(win => {
        cy.stub(win.navigator.mediaDevices, 'getUserMedia')
          .rejects(new win.DOMException('Permission denied', 'NotAllowedError'))
          .as('getUserMedia')
      })
      cy.get(audioCall).click()
      cy.get('@getUserMedia').should('have.been.calledOnce')
      cy.get(callPanel).should('contain', 'Call ended')
        .find('[role="alert"]').should('be.visible')
      cy.contains(`${callPanel} button`, 'Dismiss').should('be.visible')
      cy.get(callPanel).should('contain', 'Closing in 5s')
      cy.tick(4000)
      cy.get(callPanel).should('contain', 'Closing in 1s')
      cy.tick(1000)
      cy.get(callPanel).should('not.exist')
      cy.get(audioCall).should('be.enabled')
    })

    it('lets the caller select another microphone when capture ends during setup', () => {
      let context
      cy.window().then(win => {
        context = new win.AudioContext()
        const capture = cy.stub(win.navigator.mediaDevices, 'getUserMedia').as('capture')
        const stopped = context.createMediaStreamDestination().stream
        stopped.getAudioTracks()[0].stop()
        capture.onFirstCall().resolves(stopped)
        capture.onSecondCall().resolves(context.createMediaStreamDestination().stream)
        cy.stub(win.navigator.mediaDevices, 'enumerateDevices').resolves([
          { kind: 'audioinput', deviceId: 'alternate', label: 'Headset microphone' },
        ])
      })
      cy.get(audioCall).click()
      cy.get(callPanel).should('contain', 'Your microphone stopped')
      cy.get(`${callPanel} select`).select('Headset microphone')
      cy.contains(`${callPanel} button`, 'Reconnect microphone').click()
      cy.get('@capture').should('have.been.calledWith', { audio: { deviceId: { exact: 'alternate' } } })
      cy.get(callPanel).should('not.contain', 'Your microphone stopped')
      cy.contains(`${callPanel} button`, 'Cancel call').click()
      cy.contains(`${callPanel} button`, 'Dismiss').click()
      cy.then(() => context.close())
    })

    it('keeps the call controls available when navigating away from the chat', () => {
      cy.window().then(win => {
        cy.stub(win.navigator.mediaDevices, 'getUserMedia').returns(new Promise(() => {}))
      })
      cy.get(videoCall).click()
      cy.get(callPanel).should('contain', 'Starting video call')
      cy.get(audioCall).should('be.disabled')
      cy.get('.navbar-brand .navbar-item').first().click()
      cy.hash().should('eq', '#/')
      cy.get(videoCall).should('not.exist')
      cy.contains(`${callPanel} button`, 'Cancel call').click()
      cy.contains(`${callPanel} button`, 'Dismiss').click()
      cy.get(callPanel).should('not.exist')
      cy.get('#contactsList li').first().click()
      cy.get(videoCall).should('be.enabled')
    })

    it('keeps call controls available after the last resource goes offline', () => {
      cy.then(() => {
        mockServer.emit('message', `<presence from="user2@${jidDomain}/audioClient" xmlns="jabber:client"/>`)
        mockServer.emit('message', `<presence from="user2@${jidDomain}/callClient" type="unavailable" xmlns="jabber:client"/>`)
      })
      cy.get(videoCall).should('be.enabled')
      cy.get(audioCall).should('be.enabled')
      cy.then(() => {
        mockServer.emit('message', `<presence from="user2@${jidDomain}/audioClient" type="unavailable" xmlns="jabber:client"/>`)
      })
      cy.get(audioCall).should('be.enabled')
      cy.get(videoCall).should('be.enabled')
    })

    it('answers a Conversations proposal without prompting again on session-initiate', () => {
      const peer = `user2@${jidDomain}/Conversations`
      const sid = 'conversations-accepted'
      cy.window().then(win => {
        cy.stub(win.navigator.mediaDevices, 'getUserMedia')
          .rejects(new win.DOMException('Permission denied', 'NotAllowedError'))
          .as('getUserMedia')
        sendProposal(peer, sid)
      })
      cy.get(callPanel).should('contain', 'Incoming audio call').and('contain', `user2@${jidDomain}`)
      cy.get(`${callPanel} audio[loop]`).should('have.prop', 'paused', false)
      expectCallMessage(peer, receipts, 'received', `proposal-${sid}`)
      cy.get('@getUserMedia').should('not.have.been.called')
      cy.contains(`${callPanel} button`, 'Accept').click()
      cy.get(`${callPanel} audio[loop]`).should('not.exist')
      expectCallMessage(peer, jmi, 'proceed', sid)
      cy.window().then(win => {
        const target = `${jidLocal}@${jidDomain}/${win.config.resource || 'Web XMPP'}`
        const fingerprint = Array(32).fill('AA').join(':')
        mockServer.emit('message', `<iq from="${peer}" to="${target}" type="set" id="incoming-${sid}" xmlns="jabber:client">
          <jingle xmlns="urn:xmpp:jingle:1" action="session-initiate" sid="${sid}" initiator="${peer}">
            <content creator="initiator" name="audio">
              <description xmlns="${rtp}" media="audio">
                <payload-type id="0" name="PCMU" clockrate="8000"/><rtcp-mux/>
              </description>
              <transport xmlns="urn:xmpp:jingle:transports:ice-udp:1" ufrag="abcd" pwd="abcdefghijklmnopqrstuv">
                <fingerprint xmlns="urn:xmpp:jingle:apps:dtls:0" hash="sha-256" setup="actpass">${fingerprint}</fingerprint>
              </transport>
            </content>
          </jingle>
        </iq>`)
      })
      cy.get('@getUserMedia').should('have.been.calledOnce')
      cy.get(callPanel).should('contain', 'Call ended')
        .find('[role="alert"]').should('contain', 'microphone')
      cy.contains(`${callPanel} button`, 'Accept').should('not.exist')
      cy.contains(`${callPanel} button`, 'Dismiss').click()
    })

    it('rings only the outstanding invitation from an offline delivery batch', () => {
      const peer = `user2@${jidDomain}/Conversations`
      cy.window().then(win => {
        cy.stub(win.HTMLMediaElement.prototype, 'play').resolves().as('ringtone')
        const stamp = new Date().toISOString()
        sendProposal(peer, 'offline-canceled', stamp)
        sendRetract(peer, 'offline-canceled', stamp)
        sendProposal(peer, 'offline-outstanding', stamp)
      })
      expectCallMessage(peer, jmi, 'ringing', 'offline-outstanding')
      cy.get(callPanel).should('contain', 'Incoming audio call')
      cy.get('@ringtone').should('have.been.calledOnce')
      cy.then(() => {
        const rangCanceledCall = mockServer.receivedStanzas.some(stanza =>
          stanza.includes('<ringing ') && stanza.includes('id="offline-canceled"'))
        expect(rangCanceledCall).to.equal(false)
      })
      cy.contains(`${callPanel} button`, 'Decline').click()
      cy.contains(`${callPanel} button`, 'Dismiss').click()
    })

    it('keeps the call visible when autoplay is blocked and retries on interaction', () => {
      const peer = `user2@${jidDomain}/Conversations`
      cy.window().then(win => {
        const play = cy.stub(win.HTMLMediaElement.prototype, 'play').resolves().as('playTone')
        play.onFirstCall().rejects(new win.DOMException('User interaction required', 'NotAllowedError'))
        sendProposal(peer, 'blocked-tone')
      })
      cy.contains(`${callPanel} button`, 'Accept').should('be.visible')
      cy.get('@playTone').should('have.been.calledOnce')
      cy.get('body').trigger('keydown', { key: 'Shift' })
      cy.get('@playTone').should('have.been.calledTwice')
      cy.contains(`${callPanel} button`, 'Decline').click()
      cy.contains(`${callPanel} button`, 'Dismiss').click()
      cy.get('body').trigger('keydown', { key: 'Shift' })
      cy.get('@playTone').should('have.been.calledTwice')
    })

    it('saves the ringtone preference and stops playback when muted or the call ends', () => {
      const peer = `user2@${jidDomain}/Conversations`
      const toggle = () => cy.contains('#dropdown-menu label', 'Incoming call ringtone').find('input')
      toggle().should('be.checked').uncheck({ force: true })
      cy.then(() => {
        mockServer.beforeRosterReply = () => {
          sendProposal(peer, 'muted-call')
          delete mockServer.beforeRosterReply
        }
      })
      cy.visit('/', { onBeforeLoad })
      toggle().should('not.be.checked')
      cy.get(callPanel).should('contain', 'Incoming audio call')
      cy.get(`${callPanel} audio[loop]`).should('not.exist')

      toggle().check({ force: true })
      cy.get(`${callPanel} audio[loop]`).should(tone => {
        expect(tone[0].currentTime).to.be.greaterThan(0)
      }).then(tone => {
        toggle().uncheck({ force: true })
        cy.get(`${callPanel} audio[loop]`).should('not.exist').then(() => {
          expect(tone[0].paused).to.equal(true)
        })
      })
      toggle().check({ force: true })
      cy.get(`${callPanel} audio[loop]`).should(tone => {
        expect(tone[0].paused).to.equal(false)
      }).then(tone => {
        sendRetract(peer, 'muted-call')
        cy.get(`${callPanel} audio[loop]`).should('not.exist').then(() => {
          expect(tone[0].paused).to.equal(true)
        })
      })
      cy.contains(`${callPanel} button`, 'Dismiss').click()
    })

    for (const action of ['Accept', 'Decline']) {
      it(`does not retry a blocked ringtone when pressing ${action}`, () => {
        const peer = `user2@${jidDomain}/Conversations`
        cy.window().then(win => {
          cy.stub(win.HTMLMediaElement.prototype, 'play')
            .rejects(new win.DOMException('User interaction required', 'NotAllowedError')).as('playTone')
          sendProposal(peer, `blocked-tone-${action.toLowerCase()}`)
        })
        cy.get('@playTone').should('have.been.calledOnce')
        cy.contains(`${callPanel} button`, action).trigger('keydown', { key: 'Enter' }).click()
        cy.get(`${callPanel} audio[loop]`).should('not.exist')
        cy.get('@playTone').should('have.been.calledOnce')
        if (action === 'Accept') cy.contains(`${callPanel} button`, 'Hang up').click()
        cy.contains(`${callPanel} button`, 'Dismiss').click()
      })
    }

    it('ignores unsolicited proposals and retracts proposals from the open direct chat', () => {
      const contact = `user2@${jidDomain}/Conversations`
      const visitor = `visitor@${jidDomain}`
      const peer = `${visitor}/Conversations`
      cy.then(() => {
        sendProposal(peer, 'unsolicited')
        sendProposal(contact, 'roster-retract')
      })
      cy.get(callPanel).should('contain', `user2@${jidDomain}`)
      cy.then(() => sendRetract(contact, 'roster-retract'))
      cy.contains(`${callPanel} button`, 'Dismiss').click()
      cy.get(callPanel).should('not.exist')

      cy.window().then(win => { win.location.hash = `#/contacts/${encodeURIComponent(visitor)}` })
      cy.hash().should('contain', '/contacts/visitor')
      cy.get('.navbar-brand > span.navbar-item').should('have.text', visitor)
      cy.then(() => sendProposal(peer, 'open-contact'))
      cy.get(callPanel).should('contain', 'Incoming audio call').and('contain', visitor)
      cy.then(() => sendRetract(peer, 'open-contact'))
      cy.contains(`${callPanel} button`, 'Dismiss').click()
      cy.get(callPanel).should('not.exist')
    })
  })

  describe('Reactions', function () {
    before(() => {
      cy.clearAllCookies()
        .clearAllLocalStorage()
        .clearAllSessionStorage()
        .visit('/', {
          onBeforeLoad,
        })
        .get('input[name="jid"]').clear().type('myuser')
        .get('input[name="password"]').type('pwd')
        .get('input[type="checkbox"]').check()
        .get('button[type="submit"]').click()
    })
    it('display reactions', () => {
      cy.get('#contactsList li').first().click()
      const msg = 'Hello, can you react?'
      const id = 'C9Sojvuc_FSF-pTIN4QYz'
      mockServer.emit('message', `<message type="chat" to="${jidLocal}@${jidDomain}" from="user2@${jidDomain}/dummyClient" id="${id}" xmlns="jabber:client"><body>${msg}</body><active xmlns="http://jabber.org/protocol/chatstates"/><origin-id xmlns="urn:xmpp:sid:0" id="C9Sojvuc_FSF-pTIN4QYz"/></message>`)
      mockServer.emit('message', `<message type='chat' to='${jidLocal}@${jidDomain}' from="user2@${jidDomain}/dummyClient" id='dd67d774-b472-4f64-91b5-23e728a509b2' xml:lang='en' xmlns='jabber:client'><origin-id id='dd67d774-b472-4f64-91b5-23e728a509b2' xmlns='urn:xmpp:sid:0'/><reactions id='${id}' xmlns='urn:xmpp:reactions:0'><reaction>👍</reaction></reactions><store xmlns='urn:xmpp:hints'/><stanza-id id='019c9a33-3076-7843-bc4e-285b3e602d4d' xmlns='urn:xmpp:sid:0' by='user2@${jidDomain}'/></message>`)
      cy.get('#messages-container button[data-emoji]').should('contain', '👍')
    })
    it('update reactions', () => {
      const id = 'C9Sojvuc_FSF-pTIN4QYz'
      mockServer.emit('message', `<message type='chat' to='${jidLocal}@${jidDomain}' from="user2@${jidDomain}/dummyClient" id='dd67d774-b472-4f64-91b5-23e728a509b3' xml:lang='en' xmlns='jabber:client'><origin-id id='dd67d774-b472-4f64-91b5-23e728a509b3' xmlns='urn:xmpp:sid:0'/><reactions id='${id}' xmlns='urn:xmpp:reactions:0'></reactions><store xmlns='urn:xmpp:hints'/><stanza-id id='019c9a33-3076-7843-bc4e-285b3e602d4e' xmlns='urn:xmpp:sid:0' by='user2@${jidDomain}'/></message>`)
      cy.get('#messages-container').should('not.contain', '👍')
    })
    it('can add reaction', () => {
      cy.get('.messages-container .message-text').realHover()
        .get('.messages-container button[title="Add reaction"]').click()
        .get('.messages-container .emojiPicker a[title="hundred points"]').click()
        .get('#messages-container button[data-emoji]').should('contain', '💯 1')
    })
    it('can add reaction only once', () => {
      cy.get('.messages-container button[title="Add reaction"]').click()
        .get('.messages-container .emojiPicker a[title="hundred points"]').click()
        .get('#messages-container button[data-emoji]').should('contain', '💯 1')
    })
    it('toggle reactions', () => {
      const id = 'C9Sojvuc_FSF-pTIN4QYz'
      mockServer.emit('message', `<message type='chat' to='${jidLocal}@${jidDomain}' from="user2@${jidDomain}/dummyClient" id='dd67d774-b472-4f64-91b5-23e728a509b3' xml:lang='en' xmlns='jabber:client'><origin-id id='dd67d774-b472-4f64-91b5-23e728a509b3' xmlns='urn:xmpp:sid:0'/><reactions id='${id}' xmlns='urn:xmpp:reactions:0'><reaction>👍</reaction></reactions><store xmlns='urn:xmpp:hints'/><stanza-id id='019c9a33-3076-7843-bc4e-285b3e602d4e' xmlns='urn:xmpp:sid:0' by='user2@${jidDomain}'/></message>`)
      cy.get('#messages-container button[data-emoji]').should('contain', '👍 1')
        .get('.messages-container button[data-emoji="👍"]').click()
        .get('#messages-container button[data-emoji]').should('contain', '👍 2')
        .get('.messages-container button[data-emoji="👍"]').click()
        .get('#messages-container button[data-emoji]').should('contain', '👍 1')
    })
  })

  describe('Rooms', function () {
    it('displays bookmarked rooms and a link to public rooms', () => {
      cy.get('#roomsList li').should('have.length', 5)
        .get('#roomsList li').first().should('have.text', 'welcome')
        .next().should('have.text', 'public')
        .next().should('have.text', 'Public rooms')
        .click()
        .hash().should('eq', '#/rooms/discover')
        .get('main table tbody tr').should('have.length', 2)
        .first().as('firstRoom').find('td').first().next().should('have.text', 'welcome')
        .next().should('have.text', '1')
        .next().next().next().should('have.descendants', 'i')
    })
    it('can join room', () => {
      cy.get('#roomsList li').first().click()
        .hash().should('eq', `#/rooms/welcome@conference.${jidDomain}`)
    })
    it('display received message on active room', () => {
      const msg = 'Hello room, do you copy?'
      mockServer.emit('message', `<message type="groupchat" to="${jidLocal}@${jidDomain}" from="welcome@conference.${jidDomain}/user2" id="C9Sojvuc" xmlns="jabber:client"><body>${msg}</body><active xmlns="http://jabber.org/protocol/chatstates"/><origin-id xmlns="urn:xmpp:sid:0" id="C9Sojvuc"/><stanza-id by='welcome@conference.${jidDomain}' id='PZBaESdTD4BUkPz2' xmlns='urn:xmpp:sid:0'/></message>`)
      cy.get('#messages-container').should('contain', msg)
    })
    it('display and toggle reactions', () => {
      const id = 'PZBaESdTD4BUkPz2'
      mockServer.emit('message', `<message type='groupchat' to='${jidLocal}@${jidDomain}' from="welcome@conference.${jidDomain}/user2" id='dd67d774-b472-4f64-91b5-23e728a509b3' xml:lang='en' xmlns='jabber:client'><origin-id id='dd67d774-b472-4f64-91b5-23e728a509b3' xmlns='urn:xmpp:sid:0'/><reactions id='${id}' xmlns='urn:xmpp:reactions:0'><reaction>👍</reaction></reactions><store xmlns='urn:xmpp:hints'/><stanza-id id='019c9a33-3076-7843-bc4e-285b3e602d4e' xmlns='urn:xmpp:sid:0' by='welcome@conference.${jidDomain}'/></message>`)
      cy.get('#messages-container button[data-emoji]').should('contain', '👍 1')
        .get('.messages-container button[data-emoji="👍"]').click()
        .get('#messages-container button[data-emoji="👍"]').should('contain', '👍 2')
        .get('.messages-container button[data-emoji="👍"]').click()
        .get('#messages-container button[data-emoji="👍"]').should('contain', '👍 1')
    })
    it('display unread count on received message on inactive room', () => {
      const msg = 'Hello other room, read this later'
      mockServer.emit('message', `<message type="groupchat" to="${jidLocal}@${jidDomain}" from="public@anon-conference.${jidDomain}/user2" id="TIN4QYz" xmlns="jabber:client"><body>${msg}</body><active xmlns="http://jabber.org/protocol/chatstates"/><origin-id xmlns="urn:xmpp:sid:0" id="TIN4QYz"/><stanza-id by='welcome@conference.${jidDomain}' id='PZBaESdTD4BUkPz3' xmlns='urn:xmpp:sid:0'/></message>`)
      cy.get('#messages-container').should('not.contain', msg)
        .get('#roomsList li').first().next().find('a .tag').should('have.text', '1')
    })
    it('can create room', () => {
      cy.get('#roomsList li').first().next().next().next().next().click()
        .hash().should('eq', '#/rooms/new')
        .get('main input[title="Enter room Jid"]').as('roomName').should('exist')
        .get('main button[type="submit"]').should('be.disabled')
        .get('@roomName').type(`newRoom@conference.@${jidDomain}`)
        .get('main button[type="submit"]').should('be.enabled')
    })
  })

  describe('About', function () {
    it('display application information', () => {
      cy.get('#navbar-burger').click()
        .get('#navbar-menu a[href="#/about"]').click()
        .get('#navbar-burger').click()
        .hash().should('eq', '#/about')
        .get('main .tags .tag:nth-child(2)').should('contain', version)
    })
  })

  describe('Logout', function () {
    it('logout from the server and return to login page', () => {
      cy.get('#navbar-burger').click()
        .get('#logout').click()
        .hash().should('eq', '#/login')
    })
  })
})
