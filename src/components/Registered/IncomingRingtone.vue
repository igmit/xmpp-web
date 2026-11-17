<template>
  <audio ref="tone" loop aria-hidden="true">
    <source src="../../assets/incoming-call.mp3" type="audio/mpeg">
  </audio>
</template>

<script>
export default {
  name: 'IncomingRingtone',
  mounted () {
    this.play()
  },
  beforeUnmount () {
    this.removeListeners()
    this.$refs.tone.pause()
  },
  methods: {
    async play () {
      const tone = this.$refs.tone
      try {
        await tone.play()
        this.removeListeners()
      } catch (error) {
        if (error.name === 'NotAllowedError' && this.$refs.tone === tone) {
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
