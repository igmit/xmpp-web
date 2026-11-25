<template>
  <section v-if="call" class="call-panel box has-background-shade-2 p-4" :class="{ 'call-panel-home': $route.name === 'home' }" aria-label="Call controls">
    <incoming-ringtone v-if="call.phase === 'incoming' && callRingtoneEnabled" ref="ringtone" />
    <p class="has-text-weight-semibold">{{ status }}</p>
    <p class="call-peer mb-3" :title="call.peer">{{ peer }}</p>
    <p v-if="call.error" class="has-text-danger-light mb-3" role="alert">{{ call.error }}</p>

    <div v-if="call.phase !== 'ended' && (call.localStream || call.remoteStream)" class="call-media">
      <video v-if="call.video && call.remoteStream" ref="remoteMedia" class="remote-video" :srcObject.prop="call.remoteStream" :muted.prop="soundMuted" autoplay playsinline aria-label="Remote video" @loadedmetadata="playRemoteMedia" @play="playbackBlocked = false" />
      <audio v-else-if="call.remoteStream" ref="remoteMedia" :srcObject.prop="call.remoteStream" :muted.prop="soundMuted" autoplay aria-label="Call audio" @loadedmetadata="playRemoteMedia" @play="playbackBlocked = false" />
      <video v-if="call.video && call.localStream && !call.cameraOff" class="local-video" :srcObject.prop="call.localStream" autoplay playsinline :muted="true" aria-label="Your camera preview" />
    </div>

    <p v-if="call.phase !== 'ended' && call.microphoneStatus === 'muted'" class="mb-3" role="status">Your microphone is temporarily interrupted. The other person cannot hear you.</p>
    <microphone-recovery v-else-if="call.phase !== 'ended' && call.microphoneStatus" :call="call" />
    <div class="buttons mb-0">
      <button v-if="call.remoteStream && playbackBlocked" type="button" class="button" @click="playRemoteMedia">Play call media</button>
      <button v-if="call.phase === 'incoming'" type="button" class="button is-primary" @keydown.stop @click="acceptCall">
        <span class="icon call-icon accept-icon" aria-hidden="true" />
        <span>Accept</span>
      </button>
      <template v-if="showMediaControls">
        <button
          type="button"
          class="button"
          :class="{ 'is-warning': call.microphoneMuted }"
          :disabled="!call.localStream || call.microphoneStatus === 'unavailable' || call.microphoneStatus === 'reconnecting'"
          aria-label="Mute mic"
          :aria-pressed="call.microphoneMuted"
          :title="call.microphoneMuted ? 'Unmute mic' : 'Mute mic'"
          @keydown.stop
          @click="$xmpp.setMicrophoneMuted(!call.microphoneMuted)"
        >
          <span class="icon call-icon mic-icon" aria-hidden="true" />
        </button>
        <button
          type="button"
          class="button"
          :class="{ 'is-warning': soundMuted }"
          aria-label="Mute sound"
          :aria-pressed="soundMuted"
          :title="soundMuted ? 'Unmute sound' : 'Mute sound'"
          @keydown.stop
          @click="soundMuted = !soundMuted"
        >
          <span class="icon call-icon sound-icon" aria-hidden="true" />
        </button>
        <button
          v-if="call.video"
          type="button"
          class="button"
          :class="{ 'is-warning': call.cameraOff }"
          :disabled="!call.localStream?.getVideoTracks().some(track => track.readyState === 'live')"
          aria-label="Turn off camera"
          :aria-pressed="call.cameraOff"
          :title="call.cameraOff ? 'Turn on camera' : 'Turn off camera'"
          @keydown.stop
          @click="$xmpp.setCameraOff(!call.cameraOff)"
        >
          <span class="icon call-icon camera-icon" aria-hidden="true" />
        </button>
      </template>
      <template v-if="call.phase === 'ended'">
        <button type="button" class="button" @click="$xmpp.dismissCall()">Dismiss</button>
        <span class="is-size-7 has-text-grey-light mb-2">Closing in {{ dismissSeconds }}s</span>
      </template>
      <button v-else type="button" class="button is-danger" :class="{ 'ml-auto': showMediaControls }" @keydown.stop @click="endCall">
        <span class="icon call-icon" :class="showMediaControls ? 'hang-up-icon' : 'end-call-icon'" aria-hidden="true" />
        <span>{{ endLabel }}</span>
      </button>
    </div>
  </section>
  <p class="is-sr-only" role="status">{{ call ? `${status}. ${peer}` : '' }}</p>
</template>

<script>
import { defineAsyncComponent } from 'vue'
import { mapState } from 'pinia'
import { useStore } from '@/store'
import IncomingRingtone from './IncomingRingtone.vue'

const DISMISS_SECONDS = 5

export default {
  name: 'CallPanel',
  components: {
    IncomingRingtone,
    MicrophoneRecovery: defineAsyncComponent(() => import('./MicrophoneRecovery.vue')),
  },
  data () {
    return {
      playbackBlocked: false,
      soundMuted: false,
      dismissSeconds: DISMISS_SECONDS,
      dismissTimer: null,
    }
  },
  computed: {
    ...mapState(useStore, ['call', 'callRingtoneEnabled']),
    peer () {
      return this.call.peer.split('/')[0]
    },
    status () {
      const type = this.call.video ? 'video' : 'audio'
      switch (this.call.phase) {
        case 'incoming': return `Incoming ${type} call`
        case 'outgoing': return this.call.ringing ? `Ringing ${type} call…` : `Starting ${type} call…`
        case 'connecting': return `Connecting ${type} call…`
        case 'active': return this.call.video ? 'Video call in progress' : 'Audio call in progress'
        default: return 'Call ended'
      }
    },
    endLabel () {
      if (this.call.phase === 'incoming') {
        return 'Decline'
      }
      if (this.call.phase === 'outgoing') {
        return 'Cancel call'
      }
      return 'Hang up'
    },
    remoteStream () {
      return this.call?.remoteStream
    },
    showMediaControls () {
      return this.call?.phase === 'connecting' || this.call?.phase === 'active'
    },
  },
  watch: {
    call: {
      immediate: true,
      handler (call) {
        clearInterval(this.dismissTimer)
        if (call?.phase !== 'ended') return

        const deadline = Date.now() + DISMISS_SECONDS * 1000
        this.dismissSeconds = DISMISS_SECONDS
        this.dismissTimer = setInterval(() => {
          if (this.call !== call) return
          this.dismissSeconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
          if (!this.dismissSeconds) this.$xmpp.dismissCall()
        }, 1000)
      },
    },
    remoteStream () {
      this.playbackBlocked = false
    },
    showMediaControls (visible) {
      if (!visible) this.soundMuted = false
    },
  },
  beforeUnmount () {
    clearInterval(this.dismissTimer)
  },
  methods: {
    acceptCall () {
      this.$refs.ringtone?.stop()
      return this.$xmpp.acceptCall()
    },
    endCall () {
      this.$refs.ringtone?.stop()
      return this.$xmpp.endCall()
    },
    async playRemoteMedia () {
      const media = this.$refs.remoteMedia
      const stream = this.remoteStream
      try {
        await media.play()
      } catch {
        if (this.remoteStream === stream && this.$refs.remoteMedia === media) {
          this.playbackBlocked = true
        }
      }
    },
  },
}
</script>

<style scoped>
.call-panel {
  --call-panel-top: 6.5rem;
  position: fixed;
  top: var(--call-panel-top);
  right: 1rem;
  z-index: 10;
  width: min(23rem, calc(100% - 2rem));
  max-height: calc(100% - var(--call-panel-top) - 1rem);
  overflow: auto;
}

.call-panel-home {
  --call-panel-top: 4.25rem;
}

.call-peer {
  overflow-wrap: anywhere;
}

.button[aria-pressed="false"]:is(:focus, :active) {
  color: inherit;
}

.call-icon {
  background-color: currentColor;
  mask: var(--call-icon) center / 1em 1em no-repeat;
}

.mic-icon {
  --call-icon: url('@fortawesome/fontawesome-free/svgs/solid/microphone.svg');
}

[aria-pressed="true"] .mic-icon {
  --call-icon: url('@fortawesome/fontawesome-free/svgs/solid/microphone-slash.svg');
}

.sound-icon {
  --call-icon: url('@fortawesome/fontawesome-free/svgs/solid/volume-high.svg');
}

[aria-pressed="true"] .sound-icon {
  --call-icon: url('@fortawesome/fontawesome-free/svgs/solid/volume-xmark.svg');
}

.camera-icon {
  --call-icon: url('@fortawesome/fontawesome-free/svgs/solid/video.svg');
}

[aria-pressed="true"] .camera-icon {
  --call-icon: url('@fortawesome/fontawesome-free/svgs/solid/video-slash.svg');
}

.accept-icon,
.hang-up-icon {
  --call-icon: url('@fortawesome/fontawesome-free/svgs/solid/phone.svg');
}

.hang-up-icon {
  transform: rotate(135deg);
}

.end-call-icon {
  --call-icon: url('@fortawesome/fontawesome-free/svgs/solid/phone-slash.svg');
}

.call-media {
  position: relative;
}

.remote-video,
.local-video {
  display: block;
  max-height: 35vh;
  width: 100%;
  background: black;
  border-radius: 4px;
  margin-bottom: 0.75rem;
}

.remote-video ~ .local-video {
  position: absolute;
  bottom: 0.5rem;
  right: 0.5rem;
  width: 30%;
  margin-bottom: 0;
}
</style>
