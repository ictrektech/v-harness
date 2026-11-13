import { useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

const en = {
  title: 'VOS operations', description: 'A VOS system administrator can open a 15-minute read-only session. Every restart or cleanup needs separate confirmation.',
  authorize: 'Authorize diagnostics', refresh: 'Refresh inventory', busy: 'Working…',
  applications: 'Installed applications', containers: 'VOS application containers', ports: 'Published Docker ports',
  images: 'Unused untagged images', none: 'None found', logs: 'Read recent logs',
  restart: 'Restart application', stopContainer: 'Stop old container', removeContainer: 'Remove stopped old container', removeImage: 'Remove untagged image',
  confirm: 'Confirm this operation', cancel: 'Cancel', confirmation: 'Check the exact target below. This confirmation expires in 60 seconds.',
  accepted: 'Operation accepted. Refresh the inventory to check progress.',
  pending: 'Awaiting your confirmation. The operation has not run.',
  targetChanged: 'The target changed or is no longer eligible. Refresh inventory and request a new proposal.',
  confirmationUnavailable: 'This confirmation expired or was already used. Check the current state before requesting another.',
  failed: 'The request failed. Refresh the inventory or authorize again if the session expired.',
  forbidden: 'VOS system administrator permission and an active diagnostics grant are required.',
  cleanup: 'Container cleanup deletes its writable layer and keeps volumes. Image cleanup is limited to untagged images with no container references.',
  port: 'Filter by host port', closeLogs: 'Close logs', status: 'View status',
  hostManagement: 'Host management',
  hostEnable: 'Enable host management',
  hostDisable: 'Turn off host management',
  hostDescription: 'For this conversation, the Agent can list containers and read logs across the host. Container changes require your confirmation. Access expires in 30 minutes.',
  hostStart: 'Start host container', hostStop: 'Stop host container',
  hostRestart: 'Restart host container', hostRemove: 'Remove host container',
  proposalTitle: 'VOS repair confirmation',
  targetId: 'Type the exact target ID', close: 'End diagnostics', tagged: 'Tagged images with no container references',
} satisfies Record<string, string>
const zh: Record<keyof typeof en, string> = {
  title: 'VOS 运维', description: 'VOS 系统管理员可开启 15 分钟的只读诊断。每次重启或清理都需单独确认。',
  authorize: '授权诊断', refresh: '刷新清单', busy: '正在处理…',
  applications: '已安装应用', containers: 'VOS 应用容器', ports: 'Docker 发布端口',
  images: '无标签且未使用的镜像', none: '未发现', logs: '查看近期日志',
  restart: '重启应用', stopContainer: '停止旧版容器', removeContainer: '删除已退出的旧版容器', removeImage: '删除无标签镜像',
  confirm: '确认执行', cancel: '取消', confirmation: '请核对下面的具体对象。此次确认 60 秒后失效。',
  accepted: '操作已受理。刷新清单查看进度。',
  pending: '等待你确认。操作尚未执行。',
  targetChanged: '目标已变化或不再符合条件。请刷新清单并重新发起提议。',
  confirmationUnavailable: '这次确认已过期或已使用。请先检查当前状态，再发起新提议。',
  failed: '请求失败。请刷新清单；若授权已过期，请重新授权。',
  forbidden: '需要 VOS 系统管理员权限和有效的诊断授权。',
  cleanup: '删除容器会删除其可写层并保留卷。仅可清理无标签且没有容器引用的镜像。',
  port: '按宿主机端口筛选', closeLogs: '关闭日志', status: '查看状态',
  hostManagement: '宿主机管理',
  hostEnable: '开启宿主机管理',
  hostDisable: '关闭宿主机管理',
  hostDescription: '开启后，本会话的 Agent 可以查看宿主机容器和日志。修改容器需由你确认，授权 30 分钟后到期。',
  hostStart: '启动宿主机容器', hostStop: '停止宿主机容器',
  hostRestart: '重启宿主机容器', hostRemove: '删除宿主机容器',
  proposalTitle: '确认 VOS 修复',
  targetId: '输入完整的目标 ID', close: '结束诊断', tagged: '没有容器引用的带标签镜像',
}

export const vosOpsEn = en
export const vosOpsZh = zh
export type VosOpsKey = keyof typeof en
const hostLabels = {
  'host-start': 'hostStart', 'host-stop': 'hostStop', 'host-restart': 'hostRestart', 'host-remove': 'hostRemove',
} as const
type Action = 'restart' | 'stop-container' | 'remove-container' | 'remove-image' | keyof typeof hostLabels
type Inventory = {
  apps: { appId: string; version: string; state: string; lastError: string }[]
  containers: { id: string; name: string; image: string; state: string; status: string; cleanup: boolean; stoppable: boolean;
    stack: { appId: string; version: string; project: string } }[]
  publishedPorts: { hostPort: number; containerPort: number; protocol: string; address: string; container: string; appId: string | null }[]
  unusedImages: { id: string; created: number; bytes: number }[]
  unreferencedTaggedImages: { id: string; tags: string[]; bytes: number }[]
}
type Preview = { action: Action; confirmation: string; targetId: string; target: unknown }

function actionLabel(action: Action): VosOpsKey {
  if (action === 'host-start' || action === 'host-stop' || action === 'host-restart' || action === 'host-remove') return hostLabels[action]
  if (action === 'stop-container') return 'stopContainer'
  return action === 'restart' ? 'restart' : action === 'remove-container' ? 'removeContainer' : 'removeImage'
}

async function request<T>(path: string, grant?: string, body?: object): Promise<T> {
  const response = await fetch('/__vh/vos-ops/' + path, {
    method: body ? 'POST' : 'GET', cache: 'no-store', credentials: 'same-origin',
    headers: { 'x-vh-ops': '1', ...(grant ? { 'x-vh-ops-grant': grant } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!response.ok) {
    const failure = await response.json().catch(() => null)
    if (failure?.error === 'target-changed') throw new Error('targetChanged')
    if (failure?.error === 'confirmation-unavailable') throw new Error('confirmationUnavailable')
    throw new Error(String(response.status))
  }
  return response.json() as Promise<T>
}

export function VosOpsSection({ t }: PropsLocale<'settings.vh-ops'>) {
  const [grant, setGrant] = useState<string>()
  const [inventory, setInventory] = useState<Inventory>()
  const [preview, setPreview] = useState<Preview>()
  const [log, setLog] = useState<{ id: string; text: string }>()
  const [appStatus, setAppStatus] = useState<unknown>()
  const [port, setPort] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<VosOpsKey>()
  const [task, setTask] = useState<string>()
  const run = async (operation: () => Promise<void>) => {
    setBusy(true)
    setMessage(undefined)
    setTask(undefined)
    try {
      await operation()
    } catch (error) {
      const status = error instanceof Error ? error.message : ''
      if (status === '401' || status === '403') {
        setGrant(undefined)
        setInventory(undefined)
        setPreview(undefined)
        setLog(undefined)
        setAppStatus(undefined)
        setMessage('forbidden')
      } else {
        setMessage(status === 'targetChanged' ? 'targetChanged' : 'failed')
      }
    } finally {
      setBusy(false)
    }
  }
  const authorize = () => run(async () => {
    const result = await request<{ grant: string }>('authorize', undefined, {})
    setGrant(result.grant)
    setPreview(undefined)
    setLog(undefined)
    setAppStatus(undefined)
    setInventory(await request<Inventory>('inventory', result.grant))
  })
  const prepare = (action: Action, id: string) => run(async () => {
    setPreview(undefined)
    setPreview(await request<Preview>('preview', grant, { action, id }))
  })
  const execute = (pending: Preview, fields: FormData) => run(async () => {
    setPreview(undefined)
    const result = await request<{ taskId: string | null }>('execute', grant, {
      confirmation: pending.confirmation, targetId: fields.get('targetId'),
    })
    setMessage('accepted')
    if (result.taskId) setTask(result.taskId)
  })
  const pre = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 260, overflow: 'auto' } as const
  const button = (label: VosOpsKey, onClick: () => void) =>
    <button type="button" disabled={busy} onClick={onClick}>{t(label)}</button>

  return <div>
    <p>{t('description')}</p>
    {button('authorize', authorize)}{' '}
    {grant && button('refresh', () => run(async () => {
      setPreview(undefined)
      setInventory(await request<Inventory>('inventory', grant))
    }))}
    {grant && button('close', () => run(async () => {
      await request('close', grant, {})
      setGrant(undefined)
      setInventory(undefined)
      setLog(undefined)
      setAppStatus(undefined)
      setPreview(undefined)
    }))}
    {busy && <p role="status">{t('busy')}</p>}
    {message && <p role="status">{t(message)} {task && <code>{task}</code>}</p>}
    {preview && <section aria-label={t('confirm')}>
      <h3>{t(actionLabel(preview.action))}</h3>
      <p>{t('confirmation')}</p>
      <pre style={pre}>{JSON.stringify(preview.target, null, 2)}</pre>
      <form onSubmit={event => {
        event.preventDefault()
        const fields = new FormData(event.currentTarget)
        event.currentTarget.reset()
        void execute(preview, fields)
      }}>
        <label>{t('targetId')} <input name="targetId" autoComplete="off" required maxLength={128} /></label>{' '}
        <button type="submit" disabled={busy}>{t('confirm')}</button>{' '}
        {button('cancel', () => setPreview(undefined))}
      </form>
    </section>}
    {inventory && <>
      <h3>{t('applications')}</h3>
      {appStatus !== undefined && <pre style={pre}>{JSON.stringify(appStatus, null, 2)}</pre>}
      <ul>{inventory.apps.map(app => <li key={app.appId}>
        <strong>{app.appId}</strong> {app.version} · {app.state}{' '}
        {button('status', () => run(async () => {
          setAppStatus(await request('status?id=' + encodeURIComponent(app.appId), grant))
        }))}{' '}
        {app.state === 'installed' && app.appId !== 'com.ictrek.v-harness' &&
          button('restart', () => prepare('restart', app.appId))}
        {app.lastError && <pre style={pre}>{app.lastError}</pre>}
      </li>)}</ul>
      <h3>{t('containers')}</h3>
      {log && <section aria-label={t('logs')}>
        <code>{log.id}</code> {button('closeLogs', () => setLog(undefined))}
        <pre style={pre}>{log.text || t('none')}</pre>
      </section>}
      <ul>{inventory.containers.map(container => <li key={container.id}>
        <strong>{container.name}</strong> · {container.stack.version} · {container.status}{' '}
        {button('logs', () => run(async () => {
          setLog(await request<{ id: string; text: string }>('logs?id=' + container.id, grant))
        }))}{' '}
        {container.stoppable && button('stopContainer', () => prepare('stop-container', container.id))}
        {container.cleanup && container.stack.appId !== 'com.ictrek.v-harness' &&
          button('removeContainer', () => prepare('remove-container', container.id))}
      </li>)}</ul>
      <h3>{t('ports')}</h3>
      <label>{t('port')} <input type="search" inputMode="numeric" value={port} onChange={e => setPort(e.target.value)} /></label>
      <ul>{inventory.publishedPorts.filter(p => !port || String(p.hostPort) === port.trim()).map((p, i) =>
        <li key={i}><code>{p.address}:{p.hostPort}/{p.protocol}</code> → {p.container}:{p.containerPort}</li>)}</ul>
      <h3>{t('images')}</h3>
      <p>{t('cleanup')}</p>
      {!inventory.unusedImages.length && <p>{t('none')}</p>}
      <ul>{inventory.unusedImages.map(image => <li key={image.id}>
        <code style={{ overflowWrap: 'anywhere' }}>{image.id}</code> · {(image.bytes / (1024 * 1024)).toFixed(1)} MiB{' '}
        {button('removeImage', () => prepare('remove-image', image.id))}
      </li>)}</ul>
      <h3>{t('tagged')}</h3>
      <ul>{inventory.unreferencedTaggedImages.map(image => <li key={image.id}>
        {image.tags.join(', ')} · {(image.bytes / (1024 * 1024)).toFixed(1)} MiB
      </li>)}</ul>
    </>}
  </div>
}

/** Render a server-owned proposal in the active conversation. */
export function VosOpsConfirmation({ t, useSessions }: PropsLocale<'settings.vh-ops'> & PropsRuntime<'shell.overlay'>) {
  const sessionId = useSessions(s => Object.values(s.byId).find(row => (row.retainedBy.mainView ?? 0) > 0)?.id)
  const [hostMode, setHostMode] = useState<{ sessionId: string; enabled: boolean }>()
  const [hostPrompt, setHostPrompt] = useState(false)
  const [hostError, setHostError] = useState(false)
  const [hostBusy, setHostBusy] = useState(false)
  const [pending, setPending] = useState<{ sessionId: string; proposal: Preview }>()
  const [result, setResult] = useState<{ sessionId: string; message: VosOpsKey; taskId?: string }>()
  const [busy, setBusy] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const proposal = pending?.sessionId === sessionId ? pending?.proposal : undefined
  const outcome = result?.sessionId === sessionId ? result : undefined

  useEffect(() => {
    setHostPrompt(false)
    setHostError(false)
    if (!sessionId) return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const mode = await request<{ enabled: boolean }>('host-mode?sessionId=' + encodeURIComponent(sessionId)).catch(() => undefined)
        if (active) setHostMode(mode ? { sessionId, enabled: mode.enabled } : undefined)
        const data = await request<{ proposal: Preview | null }>('proposal?sessionId=' + encodeURIComponent(sessionId))
        if (active) setPending(data.proposal ? { sessionId, proposal: data.proposal } : undefined)
      } catch {
        if (active) setPending(undefined)
      } finally {
        if (active) timer = setTimeout(() => void poll(), 2500)
      }
    }
    void poll()
    return () => { active = false; clearTimeout(timer) }
  }, [sessionId])

  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) element.showModal()
  }, [proposal?.confirmation, outcome])

  const settle = async (approved: boolean, targetId?: FormDataEntryValue | null) => {
    if (!sessionId || !proposal || busy) return
    setBusy(true)
    try {
      const response = await request<{ taskId?: string }>('confirm-proposal?sessionId=' + encodeURIComponent(sessionId),
        undefined, { confirmation: proposal.confirmation, approved, targetId })
      if (approved) setResult({ sessionId, message: 'accepted', ...(response.taskId ? { taskId: response.taskId } : {}) })
    } catch (error) {
      const code = error instanceof Error ? error.message : ''
      const message = code === 'targetChanged' || code === 'confirmationUnavailable' ? code : 'failed'
      setResult({ sessionId, message })
    } finally {
      setPending(undefined)
      setBusy(false)
    }
  }
  const activeHostMode = hostMode?.sessionId === sessionId ? hostMode : undefined
  const setHostEnabled = async (enabled: boolean) => {
    if (!sessionId || hostBusy) return
    setHostBusy(true)
    setHostError(false)
    try {
      const mode = await request<{ enabled: boolean }>('host-mode?sessionId=' + encodeURIComponent(sessionId),
        undefined, { enabled })
      setHostMode({ sessionId, enabled: mode.enabled })
      setHostPrompt(false)
    } catch {
      setHostError(true)
    } finally {
      setHostBusy(false)
    }
  }
  return <>
    {activeHostMode && <aside aria-label={t('hostManagement')} style={{ position: 'fixed', top: '4rem', right: '1rem', zIndex: 10 }}>
      {hostPrompt ? <section role="group" aria-label={t('hostManagement')}>
        <p>{t('hostDescription')}</p>
        <button type="button" disabled={hostBusy} onClick={() => void setHostEnabled(true)}>{t('hostEnable')}</button>{' '}
        <button type="button" disabled={hostBusy} onClick={() => setHostPrompt(false)}>{t('cancel')}</button>
      </section> : <button type="button" disabled={hostBusy} onClick={() => {
        if (activeHostMode.enabled) void setHostEnabled(false)
        else setHostPrompt(true)
      }}>{t(activeHostMode.enabled ? 'hostDisable' : 'hostManagement')}</button>}
      {hostError && <p role="alert">{t('failed')}</p>}
    </aside>}
    {(proposal || outcome) && <dialog ref={dialog} aria-label={t('proposalTitle')} onCancel={event => {
    event.preventDefault()
    if (proposal) void settle(false)
    else setResult(undefined)
  }} style={{ maxWidth: 'min(640px, 90vw)', maxHeight: '80vh', overflow: 'auto', padding: '1.25rem' }}>
    <h3>{t('proposalTitle')}</h3>
    {outcome && <p role="status">{t(outcome.message)} {outcome.taskId && <code>{outcome.taskId}</code>}</p>}
    {proposal ? <form key={proposal.confirmation} onSubmit={event => {
      event.preventDefault()
      const input = event.currentTarget.elements.namedItem('targetId')
      if (!(input instanceof HTMLInputElement)) return
      if (input.value !== proposal.targetId) {
        input.setCustomValidity(t('targetId'))
        input.reportValidity()
        return
      }
      void settle(true, input.value)
    }}>
      <p>{t('pending')}</p>
      <p>{t(actionLabel(proposal.action))}</p>
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(proposal.target, null, 2)}</pre>
      <label>{t('targetId')} <input name="targetId" required autoComplete="off" onInput={e => e.currentTarget.setCustomValidity('')} /></label>{' '}
      <button type="submit" disabled={busy}>{t('confirm')}</button>{' '}
      <button type="button" disabled={busy} onClick={() => void settle(false)}>{t('cancel')}</button>
    </form> : <button type="button" onClick={() => setResult(undefined)}>{t('cancel')}</button>}
  </dialog>}
  </>
}
