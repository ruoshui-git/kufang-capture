import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'

const { authClient, navigate } = vi.hoisted(() => ({
  authClient: { login: vi.fn() },
  navigate: vi.fn(),
}))
vi.mock('$lib/sync', () => ({ authClient }))
vi.mock('../../app/router.svelte', () => ({ navigate }))

import LoginPage from './LoginPage.svelte'

describe('LoginPage', () => {
  it('shows the user-facing login error', async () => {
    authClient.login.mockRejectedValue(new Error('Wrong password.'))
    render(LoginPage)
    await fireEvent.input(screen.getByLabelText('Password'), { target: { value: 'incorrect' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong password.')
    await waitFor(() => expect(authClient.login).toHaveBeenCalledWith('incorrect'))
  })
})
