<template>
  <div class="mb-3">
    <p class="mb-2" role="status">{{ message }}</p>
    <label v-if="inputs.length" class="is-block mb-2">
      Microphone
      <span class="select is-small is-fullwidth">
        <select v-model="selected" :disabled="busy">
          <option value="">Browser default</option>
          <option v-for="(input, index) in inputs" :key="input.deviceId" :value="input.deviceId">{{ input.label || 'Microphone ' + (index + 1) }}</option>
        </select>
      </span>
    </label>
    <button type="button" class="button" :disabled="busy" @click="$xmpp.reconnectMicrophone(selected)">Reconnect microphone</button>
  </div>
</template>

<script>
export default {
  name: 'MicrophoneRecovery',
  props: {
    call: { type: Object, required: true },
  },
  data () {
    return { inputs: [], selected: '' }
  },
  computed: {
    busy () { return this.call.microphoneStatus === 'reconnecting' },
    message () {
      if (this.busy) return 'Reconnecting microphone…'
      return this.call.microphoneError || 'Your microphone stopped. The other person cannot hear you.'
    },
  },
  mounted () {
    this.loadInputs()
    navigator.mediaDevices.addEventListener('devicechange', this.loadInputs)
  },
  beforeUnmount () {
    navigator.mediaDevices.removeEventListener('devicechange', this.loadInputs)
  },
  methods: {
    async loadInputs () {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        this.inputs = devices.filter(device => device.kind === 'audioinput' && device.deviceId)
        if (!this.inputs.some(device => device.deviceId === this.selected)) this.selected = ''
      } catch {
        // The browser can still reopen its default input without listing devices.
      }
    },
  },
}
</script>
