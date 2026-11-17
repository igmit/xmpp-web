<template>
  <section v-if="call" class="call-panel box has-background-shade-2 p-4" aria-label="Call controls">
    <incoming-ringtone v-if="call.phase === 'incoming' && callRingtoneEnabled" />
    <p class="has-text-weight-semibold">{{ status }}</p>
    <p class="call-peer mb-3" :title="call.peer">{{ peer }}</p>
    <p v-if="call.error" class="has-text-danger-light mb-3" role="alert">{{ call.error }}</p>

    <div v-if="call.phase !== 'ended' && (call.localStream || call.remoteStream)" class="call-media">
      <video v-if="call.video && call.remoteStream" ref="remoteMedia" class="remote-video" :srcObject.prop="call.remoteStream" autoplay playsinline aria-label="Remote video" @loadedmetadata="playRemoteMedia" @play="playbackBlocked = false" />
      <audio v-else-if="call.remoteStream" ref="remoteMedia" :srcObject.prop="call.remoteStream" autoplay aria-label="Call audio" @loadedmetadata="playRemoteMedia" @play="playbackBlocked = false" />
      <video v-if="call.video && call.localStream" class="local-video" :srcObject.prop="call.localStream" autoplay playsinline :muted="true" aria-label="Your camera preview" />
    </div>

    <microphone-recovery v-if="call.phase !== 'ended' && call.microphoneStatus" :call="call" />
    <div class="buttons mb-0">
      <button v-if="call.remoteStream && playbackBlocked" type="button" class="button" @click="playRemoteMedia">Play call media</button>
      <button v-if="call.phase === 'incoming'" type="button" class="button is-primary" @click="$xmpp.acceptCall()">Accept</button>
      <button v-if="call.phase === 'ended'" type="button" class="button" @click="$xmpp.dismissCall()">Dismiss</button>
      <button v-else type="button" class="button is-danger" @click="$xmpp.endCall()">{{ endLabel }}</button>
    </div>
  </section>
  <p class="is-sr-only" role="status">{{ call ? `${status}. ${peer}` : '' }}</p>
</template>

<script>
import { defineAsyncComponent } from 'vue'
import { mapState } from 'pinia'
import { useStore } from '@/store'
import IncomingRingtone from './IncomingRingtone.vue'

export default {
  name: 'CallPanel',
  components: {
    IncomingRingtone,
    MicrophoneRecovery: defineAsyncComponent(() => import('./MicrophoneRecovery.vue')),
  },
  data () {
    return {
      playbackBlocked: false,
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
        case 'outgoing': return `Starting ${type} call…`
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
  },
  watch: {
    remoteStream () {
      this.playbackBlocked = false
    },
  },
  methods: {
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
  position: fixed;
  top: 6.5rem;
  right: 1rem;
  z-index: 10;
  width: min(23rem, calc(100% - 2rem));
  max-height: calc(100% - 7.5rem);
  overflow: auto;
}

.call-peer {
  overflow-wrap: anywhere;
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
