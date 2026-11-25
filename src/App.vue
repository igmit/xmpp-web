<template>
  <div id="app" class="is-full-height">
    <router-view name="navbar" />
    <router-view />
    <call-panel v-if="$route.meta.requiresAuth && !$xmpp.isAnonymous" />
  </div>
</template>

<script>

import { defineAsyncComponent } from 'vue'
import { mapActions } from 'pinia'
import { useStore } from '@/store'

export default {
  name: 'App',
  components: {
    CallPanel: defineAsyncComponent(() => import('@/components/Registered/CallPanel.vue')),
  },
  mounted () {
    if (typeof window.config.name === 'string' && window.config.name !== '') {
      document.title = window.config.name
    }
    // handle network status
    this.setNetworkStatus(window.navigator.onLine)
    window.addEventListener('offline', this.notifyConnectivity)
    window.addEventListener('online', this.notifyConnectivity)
  },
  methods: {
    ...mapActions(useStore, ['setNetworkStatus']),
    notifyConnectivity (event) {
      this.setNetworkStatus(event.type === 'online')
    },
  },
}
</script>
