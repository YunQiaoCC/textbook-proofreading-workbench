import { ref } from 'vue'
import { ApiError, setAuthenticationRequiredHandler } from '../../services/apiClient'
import { getSession, login as loginRequest, logout as logoutRequest, type AuthAccount } from '../../services/authApi'

export function useAuthSession() {
  const initialized = ref(false)
  const loading = ref(true)
  const authenticated = ref(false)
  const account = ref<AuthAccount | null>(null)
  const error = ref('')

  function showLogin() {
    authenticated.value = false
    account.value = null
    if (window.location.pathname !== '/login') window.history.replaceState(null, '', '/login')
  }

  function showWorkbench(nextAccount: AuthAccount | null) {
    authenticated.value = true
    account.value = nextAccount
    error.value = ''
    if (window.location.pathname !== '/') window.history.replaceState(null, '', '/')
  }

  setAuthenticationRequiredHandler(() => {
    error.value = ''
    showLogin()
  })

  async function initialize() {
    loading.value = true
    error.value = ''
    try {
      const session = await getSession()
      if (session.authenticated) showWorkbench(session.account)
      else showLogin()
    } catch {
      showLogin()
      error.value = '暂时无法验证登录状态，请稍后重试'
    } finally {
      initialized.value = true
      loading.value = false
    }
  }

  async function login(username: string, password: string) {
    if (loading.value) return
    loading.value = true
    error.value = ''
    try {
      const session = await loginRequest(username, password)
      showWorkbench(session.account)
    } catch (value) {
      showLogin()
      error.value = value instanceof ApiError && value.code === 'invalid_credentials'
        ? '账号或访问口令不正确'
        : '登录失败，请稍后重试'
    } finally {
      loading.value = false
    }
  }

  async function logout() {
    if (loading.value) return
    loading.value = true
    error.value = ''
    try {
      await logoutRequest()
      showLogin()
    } catch {
      error.value = '退出登录失败，请稍后重试'
    } finally {
      loading.value = false
    }
  }

  return { initialized, loading, authenticated, account, error, initialize, login, logout }
}
