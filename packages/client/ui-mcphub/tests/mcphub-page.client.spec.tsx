// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { McphubSnapshot, McphubToolsSnapshot } from '../src/client/face.ts'
import { McphubPage, type McphubPageProps } from '../src/client/McphubPage.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const messages: Readonly<Record<string, string>> = zh

/**
 * Assemble the props the main slot renderer would pass.
 * @param load - the injected read.
 * @param extra - overrides for the other injected calls.
 * @returns the page props.
 */
function props(load: McphubPageProps['load'], extra: Partial<McphubPageProps> = {}): McphubPageProps {
  return {
    load,
    loadTools: vi.fn(async () => TOOLS),
    loadSelection: vi.fn(async () => null),
    saveSelection: vi.fn(async () => undefined),
    act: vi.fn(async () => undefined),
    ...extra,
    t: (key, params) => {
      const template = (messages as Record<string, string>)[key] ?? key
      return params === undefined
        ? template
        : template.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name]))
    },
  } as McphubPageProps
}

const SNAPSHOT: McphubSnapshot = {
  available: true,
  authorized: true,
  routing: 'all',
  servers: [
    { name: 'amap', description: '高德地图', visibility: 'private', status: 'running' },
    { name: 'shared', description: '', visibility: 'group', status: 'stopped' },
  ],
}

const TOOLS: McphubToolsSnapshot = {
  available: true,
  authorized: true,
  servers: [
    {
      name: 'amap',
      tools: [
        { name: 'amap-maps_geo', description: '地理编码', enabled: true },
        { name: 'amap-maps_route', description: '路径规划', enabled: false },
      ],
    },
    { name: 'shared', tools: [] },
  ],
}

describe('the MCPHub service page', () => {
  it('lists the discovered services with localized badges and states', async () => {
    const view = render(<McphubPage {...props(vi.fn(async () => SNAPSHOT))} />)
    await waitFor(() => { expect(view.getByText('amap')).toBeTruthy() })
    expect(view.getByText('高德地图')).toBeTruthy()
    expect(view.getByText('私有')).toBeTruthy()
    expect(view.getByText('共享')).toBeTruthy()
    expect(view.getByText('运行中')).toBeTruthy()
    expect(view.getByText('已停止')).toBeTruthy()
    expect(view.getByText('共 2 个服务')).toBeTruthy()
  })

  it('reports an empty catalog differently from an absent MCPHub', async () => {
    const empty = render(<McphubPage {...props(vi.fn(async () => ({ available: true, authorized: true, servers: [], routing: 'all' })))} />)
    await waitFor(() => { expect(empty.getByText('MCPHub 里还没有你可用的服务')).toBeTruthy() })
    empty.unmount()

    const absent = render(<McphubPage {...props(vi.fn(async () => ({ available: false, authorized: false, servers: [], routing: 'all' })))} />)
    await waitFor(() => { expect(absent.getByText('MCPHub 未安装或暂不可达')).toBeTruthy() })
  })

  it('tells a signed-out reader to reload instead of showing an empty list', async () => {
    const view = render(<McphubPage {...props(vi.fn(async () => ({ available: true, authorized: false, servers: [], routing: 'all' })))} />)
    await waitFor(() => { expect(view.getByText('VOS 登录状态已失效，请刷新页面后重试')).toBeTruthy() })
  })

  it('shows a read failure and keeps the refresh action usable', async () => {
    const load = vi.fn(async () => { throw new Error('HTTP 502') })
    const view = render(<McphubPage {...props(load)} />)
    await waitFor(() => { expect(view.getByText('读取失败：HTTP 502')).toBeTruthy() })
    fireEvent.click(view.getByRole('button', { name: '刷新' }))
    await waitFor(() => { expect(load).toHaveBeenCalledTimes(2) })
  })

  it('re-reads the list when refresh is pressed', async () => {
    const load = vi.fn(async () => SNAPSHOT)
    const view = render(<McphubPage {...props(load)} />)
    await waitFor(() => { expect(view.getByText('amap')).toBeTruthy() })
    fireEvent.click(view.getByRole('button', { name: '刷新' }))
    await waitFor(() => { expect(load).toHaveBeenCalledTimes(2) })
  })

  it('shows the upstream code when the gateway read reached MCPHub but failed', async () => {
    const view = render(<McphubPage {...props(vi.fn(async () => ({ available: true, authorized: true, servers: [], routing: 'all', error: 'http-503' })))} />)
    await waitFor(() => { expect(view.getByText('读取失败：http-503')).toBeTruthy() })
  })

  it('names the routing mode the Agent connects with', async () => {
    const view = render(<McphubPage {...props(vi.fn(async () => ({ ...SNAPSHOT, routing: 'smart' })))} />)
    await waitFor(() => { expect(view.getByText('智能路由')).toBeTruthy() })
  })

  it('previews one service tools on demand and marks the disabled ones', async () => {
    const loadTools = vi.fn(async () => TOOLS)
    const view = render(<McphubPage {...props(vi.fn(async () => SNAPSHOT), { loadTools })} />)
    await waitFor(() => { expect(view.getByText('amap')).toBeTruthy() })
    expect(loadTools).not.toHaveBeenCalled()

    fireEvent.click(view.getAllByRole('button', { name: '工具' })[0]!)
    await waitFor(() => { expect(view.getByText('amap-maps_geo')).toBeTruthy() })
    expect(view.getByText('地理编码')).toBeTruthy()
    expect(view.getByText('已停用')).toBeTruthy()
    expect(loadTools).toHaveBeenCalledTimes(1)

    // The second service reuses the read rather than paying for another one.
    fireEvent.click(view.getAllByRole('button', { name: '工具' })[0]!)
    await waitFor(() => { expect(view.getByText('该服务没有提供工具')).toBeTruthy() })
    expect(loadTools).toHaveBeenCalledTimes(1)
  })

  it('records the chosen services and tells the reader a restart applies them', async () => {
    const saveSelection = vi.fn(async () => undefined)
    const view = render(<McphubPage {...props(vi.fn(async () => SNAPSHOT), { saveSelection })} />)
    await waitFor(() => { expect(view.getByText('amap')).toBeTruthy() })

    fireEvent.click(view.getByRole('button', { name: '仅选中的服务' }))
    fireEvent.click(view.getAllByRole('checkbox')[0]!)
    fireEvent.click(view.getByRole('button', { name: '保存选择' }))

    await waitFor(() => { expect(saveSelection).toHaveBeenCalledWith(['amap']) })
    await waitFor(() => { expect(view.getByText('已保存，重启工作区后生效')).toBeTruthy() })
  })

  it('starts from the recorded choice and restores every service on demand', async () => {
    const saveSelection = vi.fn(async () => undefined)
    const view = render(
      <McphubPage {...props(vi.fn(async () => SNAPSHOT), { saveSelection, loadSelection: vi.fn(async () => ['shared']) })} />,
    )
    await waitFor(() => { expect(view.getByText('amap')).toBeTruthy() })
    const boxes = view.getAllByRole('checkbox') as HTMLInputElement[]
    await waitFor(() => { expect(boxes[1]!.checked).toBe(true) })
    expect(boxes[0]!.checked).toBe(false)

    fireEvent.click(view.getByRole('button', { name: '全部服务' }))
    fireEvent.click(view.getByRole('button', { name: '保存选择' }))
    await waitFor(() => { expect(saveSelection).toHaveBeenCalledWith(null) })
  })

  it('reports a refused save beside the controls', async () => {
    const saveSelection = vi.fn(async () => { throw new Error('HTTP 403') })
    const view = render(<McphubPage {...props(vi.fn(async () => SNAPSHOT), { saveSelection })} />)
    await waitFor(() => { expect(view.getByText('amap')).toBeTruthy() })
    fireEvent.click(view.getByRole('button', { name: '仅选中的服务' }))
    fireEvent.click(view.getAllByRole('checkbox')[0]!)
    fireEvent.click(view.getByRole('button', { name: '保存选择' }))
    await waitFor(() => { expect(view.getByText('保存失败：HTTP 403')).toBeTruthy() })
  })

  it('stops a running service and re-reads the list to show the new status', async () => {
    const act = vi.fn(async () => undefined)
    const load = vi.fn(async () => SNAPSHOT)
    const view = render(<McphubPage {...props(load, { act })} />)
    await waitFor(() => { expect(view.getByText('amap')).toBeTruthy() })

    fireEvent.click(view.getAllByRole('button', { name: '停用' })[0]!)
    await waitFor(() => { expect(act).toHaveBeenCalledWith('amap', 'toggle', false) })
    await waitFor(() => { expect(load).toHaveBeenCalledTimes(2) })
  })

  it('starts a stopped service with the state it wants', async () => {
    const act = vi.fn(async () => undefined)
    const view = render(<McphubPage {...props(vi.fn(async () => SNAPSHOT), { act })} />)
    await waitFor(() => { expect(view.getByText('shared')).toBeTruthy() })

    // The second row is the stopped `shared`; its action reads 启用.
    fireEvent.click(view.getAllByRole('button', { name: '启用' })[0]!)
    await waitFor(() => { expect(act).toHaveBeenCalledWith('shared', 'toggle', true) })
  })

  it('reports a refused action on its own row, with MCPHub\'s verdict', async () => {
    const act = vi.fn(async () => { throw new Error('Server not found') })
    const view = render(<McphubPage {...props(vi.fn(async () => SNAPSHOT), { act })} />)
    await waitFor(() => { expect(view.getByText('amap')).toBeTruthy() })

    fireEvent.click(view.getAllByRole('button', { name: '重载' })[0]!)
    await waitFor(() => { expect(view.getByText('操作失败：Server not found')).toBeTruthy() })
  })
})
