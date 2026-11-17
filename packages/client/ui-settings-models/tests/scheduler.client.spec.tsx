// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import { SchedulerController, SchedulerSection } from '../src/client/SchedulerSection.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)
const catalog = (): ModelCatalog => ({
  default: { provider: 'v-scheduler', model: 'registered/one' },
  routableProviders: ['v-scheduler', 'my-provider'], failures: [],
  groups: [{ id: 'v-scheduler', name: 'V-Scheduler', models: [
    { id: 'registered/one', name: 'One' },
    { id: 'private/two', name: 'Two' },
  ] }, { id: 'my-provider', name: 'Personal provider', models: [{ id: 'personal', name: 'Personal model' }] }],
})

it('loads current models, saves the picked default and refreshes newly added models', async () => {
  let current = catalog()
  const select = vi.fn(async (provider: string, model: string) => { current = { ...current, default: { provider, model } } })
  const controller = new SchedulerController({ load: async () => current, select })
  render(<SchedulerSection controller={controller} t={key => zh[key]} />)
  const picker = await screen.findByRole('combobox')
  await waitFor(() => { expect((picker as HTMLSelectElement).disabled).toBe(false) })
  expect(screen.queryByText('添加模型提供商')).toBeNull()
  expect(screen.getByRole('link').getAttribute('href')).toBe('/#/app/app-drawer/com.ictrek.v-scheduler/v-scheduler')
  fireEvent.change(picker, { target: { value: JSON.stringify(['v-scheduler', 'private/two']) } })
  await waitFor(() => { expect(select).toHaveBeenCalledWith('v-scheduler', 'private/two') })
  await waitFor(() => { expect((picker as HTMLSelectElement).value).toBe(JSON.stringify(['v-scheduler', 'private/two'])) })
  fireEvent.change(picker, { target: { value: JSON.stringify(['my-provider', 'personal']) } })
  await waitFor(() => { expect(select).toHaveBeenCalledWith('my-provider', 'personal') })
  await waitFor(() => { expect((picker as HTMLSelectElement).value).toBe(JSON.stringify(['my-provider', 'personal'])) })
  current = { ...current, groups: [{ ...current.groups[0]!, models: [{ id: 'new', name: 'New' }] }] }
  fireEvent.click(screen.getByRole('button', { name: '刷新模型列表' }))
  await screen.findByRole('option', { name: 'New' })
  expect(screen.queryByRole('option', { name: 'Two' })).toBeNull()
})

it('shows an empty-state guide and reports discovery and save failures', async () => {
  const load = vi.fn(async (): Promise<ModelCatalog> => ({ ...catalog(), groups: [] }))
  const controller = new SchedulerController({ load, select: async () => { throw new Error('model was removed') } })
  render(<SchedulerSection controller={controller} t={key => zh[key]} />)
  await screen.findByText(/暂无可用模型/)
  load.mockRejectedValueOnce(new Error('V-Scheduler unavailable'))
  fireEvent.click(screen.getByRole('button', { name: '刷新模型列表' }))
  expect((await screen.findByRole('alert')).textContent).toBe('V-Scheduler unavailable')
  await controller.load({ provider: 'v-scheduler', model: 'deleted' })
  expect(controller.store.getSnapshot().error).toBe('model was removed')
})
