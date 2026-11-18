/** Copy for the shipped-skill switches in VOS settings. */

export type SkillTogglesKey =
  | 'title' | 'description' | 'services' | 'tools' | 'empty' | 'loading' | 'failed' | 'saveFailed'

export const skillTogglesEn = {
  title: 'Product skills',
  description: 'A skill switched off here leaves the Agent\'s catalog for this account only. Its files stay on disk, and switching it back takes effect immediately.',
  services: 'VOS services',
  tools: 'Authoring tools',
  empty: 'Nothing to manage yet.',
  loading: 'Loading skills…',
  failed: 'Could not load the skill list. Reopen this section to retry.',
  saveFailed: 'The change was not saved. Check the connection and try again.',
} satisfies Record<SkillTogglesKey, string>

export const skillTogglesZh: Record<keyof typeof skillTogglesEn, string> = {
  title: '产品技能',
  description: '在这里关闭的技能只会从当前账户的 Agent 技能列表里移除，文件仍保留在磁盘上；重新打开立即生效。',
  services: 'VOS 服务',
  tools: '创作工具',
  empty: '暂无可管理的技能。',
  loading: '正在加载技能…',
  failed: '无法加载技能列表，请重新打开此页面重试。',
  saveFailed: '改动未保存。请检查连接后重试。',
}
