# Jingle calls: pre-PR review and follow-up tasks

Branch: `feat/jingle-calls` (commits `a6c3176`..`bc5b4d5`) against `master`.
Scope reviewed: `src/services/jingle*.js`, `src/services/JingleCall.js`, `src/services/registerJingleCalls.js`, `src/services/XmppClient.js`, `src/services/XmppSocket.js`, the call UI components and the tests.

## Summary

- The design is sound and follows the Jingle standards: namespaces, DTLS roles, error conditions and the IQ ordering are correct.
- The 31 unit tests pass (`node --test tests/*.test.js`).
- A Chrome-style audio SDP survives a full SDP → Jingle → SDP round trip through `jingleMedia.js`. Opus, fmtp parameters, rtcp-fb, header extensions, SSRC/msid and candidates are all preserved.
- The reported "microphone drops on a real device" is **more likely caused by call teardown on XMPP reconnects** (section 1a) than by codecs.
- Section 1 lists the issues in priority order. Section 6 is the task list for agents.

Line numbers refer to commit `bc5b4d5`.

---

## 1. Probable causes of the mic drop on real devices

### 1a. Calls across an XMPP reconnect (high)

- RTP media does not depend on the XMPP websocket once ICE has connected.
- On phones the websocket drops often: backgrounded tab, screen lock, Wi‑Fi ↔ mobile data handoff, Chrome throttling.
- The call now has a 30 s signaling grace period during setup and active media. Ringing and setup keep their own deadlines.
- If the local user hangs up or either deadline expires while offline, the controller closes the media and holds the teardown signal for up to 60 s. It sends the signal when the same full JID reconnects. A resource change or logout clears the held signal.

### 1b. Mic loss detection only checks `readyState === 'ended'` (high)

`src/services/JingleCall.js:295` polls `track.readyState` every second.

- Mobile OS interruptions usually set `track.muted = true` and fire `mute`/`unmute` instead of `ended`. Examples: a GSM call, Siri or the assistant, another app taking audio focus, a Bluetooth route change.
- In that case the recovery UI never appears, and the peer hears silence.
- Listen to `mute`/`unmute`/`ended` on the audio track, and show a state for "muted by the system" as well as "ended".

### 1c. No ICE restart (medium-high)

- `JingleCall.js:349`: a `connectionState` of `disconnected` ends the call after `RECOVERY_TIMEOUT` (10 s).
- Changing networks on a phone needs an ICE restart. Conversations restarts ICE by sending `transport-info` with a new `ufrag`/`pwd`.
- `receiveCandidates` ignores browser rejections of individual candidates in a valid batch. It still needs to apply new ICE credentials to support a peer-initiated restart.
- The client never starts an ICE restart itself.

---

## 2. Codec questions

Codecs are unlikely to *stop* the mic. They can cause one-way audio, choppy audio or a rejected offer.

| Item | Status | Action |
|---|---|---|
| Opus `48000/2`, `minptime=10;useinbandfec=1`, `transport-cc` | Round-trips correctly | None |
| RED (`audio/red`, fmtp `111/111`) | Sent as `<parameter name="" value="111/111"/>`. XEP-0167 requires `name` | Compare with what Conversations/Dino send for RED; otherwise remove RED from the offer (`RTCRtpTransceiver.setCodecPreferences`) |
| `a=rtcp-rsize` | Dropped (no Jingle mapping) | Harmless; just document it |
| `ptime`/`maxptime` | Media-level value copied onto every payload-type | Fine |
| DTX (`usedtx=1`) | Not offered by Chrome by default | If a peer offers it, silent stretches can sound like drops. Check captured fmtp |
| mDNS host candidates (`xxx.local`) | Sent as-is | Android libwebrtc (Conversations) may not resolve them. With the default `iceServers: []` and no XEP-0215, browser ↔ phone calls on one LAN may fail |

### How to tell "mic", "send path" and "network" apart

Use `chrome://webrtc-internals` (on Android, through `chrome://inspect` remote debugging) or `about:webrtc` in Firefox.

- **The mic captures silence:** the `media-source` `audioLevel` is ≈ 0, or the track is `muted`.
- **Packets do not leave:** `outbound-rtp` `packetsSent` stops increasing.
- **Network or ICE:** the remote `inbound-rtp` `packetsReceived` stalls, or the ICE/connection state changes.
- **Receive side:** check `concealedSamples` and `jitterBufferDelay` on `inbound-rtp`.

---

## 3. Jingle standards conformance

### Correct

- Namespaces for XEP-0166, 0167, 0176, 0320, 0338, 0339, 0293, 0294, 0353, 0215 and 0115.
- DTLS setup rules (XEP-0320): `actpass` from the initiator, `active`/`passive` from the responder. The fingerprint length and format are validated.
- `rtcp-mux` is required. This matches the WebRTC `rtcpMuxPolicy: require` default.
- The IQ result is sent before any follow-up IQ (`later()`).
- Error conditions: `item-not-found` + `unknown-session`, `unexpected-request` + `out-of-order`, `conflict` + `tie-break`, `feature-not-implemented` + `unsupported-info`.
- An empty `session-info` (ping) gets a result. `ringing` and `active` are accepted.
- Remote candidates are queued until the remote description is set (max 256).
- The XEP-0115 verification string format and the SHA-1 hash are correct.
- XEP-0353 handling covers `propose`, `ringing`, `proceed`, `retract`, `reject` and `finish`, including carbons, receipts and MAM/delay filtering.

### Gaps

1. **Outgoing calls do not send XEP-0353 `propose`.** `start()` sends `session-initiate` directly to the single resource with the highest presence priority (`store.callTarget`).
   - A phone in push-only mode (Conversations in the background, no live resource) will not ring.
   - Only one device rings.
   - The README documents this as intentional, but it is the largest interop gap.
2. **Accepting a JMI invitation sends only `proceed` to the caller** (`JingleCall.js:405`). XEP-0353 also expects an `accept` sent to your own bare JID, so your other devices stop ringing. Today this depends on the carbon copy of `proceed`.
3. **A user decline sends the JMI `reject` default of `busy`.** This also avoids disclosing whether the user actively declined. Direct Jingle termination carries `decline`.
4. **No outgoing trickle ICE.** The client waits up to 15 s (`ICE_GATHERING_TIMEOUT`) for all candidates and never sends `transport-info`.
   - This is allowed, but call setup is slow when a STUN/TURN server is unreachable.
   - Candidates gathered after the timeout are lost.
5. **`content-add`, `content-modify`, `description-info` and `transport-replace` get `feature-not-implemented`.** Conversations' "switch to video" uses `content-add`. Check the UX on both sides.
6. **Reason parsing in `session-terminate`** (`JingleCall.js:562`) uses the first child element of `<reason>`. If `<text>` comes first, the result is `general-error`. `jingleMessages.js` already skips `<text>`; do the same here.
7. **XEP-0215 services with `restricted="1"`** that need a separate `<credentials/>` request are dropped silently because they have no username/password (`iceServersFromServices`). The result is no TURN and a "may require a TURN relay" error. Check what the target Prosody/ejabberd setup returns.
8. **Tie-break direction:** the code lets the lower `sid` win. Check this against XEP-0166 (simultaneous session-initiate) and against Conversations' implementation.
9. **TCP candidates are filtered out in both directions.** That is correct for ICE-UDP. TURN over TCP/TLS still produces UDP relay candidates, so this is fine. Just confirm it with a TURNS-only server.

---

## 4. `XmppClient.js` / `XmppSocket.js` refactor

### Good

- The module-level `xmppClient` singleton was removed. Every `xmppClient.` reference is now `this.`, with no leftovers (grep is clean).
- `parseStanza` is bound with an arrow function.
- `discoInfoCache` is a per-instance `Map` instead of a global object shared across logins.
- `XmppSocket.create()` now awaits `disconnect()` before creating a new client.
- Guard on the carbon payload (`?.getChild('message')`).
- `disconnect()` returns the `stop()` promise.

### To verify

1. **Disco#info responder (`XmppClient.js:97`).**
   - It advertises only call-related features. Before this branch the client did not answer disco#info at all.
   - With explicit caps, peers may decide this resource lacks features the app already supports, such as chat states (XEP-0085), reactions (XEP-0444) and receipts.
   - Either add those features or confirm that peers behave the same.
   - Guest and anonymous sessions do not register the responder. That is intended.
2. **Duplicate initial presence:** both the new `online` handler (`XmppSocket.js:156`) and the existing flow (`XmppSocket.js:180`) send presence. Check the debug log on first login.
3. **Logout window:** `disconnect()` sets `this.client = null` before awaiting `client.disconnect()`. Make sure no UI path uses `$xmpp.client` during logout.
4. **`handleInvitation` runs before normal message parsing.** A JMI message that also carries a fallback `<body>` would never appear in the chat. Confirm whether Conversations, Dino or Monal send one.
5. **`getIceServers()`** adds a 5 s timeout to call setup when the server does not answer XEP-0215. This is acceptable, but test it against a server without extdisco.

---

## 5. Minor UI notes

- **`IncomingRingtone.vue`:** when autoplay was blocked, a document `click` listener retries `play()`. Clicking **Accept** fires that listener before the component unmounts, so the ringtone may briefly start. On iOS, starting media playback while capture starts can affect the audio session.
- **`MicrophoneRecovery.vue`** appears only for `microphoneStatus` (the `ended` case). See 1b.

---

## 6. Tasks for AI agents

Rules for every task:

- Work on `feat/jingle-calls`. Do not push or open a PR unless the user asks.
- Keep each fix small and separate, one commit per task, using the `fix(calls): ...` or `test(calls): ...` style.
- Before you finish, run `pnpm run lint` and `pnpm run test:unit`. Run Cypress (`pnpm run test:preview`) when you touch UI or media code.
- Do not weaken the existing input validation in `jingleMedia.js` and `jingleMessages.js`. It protects against malformed remote stanzas.
- When a task says "verify", report findings with evidence: stanza captures, `webrtc-internals` excerpts, spec section. Do not change code on a guess.
- When a fix depends on interop behavior (Conversations, Dino), capture real stanzas first and keep them as test fixtures under `tests/fixtures/`. Strip JIDs and credentials.

### P0: mic drop investigation and fixes

- [x] **T1 – Keep calls alive across XMPP reconnects** (section 1a). Unit coverage includes resume during call setup and active media, grace period expiry, and teardown after offline hangup.
- [ ] **T2 – Detect muted tracks** (section 1b)
  - Change: listen to `mute`/`unmute`/`ended` on the local audio track. Expose a distinct status (for example `muted`) and show it in `CallPanel`/`MicrophoneRecovery`.
  - Tests: unit test using a fake track that fires `mute` and then `unmute`.
- [ ] **T3 – Support ICE restart** (section 1c)
  - Change: handle incoming `transport-info` that carries a new `ufrag`/`pwd` by renegotiating with an updated remote description. Optionally start a restart on `disconnected` before giving up.
  - Verify first: capture Conversations' ICE restart stanzas.
  - Tests: unit test using the captured fixture.
- [ ] **T4 – Device reproduction (manual, needs a human with devices).** Agents should prepare a checklist and log capture instructions. Scenarios:
  - lock the screen for 1–2 min
  - switch apps
  - take a GSM call
  - connect/disconnect a Bluetooth headset
  - Wi‑Fi ↔ LTE handoff
  - leave the Android Chrome tab in the background for more than 5 min

  For each scenario, record the XMPP status events, `track.readyState`/`muted`, and a `webrtc-internals` dump. If the drops line up with `disconnect` events, T1 is confirmed as the cause.

### P1: interop and standards

- [ ] **T5 – Fix the RED parameter format** (section 2). Capture Conversations' and Dino's RED encoding. Either match it, or remove RED from the offer with `setCodecPreferences`. Add a round-trip test.
- [ ] **T6 – Send `accept` to own bare JID on JMI accept** (gap 2). Test with two devices on the same account: the second device stops ringing.
- [x] **T7 – Document the JMI user-decline reason** (gap 3). Keep `busy` for the JMI `reject` and `decline` for direct Jingle termination.
- [ ] **T8 – Skip `<text>` when reading the `session-terminate` reason** (gap 6). Add a unit test.
- [ ] **T9 – Verify the tie-break rule** (gap 8) against XEP-0166 and the Conversations source. Fix it only if it differs.
- [ ] **T10 – Disco features** (section 4.1). Add the features the client already supports, or document why not. Update the caps hash test if there is one.
- [ ] **T11 – Decide on outgoing JMI `propose`** (gap 1). This is a product decision; ask the user before implementing. If approved: send `propose` to the contact's bare JID, wait for `proceed`, then send `session-initiate` to the full JID that sent `proceed`.

### P2: robustness and polish

- [ ] **T12 – Send trickle ICE** (gap 4). Send `transport-info` from `onicecandidate`, and stop blocking on full gathering. Keep the non-trickle path as a fallback only if a tested peer needs it.
- [ ] **T13 – Answer `content-add` for video upgrade** (gap 5). At minimum, reply with `content-reject` instead of a generic error, and check the Conversations UX.
- [ ] **T14 – XEP-0215 restricted services** (gap 7). Request `<credentials/>` for `restricted="1"` services. Test against the target server.
- [ ] **T15 – Check presence and logout** (section 4.2–4.4). Look for duplicate initial presence, the `$xmpp.client` null window, and JMI messages with a body.
- [ ] **T16 – Stop the ringtone from restarting on the Accept click** (section 5).

### Test fixtures and matrix

- **Unit fixtures:** real SDP offers/answers from Chrome, Firefox and Safari, plus real Jingle `session-initiate`/`session-accept`/`transport-info` from Conversations and Dino. Test both conversion directions.
- **Cypress:** feed the captured Jingle into a real `RTCPeerConnection.setRemoteDescription` and assert that it succeeds.
- **Manual interop matrix (human):**
  - **Peers:** browser ↔ browser (Chrome, Firefox, Safari); browser ↔ Conversations, Dino, Monal, Gajim.
  - **Networks:** same LAN without STUN; different NATs with STUN only; mobile data or symmetric NAT (TURN required); TURN relay only.
  - **Flows:** JMI with several devices on one account; answer or decline on another device; caller cancels while ringing; both sides call at the same time; audio-only and video calls.
