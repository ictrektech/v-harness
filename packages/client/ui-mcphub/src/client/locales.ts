/**
 * `mcphub` namespace dictionaries, and the namespace's declaration.
 *
 * The namespace merge lives with its key set so that any module naming
 * `TranslateNS<'mcphub'>` or `PropsLocale<'mcphub'>` needs only this file,
 * whichever entry a program loads first.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** MCPHub panel title, states, row labels, tool preview and selection copy. */
    mcphub: McphubKey
  }
}

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  panel: 'MCPHUB服务',
  title: 'MCPHub 服务',
  description: '这里列出 MCPHub 中你有权使用的服务，Agent 通过 MCPHub 调用它们。',
  refresh: '刷新',
  manage: '打开 MCPHub',
  loading: '正在读取…',
  empty: 'MCPHub 里还没有你可用的服务',
  emptyHint: '在 MCPHub 中创建服务，或让管理员把服务共享给你。',
  count: '共 {count} 个服务',
  unauthorized: 'VOS 登录状态已失效，请刷新页面后重试',
  unauthorizedHint: '面板不会缓存服务列表，刷新后会重新向 MCPHub 读取。',
  unavailable: 'MCPHub 未安装或暂不可达',
  failed: '读取失败：{message}',
  'visibility.private': '私有',
  'visibility.public': '公开',
  'visibility.group': '共享',
  'visibility.unknown': '未知范围',
  'status.running': '运行中',
  'status.stopped': '已停止',
  'status.connecting': '连接中',
  'status.oauthRequired': '待授权',
  'status.unknown': '未知状态',
  'routing.all': '全部服务',
  'routing.smart': '智能路由',
  'routing.unknown': '未知路由',
  'tools.show': '工具',
  'tools.hide': '收起',
  'tools.loading': '正在读取工具…',
  'tools.empty': '该服务没有提供工具',
  'tools.disabled': '已停用',
  'tools.failed': '工具读取失败：{message}',
  'selection.title': 'Agent 挂载方式',
  'selection.all': '全部服务',
  'selection.some': '仅选中的服务',
  'selection.pick': '加入 Agent',
  'selection.save': '保存选择',
  'selection.saved': '已保存，重启工作区后生效',
  'selection.failed': '保存失败：{message}',
  'selection.hint': '选择在下一次启动工作区时生效。',
  'action.start': '启用',
  'action.stop': '停用',
  'action.reload': '重载',
  'action.working': '处理中…',
  'action.failed': '操作失败：{message}',
  'action.hint': '启停与重载作用于 MCPHub 的共享连接，对该服务的所有使用者立即生效。',
} satisfies Record<string, string>

/** MCPHub panel dictionary key union. */
export type McphubKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  panel: 'MCPHUB services',
  title: 'MCPHub services',
  description: 'The services you may use in MCPHub. The Agent calls them through MCPHub.',
  refresh: 'Refresh',
  manage: 'Open MCPHub',
  loading: 'Reading…',
  empty: 'No services are available to you in MCPHub yet',
  emptyHint: 'Create a service in MCPHub, or ask an administrator to share one with you.',
  count: '{count} services',
  unauthorized: 'Your VOS sign-in has expired. Reload the page and try again',
  unauthorizedHint: 'The panel caches nothing; reloading reads the list from MCPHub again.',
  unavailable: 'MCPHub is not installed or cannot be reached',
  failed: 'Read failed: {message}',
  'visibility.private': 'Private',
  'visibility.public': 'Public',
  'visibility.group': 'Shared',
  'visibility.unknown': 'Unknown scope',
  'status.running': 'Running',
  'status.stopped': 'Stopped',
  'status.connecting': 'Connecting',
  'status.oauthRequired': 'Sign-in required',
  'status.unknown': 'Unknown state',
  'routing.all': 'Every service',
  'routing.smart': 'Smart routing',
  'routing.unknown': 'Unknown routing',
  'tools.show': 'Tools',
  'tools.hide': 'Hide',
  'tools.loading': 'Reading tools…',
  'tools.empty': 'This service exposes no tools',
  'tools.disabled': 'Disabled',
  'tools.failed': 'Could not read tools: {message}',
  'selection.title': 'What the Agent mounts',
  'selection.all': 'Every service',
  'selection.some': 'Selected services only',
  'selection.pick': 'Give to the Agent',
  'selection.save': 'Save choice',
  'selection.saved': 'Saved. Restart the workspace to apply it',
  'selection.failed': 'Could not save: {message}',
  'selection.hint': 'The choice applies the next time the workspace starts.',
  'action.start': 'Start',
  'action.stop': 'Stop',
  'action.reload': 'Reload',
  'action.working': 'Working…',
  'action.failed': 'Action failed: {message}',
  'action.hint': 'Start, stop and reload act on the shared connection in MCPHub; every user of the service sees the change at once.',
} satisfies Record<McphubKey, string>
