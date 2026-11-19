<template>
  <audio ref="tone" loop aria-hidden="true">
    <source src="../../assets/incoming-call.mp3" type="audio/mpeg">
  </audio>
</template>

<script>
export default {
  name: 'IncomingRingtone',
  data () {
    return { stopped: false }
  },
  mounted () {
    this.play()
  },
  beforeUnmount () {
    this.stop()
  },
  methods: {
    stop () {
      if (this.stopped) return
      this.stopped = true
      this.removeListeners()
      this.$refs.tone.pause()
    },
    async play () {
      if (this.stopped) return
      const tone = this.$refs.tone
      try {
        await tone.play()
        this.removeListeners()
      } catch (error) {
        if (error.name === 'NotAllowedError' && !this.stopped) {
          // Retry within the next user gesture if the browser blocked autoplay.
          document.addEventListener('click', this.play)
          document.addEventListener('keydown', this.play)
        }
      }
    },
    removeListeners () {
      document.removeEventListener('click', this.play)
      document.removeEventListener('keydown', this.play)
    },
  },
}
</script>
