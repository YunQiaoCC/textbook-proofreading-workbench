<script setup lang="ts">
import { ref } from 'vue'

defineProps<{ loading: boolean; error: string }>()
const emit = defineEmits<{ submit: [username: string, password: string] }>()
const username = ref('proofreader')
const password = ref('')

function submit() {
  emit('submit', username.value, password.value)
}
</script>

<template>
  <main class="login-shell">
    <section class="login-card" aria-labelledby="login-title">
      <div class="login-mark">法</div>
      <h1 id="login-title">法典校对台</h1>
      <p class="login-subtitle">法律教材 · PDF 校对工作台</p>
      <form @submit.prevent="submit">
        <label for="username">账号</label>
        <input id="username" v-model="username" name="username" autocomplete="username" :disabled="loading" />
        <label for="password">密码</label>
        <input id="password" v-model="password" name="password" type="password" autocomplete="current-password" :disabled="loading" autofocus />
        <p v-if="error" class="login-error" role="alert">{{ error }}</p>
        <button type="submit" :disabled="loading || !username || !password">
          {{ loading ? '正在登录…' : '登录' }}
        </button>
      </form>
      <p class="login-restriction">仅限项目组使用</p>
    </section>
  </main>
</template>

<style scoped>
.login-shell{display:grid;min-height:100vh;padding:32px 20px;place-items:center;background:linear-gradient(180deg,#172033 0,#202c43 42%,#edf0f4 42%)}
.login-card{width:min(100%,390px);padding:42px 42px 32px;text-align:center;background:#fbfaf7;border:1px solid #ddd6c8;border-radius:14px;box-shadow:0 22px 60px rgba(16,27,47,.22)}
.login-mark{display:grid;width:54px;height:54px;margin:0 auto 19px;place-items:center;color:#172033;font-family:serif;font-size:28px;font-weight:800;background:#cfb17d;border-radius:12px}
h1{margin:0;color:#172033;font-size:24px;letter-spacing:.08em}.login-subtitle{margin:8px 0 30px;color:#7d8797;font-size:12px;letter-spacing:.04em}form{text-align:left}label{display:block;margin:16px 0 7px;color:#445168;font-size:12px;font-weight:650}input{width:100%;height:43px;padding:0 12px;color:#172033;background:#fff;border:1px solid #ccd3dd;border-radius:7px;outline:none}input:focus{border-color:#997c50;box-shadow:0 0 0 3px rgba(153,124,80,.13)}button{width:100%;height:43px;margin-top:22px;color:#fff;font-weight:650;background:#172033;border:0;border-radius:7px}button:hover:not(:disabled){background:#25334d}button:disabled{cursor:not-allowed;opacity:.55}.login-error{min-height:18px;margin:11px 0 -8px;color:#a13e3e;font-size:12px}.login-restriction{margin:24px 0 0;color:#9a907f;font-size:11px;letter-spacing:.08em}
</style>
