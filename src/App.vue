<script setup lang="ts">
import { onMounted } from 'vue'
import LoginView from './components/LoginView.vue'
import { useAuthSession } from './features/auth/useAuthSession'
import WorkbenchView from './WorkbenchView.vue'

const auth = useAuthSession()

onMounted(auth.initialize)
</script>

<template>
  <div v-if="auth.loading.value && !auth.initialized.value" class="auth-loading" aria-live="polite">
    正在验证访问权限…
  </div>
  <WorkbenchView v-else-if="auth.authenticated.value" @logout="auth.logout" />
  <LoginView
    v-else
    :loading="auth.loading.value"
    :error="auth.error.value"
    @submit="auth.login"
  />
</template>

<style>
.auth-loading{display:grid;min-height:100vh;place-items:center;color:#68758a;font:14px Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:#eef1f5}
</style>
