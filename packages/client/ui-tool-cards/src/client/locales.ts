/** `toolCards` namespace dictionaries for the product tool cards. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'toolCards'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'card.running': '正在处理',
  'card.unavailable': '此结果的交互卡片不可用',
  'album.searchTitle': '相册搜索',
  'album.photosTitle': '相册照片',
  'album.total': '共 {total} 张',
  'album.query': '「{query}」',
  'album.moreAfterGrid': '还有更多，加条件（时间/地点/人物/相册）继续找',
  'album.viewHint': '点缩略图可在右侧放大查看原图',
  'album.personTitle': '人物',
  'album.personAssets': '{assets} 张照片',
  'album.personHint': '要用照片 id 继续筛选，可说「看 {name} 去年的照片」',
  'album.albumsTitle': '相册',
  'album.albumsAssets': '{assets} 张',
  'album.albumsHint': '把照片加进相册：直接说「把这几张加进某某相册」',
  'album.uploadTitle': '已存入相册',
  'album.uploadDuplicate': '相册里已有相同内容，未重复保存',
  'album.uploadHint': '原图不受影响；可以继续挑选或让我加工',
  'album.openOriginal': '查看原图',
  'voffice.listTitle': 'V-Office 文档',
  'voffice.listTotal': '共 {total} 份',
  'voffice.open': '打开',
  'voffice.renameHint': '重命名：直接说「把《{name}》改名为 …」',
  'voffice.listHint': '点文件名可在线预览；要编辑哪份，跟我说名字',
  'voffice.openTitle': '在线编辑',
  'voffice.openReadonly': '在线查看（只读）',
  'voffice.openWrite': '进入在线编辑',
  'voffice.openSaveNote': '在编辑器里保存会直接写回云端这份文档',
  'voffice.openExpiry': '链接 {minutes} 分钟内有效，过期或打不开就再让我开一条',
  'voffice.renameTitle': '已重命名',
  'voffice.renameWarn': '编辑链接跟文件名走：编辑器里还开着旧名字这份的话，重新点一次打开即可，内容不会丢',
  'voffice.uploadTitle': '已存入 V-Office',
  'voffice.uploadHint': '要在线编辑这份文档，跟我说「打开 {name}」',
} satisfies Record<string, string>

/** The toolCards namespace key union. */
export type ToolCardsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'card.running': 'Working',
  'card.unavailable': 'The interactive card for this result is unavailable',
  'album.searchTitle': 'Album search',
  'album.photosTitle': 'Album photos',
  'album.total': '{total} photos',
  'album.query': '"{query}"',
  'album.moreAfterGrid': 'More results — narrow by time, place, people, or album',
  'album.viewHint': 'Click a thumbnail to zoom the original in the side panel',
  'album.personTitle': 'People',
  'album.personAssets': '{assets} photos',
  'album.personHint': 'To filter further, ask e.g. "show {name}\'s photos from last year"',
  'album.albumsTitle': 'Albums',
  'album.albumsAssets': '{assets} photos',
  'album.albumsHint': 'Add photos to an album: say "put these into the album …"',
  'album.uploadTitle': 'Saved to the album',
  'album.uploadDuplicate': 'Identical content already exists; nothing was duplicated',
  'album.uploadHint': 'Originals are untouched; keep picking photos or ask me to rework one',
  'album.openOriginal': 'View original',
  'voffice.listTitle': 'V-Office documents',
  'voffice.listTotal': '{total} documents',
  'voffice.open': 'Open',
  'voffice.renameHint': 'Rename: say "rename {name} to …"',
  'voffice.listHint': 'Click a file name to preview online; tell me which one to edit',
  'voffice.openTitle': 'Online editing',
  'voffice.openReadonly': 'Online view (read-only)',
  'voffice.openWrite': 'Open in the online editor',
  'voffice.openSaveNote': 'Saving inside the editor writes straight back to this cloud document',
  'voffice.openExpiry': 'The link stays valid for {minutes} minutes; when it expires just ask me for a new one',
  'voffice.renameTitle': 'Renamed',
  'voffice.renameWarn': 'Editor links follow the file name: if an editor still has the old name open, open it once more — nothing is lost',
  'voffice.uploadTitle': 'Saved to V-Office',
  'voffice.uploadHint': 'To edit this document online, say "open {name}"',
} satisfies Record<string, string>
