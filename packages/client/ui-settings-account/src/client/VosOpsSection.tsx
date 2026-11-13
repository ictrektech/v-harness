import { useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

const en = {
  title: 'VOS operations', description: 'A VOS system administrator can open a 15-minute read-only session. Every restart or cleanup needs separate confirmation.',
  authorize: 'Authorize diagnostics', refresh: 'Refresh inventory', busy: 'Working…',
  applications: 'Installed applications', containers: 'VOS application containers', ports: 'Published Docker ports',
  images: 'Unused untagged images', none: 'None found', logs: 'Read recent logs',
  restart: 'Restart application', removeContainer: 'Remove stopped old container', removeImage: 'Remove untagged image',
  confirm: 'Confirm this operation', cancel: 'Cancel', confirmation: 'Check the exact target below. This confirmation expires in 60 seconds.',
  accepted: 'Operation accepted. Refresh the inventory to check progress.',
  failed: 'The request failed. Refresh the inventory or authorize again if the session expired.',
  forbidden: 'VOS system administrator permission and an active diagnostics grant are required.',
  cleanup: 'Container cleanup deletes its writable layer and keeps volumes. Image cleanup is limited to untagged images with no container references.',
  port: 'Filter by host port', closeLogs: 'Close logs', status: 'View status',
  targetId: 'Type the exact target ID', close: 'End diagnostics', tagged: 'Tagged images with no container references',
} satisfies Record<string, string>
const zh: Record<keyof typeof en, string> = {
  title: 'VOS 运维', description: 'VOS 系统管理员可开启 15 分钟的只读诊断。每次重启或清理都需单独确认。',
  authorize: '授权诊断', refresh: '刷新清单', busy: '正在处理…',
  applications: '已安装应用', containers: 'VOS 应用容器', ports: 'Docker 发布端口',
  images: '无标签且未使用的镜像', none: '未发现', logs: '查看近期日志',
  restart: '重启应用', removeContainer: '删除已退出的旧版容器', removeImage: '删除无标签镜像',
  confirm: '确认执行', cancel: '取消', confirmation: '请核对下面的具体对象。此次确认 60 秒后失效。',
  accepted: '操作已受理。刷新清单查看进度。',
  failed: '请求失败。请刷新清单；若授权已过期，请重新授权。',
  forbidden: '需要 VOS 系统管理员权限和有效的诊断授权。',
  cleanup: '删除容器会删除其可写层并保留卷。仅可清理无标签且没有容器引用的镜像。',
  port: '按宿主机端口筛选', closeLogs: '关闭日志', status: '查看状态',
  targetId: '输入完整的目标 ID', close: '结束诊断', tagged: '没有容器引用的带标签镜像',
}

export const vosOpsEn = en
export const vosOpsZh = zh
export type VosOpsKey = keyof typeof en
type Action = 'restart' | 'remove-container' | 'remove-image'
type Inventory = {
  apps: { appId: string; version: string; state: string; lastError: string }[]
  containers: { id: string; name: string; image: string; state: string; status: string; cleanup: boolean;
    stack: { appId: string; version: string; project: string } }[]
  publishedPorts: { hostPort: number; containerPort: number; protocol: string; address: string; container: string; appId: string | null }[]
  unusedImages: { id: string; created: number; bytes: number }[]
  unreferencedTaggedImages: { id: string; tags: string[]; bytes: number }[]
}
type Preview = { action: Action; confirmation: string; targetId: string; target: unknown }

async function request<T>(path: string, grant?: string, body?: object): Promise<T> {
  const response = await fetch('/__vh/vos-ops/' + path, {
    method: body ? 'POST' : 'GET', cache: 'no-store', credentials: 'same-origin',
    headers: { 'x-vh-ops': '1', ...(grant ? { 'x-vh-ops-grant': grant } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!response.ok) throw new Error(String(response.status))
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
        setMessage('failed')
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
  const operationLabel = (action: Action): VosOpsKey => action === 'restart' ? 'restart'
    : action === 'remove-container' ? 'removeContainer' : 'removeImage'
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
      <h3>{t(operationLabel(preview.action))}</h3>
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
