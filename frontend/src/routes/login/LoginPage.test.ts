import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setLocale } from '$lib/paraglide/runtime.js'

const { authClient, navigate } = vi.hoisted(() => ({
  authClient: { login: vi.fn() },
  navigate: vi.fn(),
}))
vi.mock('$lib/sync', () => ({ authClient }))
vi.mock('../../app/router.svelte', () => ({ navigate }))

import LoginPage from './LoginPage.svelte'

afterEach(cleanup)

describe('LoginPage', () => {
  it('shows the user-facing login error', async () => {
    authClient.login.mockRejectedValue(new Error('Wrong password.'))
    render(LoginPage)
    await fireEvent.input(screen.getByLabelText('Password'), { target: { value: 'incorrect' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong password.')
    await waitFor(() => expect(authClient.login).toHaveBeenCalledWith('incorrect'))
  })

  it('labels code sign-in and validates an incomplete code in Simplified Chinese', async () => {
    void setLocale('zh-CN', { reload: false })
    try {
      render(LoginPage)
      expect(screen.getByRole('heading', { name: '登录' })).toBeInTheDocument()
      await fireEvent.click(screen.getByRole('button', { name: '输入加入码' }))
      await fireEvent.input(screen.getByLabelText('加入码'), { target: { value: '123' } })
      await fireEvent.click(screen.getByRole('button', { name: '登录' }))
      expect(await screen.findByRole('alert')).toHaveTextContent('请输入八位加入码。')
    } finally {
      void setLocale('en', { reload: false })
    }
  })
})
