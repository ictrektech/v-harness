/**
 * `uiServices` namespace dictionaries, and the namespace's declaration.
 *
 * The namespace merge lives with its key set so that any module naming
 * `TranslateNS<'uiServices'>` or `PropsLocale<'uiServices'>` needs only this
 * file, whichever entry a program loads first.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Services tab type name, guide entry, row states, and failure lines. */
    uiServices: UiServicesKey
  }
}

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  'shortcut.noSession': '请先选择会话',
  'type.label': '服务',
  'guide.title': '我的服务',
  'guide.description': '查看并打开你在环境里启动的 Web 服务',
  loading: '正在读取…',
  empty: '还没有登记服务。在终端里运行：vh-service run --name 我的应用 --port 3004 -- 你的启动命令',
  running: '运行中',
  stopped: '已停止',
  open: '打开',
  restart: '重启',
  stop: '停止',
  restarting: '重启中…',
  stopping: '停止中…',
  'error.unavailable': '读取失败：{message}',
  'action.failed': '操作失败：{message}',
} satisfies Record<string, string>

/** Services dictionary key union. */
export type UiServicesKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  'shortcut.noSession': 'Select a session first',
  'type.label': 'Services',
  'guide.title': 'My services',
  'guide.description': 'See and open the web services you started in this environment',
  loading: 'Reading…',
  empty: 'No services registered yet. Run in a terminal: vh-service run --name myapp --port 3004 -- your-command',
  running: 'Running',
  stopped: 'Stopped',
  open: 'Open',
  restart: 'Restart',
  stop: 'Stop',
  restarting: 'Restarting…',
  stopping: 'Stopping…',
  'error.unavailable': 'Read failed: {message}',
  'action.failed': 'Action failed: {message}',
} satisfies Record<UiServicesKey, string>
