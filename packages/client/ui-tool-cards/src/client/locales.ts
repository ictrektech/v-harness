/** `toolCards` namespace dictionaries for the product tool cards. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'toolCards'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'card.running': '正在处理',
  'card.unavailable': '此结果的交互卡片不可用',
  'image.studioTitle': '生成结果',
  'image.studioSeed': '种子 {seed}',
  'image.studioHint': '图片已存到工作区，点开可看大图；这个种子能原样复现同一张',
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
} satisfies Record<string, string>

/** The toolCards namespace key union. */
export type ToolCardsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'card.running': 'Working',
  'card.unavailable': 'The interactive card for this result is unavailable',
  'image.studioTitle': 'Generated',
  'image.studioSeed': 'seed {seed}',
  'image.studioHint': 'Saved to the workspace — open it for the full size; the seed reproduces this exact image',
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
} satisfies Record<string, string>
