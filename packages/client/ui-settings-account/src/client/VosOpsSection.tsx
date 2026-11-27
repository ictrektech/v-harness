import { useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

const en = {
  title: 'VOS operations', description: 'A VOS system administrator can open a 15-minute read-only session. Every restart or cleanup needs separate confirmation.',
  authorize: 'Authorize diagnostics', refresh: 'Refresh inventory', busy: 'Working…',
  applications: 'Installed applications', containers: 'VOS application containers', ports: 'Published Docker ports',
  images: 'Unused untagged images', none: 'None found', logs: 'Read recent logs',
  restart: 'Restart application', stopContainer: 'Stop old container', removeContainer: 'Remove old container', removeImage: 'Remove image',
  confirm: 'Confirm this operation', cancel: 'Cancel', confirmation: 'Check the exact target below. This confirmation expires in 60 seconds.',
  accepted: 'Operation accepted. Refresh the inventory to check progress.',
  pending: 'Awaiting your confirmation. The operation has not run.',
  targetChanged: 'The target changed or is no longer eligible. Refresh inventory and request a new proposal.',
  confirmationUnavailable: 'This confirmation expired or was already used. Check the current state before requesting another.',
  failed: 'The request failed. Refresh the inventory or authorize again if the session expired.',
  forbidden: 'VOS system administrator permission and an active diagnostics grant are required.',
  cleanup: 'Container cleanup deletes its writable layer and keeps volumes. Image cleanup accepts images with no container references, including tagged images.',
  imageDeleteConflict: 'Docker refused to remove this image. Check for multiple tags, dependent images or a new container reference.',
  port: 'Filter by host port', closeLogs: 'Close logs', status: 'View status',
  hostManagement: 'Application containers',
  hostEnable: 'Enable application container management',
  hostDisable: 'Turn off application container management',
  hostDescription: 'For this conversation, the Agent can list VOS application containers and read their logs. Database, model and unrelated host containers stay hidden. Container changes require your confirmation. Access expires in 30 minutes.',
  hostStart: 'Start application container', hostStop: 'Stop application container',
  hostRestart: 'Restart application container', hostRemove: 'Remove application container',
  proposalTitle: 'VOS repair confirmation',
  targetList: 'Targets', removed: 'Removed', removalFailed: 'Removal failed',
  targetIdLabel: 'ID', targetName: 'Container', targetImage: 'Image', targetVersion: 'Version',

  schedulerManage: 'Manage compute nodes in V-Scheduler',
  imageStudioManage: 'Deploy backends and prepare models in Image Studio',
  nodes: 'Machines', targetNode: 'Target machine', nodeLocal: 'This machine',
  nodeStatus: 'Status', nodeHealth: 'Health', nodeObserved: 'Observed', nodeFresh: 'Fresh',
  nodeStale: 'Stale', nodeDraining: 'Draining', nodeApps: 'Applications on this machine',
  nodeHardwareOnly: 'This machine reports hardware only; its applications are not collected.',
  nodeRemoteOnly: 'Other machines expose health and their installed applications. Container work stays on this machine.',
  nodesNone: 'V-Scheduler returned no machines; showing this machine.',
  backends: 'Application backends', backendState: 'State', backendEndpoint: 'Endpoint',
  backendError: 'Last error', backendNone: 'V-Scheduler reports no application backends.',
  backendUnavailable: 'V-Scheduler is not reachable; backend states are unknown.',
  backendStart: 'Start backend', backendStop: 'Stop backend',
  backendContainer: 'Container', backendProbe: 'Probe', backendDiagnose: 'Diagnose this backend',
  closeFacts: 'Close details',
  backendTruncated: 'The register answered its newest 200 records; older instances may be missing.',
  nodeStaleData: 'V-Scheduler is unreachable. Showing the last machine list it answered.',
  nodeObservationOnly: 'Observation only',
  nodeDiagnose: 'Diagnose machine', nodeFindings: 'Findings', nodeInstanceStates: 'Instances by state',
  nodeRescan: 'Refresh hardware profile', nodeDrain: 'Drain machine', nodeUndrain: 'Resume scheduling',
  nodeRevoke: 'Revoke machine',
  schedulerForbidden: 'V-Scheduler does not accept this account as its administrator.',
  schedulerFailed: 'V-Scheduler refused the request.',

  issues: 'Problems', issuesNone: 'Nothing needs attention right now.',
  issueErrors: 'Errors', issueWarnings: 'Warnings',
  issuesDegraded: 'Some registers could not be read; they are listed above.',
  deployments: 'Inference deployments', deploymentHealth: 'Health', deploymentModel: 'Served model',
  deploymentNode: 'Machine', deploymentRouter: 'Router',
  deploymentNone: 'ModelInfer returned no inference deployments.',
  deploymentUnavailable: 'Inference deployments cannot be read right now.',
  deploymentStart: 'Start deployment', deploymentStop: 'Stop deployment',

  skip: 'Skip', close: 'End diagnostics', tagged: 'Tagged images with no container references',
} satisfies Record<string, string>
const zh: Record<keyof typeof en, string> = {
  title: 'VOS 运维', description: 'VOS 系统管理员可开启 15 分钟的只读诊断。每次重启或清理都需单独确认。',
  authorize: '授权诊断', refresh: '刷新清单', busy: '正在处理…',
  applications: '已安装应用', containers: 'VOS 应用容器', ports: 'Docker 发布端口',
  images: '无标签且未使用的镜像', none: '未发现', logs: '查看近期日志',
  restart: '重启应用', stopContainer: '停止旧版容器', removeContainer: '删除未运行的旧版容器', removeImage: '删除镜像',
  confirm: '确认执行', cancel: '取消', confirmation: '请核对下面的具体对象。此次确认 60 秒后失效。',
  accepted: '操作已受理。刷新清单查看进度。',
  pending: '等待你确认。操作尚未执行。',
  targetChanged: '目标已变化或不再符合条件。请刷新清单并重新发起提议。',
  confirmationUnavailable: '这次确认已过期或已使用。请先检查当前状态，再发起新提议。',
  failed: '请求失败。请刷新清单；若授权已过期，请重新授权。',
  forbidden: '需要 VOS 系统管理员权限和有效的诊断授权。',
  cleanup: '删除容器会删除其可写层并保留卷。可清理未被任何容器引用的镜像，包括带标签的镜像。',
  imageDeleteConflict: 'Docker 拒绝删除此镜像。请检查镜像是否有多个标签、依赖镜像或新增的容器引用。',
  port: '按宿主机端口筛选', closeLogs: '关闭日志', status: '查看状态',
  hostManagement: '应用容器管理',
  hostEnable: '开启应用容器管理',
  hostDisable: '关闭应用容器管理',
  hostDescription: '开启后，本会话的 Agent 可查看 VOS 应用栈的容器和日志，不含数据库、模型和宿主机上的其他容器。修改容器需由你确认，授权 30 分钟后到期。',
  hostStart: '启动应用容器', hostStop: '停止应用容器',
  hostRestart: '重启应用容器', hostRemove: '删除应用容器',
  proposalTitle: '确认 VOS 修复',
  targetList: '操作目标', removed: '已删除', removalFailed: '删除失败',
  targetIdLabel: '标识符', targetName: '容器', targetImage: '镜像', targetVersion: '版本',

  schedulerManage: '在 V-Scheduler 管理算力节点',
  imageStudioManage: '在 Image Studio 部署后端与准备模型',
  nodes: '机器', targetNode: '目标机器', nodeLocal: '本机',
  nodeStatus: '状态', nodeHealth: '健康', nodeObserved: '采集于', nodeFresh: '新鲜',
  nodeStale: '已过期', nodeDraining: '排空中', nodeApps: '该机器上的应用',
  nodeHardwareOnly: '该机器只采集硬件信息，没有应用清单。',
  nodeRemoteOnly: '其它机器只提供健康状态与已安装应用。容器相关操作仍在本机进行。',
  nodesNone: 'V-Scheduler 未返回任何机器，当前显示本机。',
  backends: '应用后端', backendState: '状态', backendEndpoint: '接入地址',
  backendError: '最近错误', backendNone: 'V-Scheduler 未登记任何应用后端。',
  backendUnavailable: 'V-Scheduler 不可达，后端状态未知。',
  backendStart: '启动后端', backendStop: '停止后端',
  backendContainer: '容器', backendProbe: '探活', backendDiagnose: '诊断该后端',
  closeFacts: '关闭详情',
  backendTruncated: '台账只返回最新的 200 条，更早的实例可能缺失。',
  nodeStaleData: 'V-Scheduler 暂不可达，显示上次成功返回的机器清单。',
  nodeObservationOnly: '仅观察',
  nodeDiagnose: '诊断该机器', nodeFindings: '诊断结论', nodeInstanceStates: '实例状态分布',
  nodeRescan: '刷新硬件 Profile', nodeDrain: '排空该机器', nodeUndrain: '恢复调度',
  nodeRevoke: '撤销该机器',
  schedulerForbidden: 'V-Scheduler 不认可当前账号为管理员。',
  schedulerFailed: 'V-Scheduler 拒绝了该请求。',

  issues: '问题', issuesNone: '当前没有需要处理的问题。',
  issueErrors: '错误', issueWarnings: '警告',
  issuesDegraded: '有部分台账读不到，已在上方列出。',
  deployments: '推理部署', deploymentHealth: '健康', deploymentModel: '服务模型',
  deploymentNode: '所在机器', deploymentRouter: '路由登记',
  deploymentNone: 'ModelInfer 未返回任何推理部署。',
  deploymentUnavailable: '推理部署当前读不到。',
  deploymentStart: '启动部署', deploymentStop: '停止部署',

  skip: '跳过', close: '结束诊断', tagged: '没有容器引用的带标签镜像',
}

export const vosOpsEn = en
export const vosOpsZh = zh
export type VosOpsKey = keyof typeof en
const hostLabels = {
  'host-start': 'hostStart', 'host-stop': 'hostStop', 'host-restart': 'hostRestart', 'host-remove': 'hostRemove',
} as const
type Action = 'restart' | 'stop-container' | 'remove-container' | 'remove-image'
  | 'backend-start' | 'backend-stop'
  | 'deployment-start' | 'deployment-stop'
  | 'node-rescan' | 'node-drain' | 'node-undrain' | 'node-revoke' | keyof typeof hostLabels
type Inventory = {
  apps: { appId: string; version: string; state: string; lastError: string }[]
  containers: {
    id: string
    name: string
    image: string
    state: string
    status: string
    cleanup: boolean
    stoppable: boolean
    stack: { appId: string; version: string; project: string }
  }[]
  publishedPorts: { hostPort: number; containerPort: number; protocol: string; address: string; container: string; appId: string | null }[]
  unusedImages: { id: string; created: number; bytes: number }[]
  unreferencedTaggedImages: { id: string; tags: string[]; bytes: number }[]
}
type RemovalResult = { id: string; removed: boolean; error?: string }
type TargetSummary = {
  id?: string
  appId?: string
  name?: string
  image?: string
  tags?: string[]
  version?: string
  stack?: { version: string }
}
type Preview = { action: Action; confirmation: string; targetId: string; target: unknown }
type NodeApp = { appId: string; version: string; state: string; error: string | null }
type NodeRow = {
  id: string
  name: string
  local: boolean
  kind: string
  managed: boolean
  /** The SSH register's own id when the scheduler view was merged with its
      managed record; deployments and backends name their machine by it. */
  managedId?: string
  status: string
  health: string | null
  draining: boolean
  observedAt: string | null
  fresh: boolean | null
  apps: { count: number; rows: NodeApp[]; observedAt: string | null; fresh: boolean; error: string | null } | null
  arch: string | null
  gpuModel: string | null
  profile: string | null
  capabilities: string[]
}
type Catalog = {
  source: 'scheduler' | 'local-fallback' | 'cache'
  error: string | null
  stale: boolean
  nodes: NodeRow[]
}
type NodeApps = { node: string; apps: NodeApp[]; observedAt: string | null; fresh: boolean; error: string | null }
type BackendRow = {
  id: string
  appId: string
  image: string
  targetKind: string
  targetId: string
  host: string | null
  port: number | null
  endpoint: string | null
  state: string
  error: string | null
  updatedAt: string | null
  container: { id: string; image: string; state: string; status: string } | null
  probe: { ok: boolean; status: number | null; ms: number; error: string | null } | null
}
type Backends = {
  available: boolean
  error: string | null
  node: string | null
  truncated: boolean
  total: number
  backends: BackendRow[]
}
type DeploymentNode = { id: string; name: string; host: string | null; status: string | null; role: string | null }
type DeploymentRow = {
  id: string
  name: string
  card: string | null
  model: string | null
  engine: string | null
  state: string
  desiredState: string | null
  health: string | null
  head: DeploymentNode | null
  nodes: DeploymentNode[]
  port: number | null
  router: string | null
  error: string | null
  routerError: string | null
  updatedAt: string | null
}
type Deployments = {
  available: boolean
  error: string | null
  truncated: boolean
  total: number
  deployments: DeploymentRow[]
}
type Issue = {
  level: 'error' | 'warning'
  kind: string
  code: string
  detail: string | null
  subject: string | null
  node: { id: string; name: string } | null
}
type Issues = {
  generatedAt: string
  counts: { error: number; warning: number }
  issues: Issue[]
  machines: number
  deploymentRows: DeploymentRow[]
  sources: {
    catalog: { available: boolean; error: string | null; stale: boolean }
    backends: { available: boolean; truncated?: boolean; error?: string }
    deployments: { available: boolean; total?: number; truncated?: boolean; error?: string }
  }
}
type Finding = { code: string; level: string; subject?: string; detail?: string | null }
type NodeDiagnosis = {
  node: NodeRow
  catalog: { source: Catalog['source']; error: string | null; stale: boolean; observedAt: string | null }
  apps: {
    total: number
    byState: Record<string, number>
    fresh: boolean
    observedAt: string | null
    error: string | null
    failing: { appId: string; version: string; state: string; error: string | null }[]
  } | null
  backends: {
    total: number
    scoped: number
    truncated: boolean
    byState: Record<string, number>
    failing: BackendRow[]
  } | null
  findings: Finding[]
}

/** Every action names one dictionary entry; the record keeps that total. */
const actionLabels: Record<Action, VosOpsKey> = {
  ...hostLabels,
  restart: 'restart', 'stop-container': 'stopContainer',
  'remove-container': 'removeContainer', 'remove-image': 'removeImage',
  'backend-start': 'backendStart', 'backend-stop': 'backendStop',
  'deployment-start': 'deploymentStart', 'deployment-stop': 'deploymentStop',
  'node-rescan': 'nodeRescan', 'node-drain': 'nodeDrain',
  'node-undrain': 'nodeUndrain', 'node-revoke': 'nodeRevoke',
}

function actionLabel(action: Action): VosOpsKey {
  return actionLabels[action]
}

/** One line of `state count` pairs for a diagnosis summary. */
function stateLine(counts: Record<string, number>): string {
  return Object.entries(counts).map(([state, count]) => `${state} ${count}`).join(' · ')
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
    if (failure?.error === 'image-delete-conflict') throw new Error('imageDeleteConflict')
    if (failure?.error === 'confirmation-unavailable') throw new Error('confirmationUnavailable')
    // The scheduler refusing this account is not an expired VOS session, and
    // clearing the grant would send the administrator after the wrong fix.
    if (failure?.error === 'scheduler-forbidden' || failure?.error === 'scheduler-rejected'
        || failure?.error === 'inference-rejected') {
      throw new Error(failure.error === 'scheduler-forbidden' ? 'schedulerForbidden' : 'schedulerFailed')
    }
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
  const [nodes, setNodes] = useState<NodeRow[]>()
  const [node, setNode] = useState('local')
  const [nodeApps, setNodeApps] = useState<NodeApps>()
  const [nodeNote, setNodeNote] = useState<VosOpsKey>()
  const [backends, setBackends] = useState<Backends>()
  const [deployments, setDeployments] = useState<Deployments>()
  const [issues, setIssues] = useState<Issues>()
  const [backendLog, setBackendLog] = useState<{ id: string; text: string }>()
  const [backendFacts, setBackendFacts] = useState<unknown>()
  const [diagnosis, setDiagnosis] = useState<NodeDiagnosis>()
  const run = async (operation: () => Promise<void>) => {
    setBusy(true)
    setMessage(undefined)
    setTask(undefined)
    try {
      await operation()
    } catch (error) {
      const status = error instanceof Error ? error.message : ''
      if (status === 'schedulerForbidden' || status === 'schedulerFailed') {
        setMessage(status)
      } else if (status === '401' || status === '403') {
        setGrant(undefined)
        setInventory(undefined)
        setPreview(undefined)
        setLog(undefined)
        setAppStatus(undefined)
        setDeployments(undefined)
        setIssues(undefined)
        setMessage('forbidden')
      } else {
        setMessage(status === 'targetChanged' || status === 'imageDeleteConflict' ? status : 'failed')
      }
    } finally {
      setBusy(false)
    }
  }
  const loadBackends = async (value: string, id: string) => {
    const query = id === 'local' ? '' : '?node=' + encodeURIComponent(id)
    setBackends(await request<Backends>('backends' + query, value).catch(() => undefined))
  }
  const loadMachines = async (value: string, id: string) => {
    const query = id === 'local' ? '' : '?node=' + encodeURIComponent(id)
    // One round trip each, in parallel: the panel renders these sections
    // together, and the problem list already carries the deployment rows.
    const [catalog, ledger, report] = await Promise.all([
      request<Catalog>('nodes', value),
      request<Backends>('backends' + query, value).catch(() => undefined),
      request<Issues>('issues', value).catch(() => undefined),
    ])
    setNodes(catalog.nodes)
    setNodeNote(catalog.stale ? 'nodeStaleData'
      : catalog.source === 'local-fallback' ? 'nodesNone' : undefined)
    setBackends(ledger)
    setIssues(report)
    setDeployments(report && {
      available: report.sources.deployments.available,
      error: report.sources.deployments.error ?? null,
      truncated: report.sources.deployments.truncated === true,
      total: report.sources.deployments.total ?? 0,
      deployments: report.deploymentRows ?? [],
    })
  }
  const authorize = () => run(async () => {
    const result = await request<{ grant: string }>('authorize', undefined, {})
    setGrant(result.grant)
    setPreview(undefined)
    setLog(undefined)
    setAppStatus(undefined)
    setNode('local')
    setNodeApps(undefined)
    setDiagnosis(undefined)
    await loadMachines(result.grant, 'local')
    setInventory(await request<Inventory>('inventory', result.grant))
  })
  const selectNode = (id: string) => run(async () => {
    setNode(id)
    setPreview(undefined)
    setLog(undefined)
    setAppStatus(undefined)
    setNodeApps(undefined)
    setDiagnosis(undefined)
    if (!grant) return
    await loadBackends(grant, id)
    if (id === 'local') {
      setInventory(await request<Inventory>('inventory', grant))
      return
    }
    setNodeApps(await request<NodeApps>('nodes/apps?node=' + encodeURIComponent(id), grant))
  })
  // A backend that runs on this machine has its own container, so its logs and
  // exit facts are readable here; one on another machine answers not-on-this-machine.
  const readBackendLogs = (id: string) => run(async () => {
    setBackendLog(undefined)
    setBackendLog(await request<{ id: string; text: string }>(
      'backend-logs?id=' + encodeURIComponent(id), grant))
  })
  const diagnoseBackend = (id: string) => run(async () => {
    setBackendFacts(undefined)
    setBackendFacts(await request('backend-diagnose?id=' + encodeURIComponent(id), grant))
  })
  const diagnoseNode = () => run(async () => {
    setDiagnosis(undefined)
    setDiagnosis(await request<NodeDiagnosis>(
      'nodes/diagnose?node=' + encodeURIComponent(node), grant))
  })
  const prepare = (action: Action, id: string) => run(async () => {
    setPreview(undefined)
    setPreview(await request<Preview>('preview', grant, { action, id }))
  })
  const execute = (pending: Preview) => run(async () => {
    setPreview(undefined)
    const result = await request<{ taskId: string | null }>('execute', grant, {
      confirmation: pending.confirmation, targetId: pending.targetId,
    })
    setMessage('accepted')
    if (result.taskId) setTask(result.taskId)
  })
  const pre = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 260, overflow: 'auto' } as const
  const selected = node === 'local' ? undefined : nodes?.find(row => row.id === node)
  const button = (label: VosOpsKey, onClick: () => void) =>
    <button type="button" disabled={busy} onClick={onClick}>{t(label)}</button>

  return <div>
    <p>{t('description')}</p>
    {button('authorize', authorize)}{' '}
    {grant && button('refresh', () => run(async () => {
      setPreview(undefined)
      setDiagnosis(undefined)
      await loadMachines(grant, node)
      if (node === 'local') setInventory(await request<Inventory>('inventory', grant))
      else setNodeApps(await request<NodeApps>('nodes/apps?node=' + encodeURIComponent(node), grant))
    }))}
    {grant && button('close', () => run(async () => {
      await request('close', grant, {})
      setGrant(undefined)
      setInventory(undefined)
      setLog(undefined)
      setAppStatus(undefined)
      setPreview(undefined)
      setDeployments(undefined)
      setIssues(undefined)
      setBackends(undefined)
      setBackendLog(undefined)
      setBackendFacts(undefined)
      setNodes(undefined)
    }))}
    {busy && <p role="status">{t('busy')}</p>}
    {message && <p role="status">{t(message)} {task && <code>{task}</code>}</p>}
    {preview && <section aria-label={t('confirm')}>
      <h3>{t(actionLabel(preview.action))}</h3>
      <p>{t('confirmation')}</p>
      <pre style={pre}>{JSON.stringify(preview.target, null, 2)}</pre>
      {button('confirm', () => void execute(preview))}{' '}
      {button('skip', () => setPreview(undefined))}
    </section>}
    {issues && <section aria-label={t('issues')}>
      <h3>{t('issues')} · {t('issueErrors')} {issues.counts.error} · {t('issueWarnings')} {issues.counts.warning}</h3>
      {/* A register that could not be read is part of the answer, not a reason
          to claim the deployment is clean. */}
      {Object.values(issues.sources).some(source => !source.available) &&
        <p role="status">{t('issuesDegraded')}</p>}
      {!issues.issues.length && <p>{t('issuesNone')}</p>}
      <ul>{issues.issues.map((issue, index) => <li key={index}>
        <code>{issue.code}</code> · {issue.level}
        {issue.node && <> · {issue.node.name}</>}
        {issue.subject && <> · <code>{issue.subject}</code></>}
        {issue.detail && <> · {issue.detail}</>}
      </li>)}</ul>
    </section>}
    {deployments && <section aria-label={t('deployments')}>
      <h3>{t('deployments')}</h3>
      {!deployments.available && <p role="status">{t('deploymentUnavailable')}
        {deployments.error && <> · <code>{deployments.error}</code></>}</p>}
      {deployments.available && deployments.truncated && <p role="status">{t('backendTruncated')}</p>}
      {deployments.available && deployments.deployments.length === 0 && <p>{t('deploymentNone')}</p>}
      <ul>{deployments.deployments.map(row => <li key={row.id}>
        <strong>{row.name}</strong> · {row.state}
        {row.health && <>{' · '}{t('deploymentHealth')} {row.health}</>}
        {row.model && <>{' · '}{t('deploymentModel')} {row.model}</>}
        {row.head && <>{' · '}{t('deploymentNode')} {row.head.name}{row.head.host ? ` (${row.head.host})` : ''}</>}
        {row.router && <>{' · '}{t('deploymentRouter')} {row.router}</>}
        {row.error && <>{' · '}<code>{row.error}</code></>}
        {row.updatedAt && <>{' · '}{t('nodeObserved')} <code>{row.updatedAt}</code></>}
        {/* Repair eligibility mirrors the backend register: start a stopped or
            failed deployment, stop one that is serving or degraded. The gateway
            re-reads the state when the confirmation is applied. */}
        {' '}{['stopped', 'failed'].includes(row.state) &&
          button('deploymentStart', () => prepare('deployment-start', row.id))}
        {['running', 'degraded'].includes(row.state) &&
          button('deploymentStop', () => prepare('deployment-stop', row.id))}
      </li>)}</ul>
    </section>}
    {nodes && <section aria-label={t('nodes')}>
      <h3>{t('nodes')}</h3>
      <p><a href="/#/app/app-drawer/com.ictrek.v-scheduler/nodes" target="_top">{t('schedulerManage')}</a></p>
      <p><a href="/#/app/app-drawer/com.ictrek.image-studio/image-studio" target="_top">{t('imageStudioManage')}</a></p>
      {nodeNote && <p role="status">{t(nodeNote)}</p>}
      {nodes.length > 1
        ? <label>{t('targetNode')}{' '}
          <select value={node} disabled={busy} onChange={event => void selectNode(event.target.value)}>
            {nodes.map(row => <option key={row.id} value={row.id}>
              {(row.local ? t('nodeLocal') : row.name) + ' · ' + row.status + (row.health ? ' · ' + row.health : '')}
            </option>)}
          </select>
        </label>
        : <p>{t('nodeLocal')} · {nodes[0]?.name}</p>}
      {grant && <> {button('nodeDiagnose', diagnoseNode)}</>}
      <ul>{nodes.map(row => <li key={row.id}>
        <strong>{row.local ? t('nodeLocal') : row.name}</strong>
        {' · '}{row.status}
        {/* A managed machine reports no health verdict and no observation, so
            those fields are omitted instead of printing "unknown" twice. */}
        {row.health && <>{' · '}{t('nodeHealth')} {row.health}</>}
        {/* An observation-only machine carries no budget, so it must never read
            as a target that can be drained, revoked or scheduled. */}
        {!row.local && !row.managed && <>{' · '}{t('nodeObservationOnly')}</>}
        {row.fresh !== null && <>{' · '}{row.fresh ? t('nodeFresh') : t('nodeStale')}</>}
        {row.draining && <>{' · '}{t('nodeDraining')}</>}
        {row.arch && <>{' · '}{row.arch}</>}
        {row.gpuModel && <>{' · '}{row.gpuModel}</>}
        {row.profile && <>{' · '}{row.profile}</>}
        {row.observedAt && <>{' · '}{t('nodeObserved')} <code>{row.observedAt}</code></>}
        {/* Machine actions act on the scheduler's own registers: an SSH machine
            can be rescanned, a schedulable node drained, resumed or revoked.
            This machine is not one of them, so it gets no such button. */}
        {!row.local && row.capabilities.includes('rescan') &&
          <> {' '}{button('nodeRescan', () => prepare('node-rescan', row.id))}</>}
        {!row.local && row.managed && <> {' '}{row.draining
          ? button('nodeUndrain', () => prepare('node-undrain', row.id))
          : button('nodeDrain', () => prepare('node-drain', row.id))}
        {' '}{button('nodeRevoke', () => prepare('node-revoke', row.id))}</>}
      </li>)}</ul>
    </section>}
    {diagnosis && <section aria-label={t('nodeFindings')}>
      <h3>{t('nodeFindings')}</h3>
      <p>{diagnosis.node.name || diagnosis.node.id} · {diagnosis.node.status}
        {' · '}{diagnosis.catalog.source}
        {diagnosis.catalog.error && <> · <code>{diagnosis.catalog.error}</code></>}</p>
      <ul>{diagnosis.findings.map((finding, index) => <li key={index}>
        <code>{finding.code}</code> · {finding.level}
        {finding.subject && <> · <code>{finding.subject}</code></>}
        {finding.detail && <> · {finding.detail}</>}
      </li>)}</ul>
      {!diagnosis.findings.length && <p>{t('none')}</p>}
      {diagnosis.apps && <p>{t('nodeApps')}: {stateLine(diagnosis.apps.byState)}</p>}
      {diagnosis.backends && <p>{t('nodeInstanceStates')}: {stateLine(diagnosis.backends.byState)}
        {diagnosis.backends.truncated && <> · {t('backendTruncated')}</>}</p>}
    </section>}
    {node !== 'local' && <section aria-label={t('nodeApps')}>
      <h3>{t('nodeApps')}</h3>
      {/* A machine whose VOS is not collected has no application list at all;
          saying "stale" would imply an earlier one existed. */}
      {selected?.capabilities.includes('apps') !== true
        ? <p>{t('nodeHardwareOnly')}</p>
        : <>
          <p>{t('nodeRemoteOnly')}</p>
          {nodeApps && nodeApps.node === node && (nodeApps.apps.length > 0
            ? <ul>{nodeApps.apps.map(app => <li key={app.appId}>
              <strong>{app.appId}</strong> {app.version} · {app.state}
              {app.error && <> · <code>{app.error}</code></>}
            </li>)}</ul>
            : <p>{nodeApps.fresh ? t('none') : t('nodeStale')}</p>)}
        </>}
    </section>}
    {backends && <section aria-label={t('backends')}>
      <h3>{t('backends')}</h3>
      {!backends.available && <p role="status">{t('backendUnavailable')}</p>}
      {backends.available && backends.truncated && <p role="status">{t('backendTruncated')}</p>}
      {backends.available && backends.backends.length === 0 &&
        <p>{backends.node && backends.node !== 'local' ? t('none') : t('backendNone')}</p>}
      <ul>{backends.backends.map(backend => <li key={backend.id}>
        <strong>{backend.appId}</strong> · {backend.image}
        {' · '}{t('backendState')} {backend.state}
        {backend.endpoint && <>{' · '}{t('backendEndpoint')} <code>{backend.endpoint}</code></>}
        {backend.error && <>{' · '}{t('backendError')} <code>{backend.error}</code></>}
        {' '}{['stopped', 'failed'].includes(backend.state) &&
          button('backendStart', () => prepare('backend-start', backend.id))}
        {['running', 'pending', 'cleanup_failed'].includes(backend.state) &&
          button('backendStop', () => prepare('backend-stop', backend.id))}
        {' '}{button('logs', () => readBackendLogs(backend.id))}
        {button('backendDiagnose', () => diagnoseBackend(backend.id))}
      </li>)}</ul>
      {backendLog && <section aria-label={t('logs')}>
        <code>{backendLog.id}</code> {button('closeFacts', () => setBackendLog(undefined))}
        <pre style={pre}>{backendLog.text || t('none')}</pre>
      </section>}
      {backendFacts !== undefined && <section aria-label={t('backendDiagnose')}>
        {button('closeFacts', () => setBackendFacts(undefined))}
        <pre style={pre}>{JSON.stringify(backendFacts, null, 2)}</pre>
      </section>}
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
        {image.tags.join(', ')} · {(image.bytes / (1024 * 1024)).toFixed(1)} MiB{' '}
        {button('removeImage', () => prepare('remove-image', image.id))}
      </li>)}</ul>
    </>}
  </div>
}

type ConversationProposal = Preview | {
  action: Action
  confirmation: string
  targetIds: string[]
  targets: TargetSummary[]
}

/** Render a server-owned proposal in the active conversation. */
export function VosOpsConfirmation({ t, useSessions }: PropsLocale<'settings.vh-ops'> & PropsRuntime<'shell.overlay'>) {
  const sessionId = useSessions(s => Object.values(s.byId).find(row => (row.retainedBy.mainView ?? 0) > 0)?.id)
  const [hostMode, setHostMode] = useState<{ sessionId: string; enabled: boolean }>()
  const [hostPrompt, setHostPrompt] = useState(false)
  const [hostError, setHostError] = useState(false)
  const [hostBusy, setHostBusy] = useState(false)
  const [pending, setPending] = useState<{ sessionId: string; proposal: ConversationProposal }>()
  const [result, setResult] = useState<{ sessionId: string; message: VosOpsKey; taskId?: string; results?: RemovalResult[] }>()
  const [busy, setBusy] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const settled = useRef<string>(undefined)
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
        const data = await request<{ proposal: ConversationProposal | null }>('proposal?sessionId=' + encodeURIComponent(sessionId))
        if (active) setPending(data.proposal && data.proposal.confirmation !== settled.current
          ? { sessionId, proposal: data.proposal } : undefined)
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

  const settle = async (approved: boolean) => {
    if (!sessionId || !proposal || busy) return
    setBusy(true)
    settled.current = proposal.confirmation
    try {
      const response = await request<{ taskId?: string; results?: RemovalResult[] }>('confirm-proposal?sessionId=' + encodeURIComponent(sessionId),
        undefined, { confirmation: proposal.confirmation, approved, ...(approved ? ('targetIds' in proposal ? { targetIds: proposal.targetIds } : { targetId: proposal.targetId }) : {}) })
      if (approved) setResult({ sessionId, message: 'accepted', ...(response.results ? { results: response.results } : {}), ...(response.taskId ? { taskId: response.taskId } : {}) })
    } catch (error) {
      const code = error instanceof Error ? error.message : ''
      const message = code === 'targetChanged' || code === 'confirmationUnavailable' || code === 'imageDeleteConflict' ? code : 'failed'
      setResult({ sessionId, message })
    } finally {
      setPending(undefined)
      setBusy(false)
    }
  }
  const activeHostMode = hostMode?.sessionId === sessionId ? hostMode : undefined
  // The prompt floats over the conversation. Without an explicit panel it
  // inherits the chat's muted text color and disappears into the background.
  const panel = { background: '#1f2530', color: '#edf0f4', border: '1px solid #414b5c',
    borderRadius: 8, padding: '0.75rem 1rem', boxShadow: '0 6px 24px rgba(0, 0, 0, 0.4)' } as const
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
    {activeHostMode && <aside aria-label={t('hostManagement')} style={{ position: 'fixed', top: '4rem', right: '1rem', zIndex: 10, maxWidth: 'min(24rem, 90vw)' }}>
      {hostPrompt ? <section role="group" aria-label={t('hostManagement')} style={panel}>
        <p style={{ margin: '0 0 0.5rem' }}>{t('hostDescription')}</p>
        <button type="button" disabled={hostBusy} onClick={() => void setHostEnabled(true)}>{t('hostEnable')}</button>{' '}
        <button type="button" disabled={hostBusy} onClick={() => setHostPrompt(false)}>{t('cancel')}</button>
      </section> : <button type="button" disabled={hostBusy} onClick={() => {
        if (activeHostMode.enabled) void setHostEnabled(false)
        else setHostPrompt(true)
      }}>{t(activeHostMode.enabled ? 'hostDisable' : 'hostManagement')}</button>}
      {hostError && <p role="alert" style={panel}>{t('failed')}</p>}
    </aside>}
    {(proposal || outcome) && <dialog ref={dialog} aria-label={t('proposalTitle')} onCancel={(event) => {
      event.preventDefault()
      if (proposal) void settle(false)
      else setResult(undefined)
    }} style={{ maxWidth: 'min(640px, 90vw)', maxHeight: '80vh', overflow: 'auto', padding: '1.25rem' }}>
      <h3>{t('proposalTitle')}</h3>
      {outcome && <p role="status">{t(outcome.message)} {outcome.taskId && <code>{outcome.taskId}</code>}</p>}
      {outcome?.results && <ul>{outcome.results.map(item => <li key={item.id}>
        {t(item.removed ? 'removed' : 'removalFailed')} · <code>{item.id}</code>
        {item.error === 'image-delete-conflict' && <div>{t('imageDeleteConflict')}</div>}
      </li>)}</ul>}
      {proposal ? <section key={proposal.confirmation}>
        <p>{t('pending')}</p>
        <p>{t(actionLabel(proposal.action))}</p>
        <ul aria-label={t('targetList')} style={{ overflowWrap: 'anywhere' }}>
          {('targets' in proposal ? proposal.targets : [proposal.target as TargetSummary]).map((target, index) => {
            const id = 'targetIds' in proposal ? proposal.targetIds[index] : proposal.targetId
            const version = target.stack?.version ?? target.version
            return <li key={id}>
              {target.name && <div>{t('targetName')} · {target.name}</div>}
              {target.image && <div>{t('targetImage')} · {target.image}</div>}
              {!!target.tags?.length && <div>{t('targetImage')} · {target.tags.join(', ')}</div>}
              {version && <div>{t('targetVersion')} · {version}</div>}
              <div>{t('targetIdLabel')} · <code>{id}</code></div>
            </li>
          })}
        </ul>
        <button type="button" disabled={busy} onClick={() => void settle(true)}>{t('confirm')}</button>{' '}
        <button type="button" disabled={busy} onClick={() => void settle(false)}>{t('skip')}</button>
      </section> : <button type="button" onClick={() => setResult(undefined)}>{t('cancel')}</button>}
    </dialog>}
  </>
}
