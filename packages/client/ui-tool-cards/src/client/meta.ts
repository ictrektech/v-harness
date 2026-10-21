/**
 * Narrow the persisted `presentationMeta` of the product tool calls into the
 * card models. Every field arrives unvalidated on replay: a missing key, a
 * malformed row, or a foreign kind declines to null and the card falls back to
 * the generic summary row — a partial grid must never render.
 */

/** One V-Office document row. */
export interface VofficeFileMeta {
  readonly name: string
  readonly size: number
  readonly modified: number
  readonly viewUrl?: string
}

/** One album photo row. */
export interface AlbumPhotoMeta {
  readonly id: string
  readonly filename: string
  readonly takenAt: string
  readonly city: string
  readonly type: string
  readonly favorite: boolean
  readonly thumbPath: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function kindOf(meta: unknown): string | null {
  if (!isRecord(meta)) return null
  const kind = meta.kind
  return typeof kind === 'string' && kind !== '' ? kind : null
}

/** The array behind a key, or null when the key is absent or not an array. */
function rowsOf(meta: Record<string, unknown>, key: string): readonly Record<string, unknown>[] | null {
  if (!Array.isArray(meta[key])) return null
  return meta[key].filter(isRecord).length === meta[key].length ? meta[key] as Record<string, unknown>[] : null
}

/** Narrow `voffice.list` metadata. */
export function vofficeList(meta: unknown): { total: number; files: readonly VofficeFileMeta[] } | null {
  if (kindOf(meta) !== 'voffice.list' || !isRecord(meta)) return null
  const rows = rowsOf(meta, 'files')
  if (rows === null) return null
  const files: VofficeFileMeta[] = []
  for (const row of rows) {
    const viewUrl = typeof row.viewUrl === 'string' && row.viewUrl !== '' ? row.viewUrl : undefined
    if (typeof row.name !== 'string' || row.name === '') return null
    files.push({
      name: row.name,
      size: num(row.size),
      modified: num(row.modified),
      ...viewUrl === undefined ? {} : { viewUrl },
    })
  }
  return { total: num(meta.total) || files.length, files }
}

/** Narrow `voffice.open` metadata. */
export function vofficeOpen(meta: unknown): {
  name: string
  url: string
  canWrite: boolean
  expiresIn: number
} | null {
  if (kindOf(meta) !== 'voffice.open' || !isRecord(meta)) return null
  const url = str(meta.url)
  if (url === '') return null
  return {
    name: str(meta.name),
    url,
    canWrite: meta.canWrite !== false,
    expiresIn: num(meta.expiresIn) || 3600,
  }
}

/** Narrow `voffice.rename` metadata. */
export function vofficeRename(meta: unknown): { from: string; to: string } | null {
  if (kindOf(meta) !== 'voffice.rename' || !isRecord(meta)) return null
  const from = str(meta.from)
  const to = str(meta.to)
  return from === '' || to === '' ? null : { from, to }
}

/** Narrow `voffice.upload` metadata. */
export function vofficeUpload(meta: unknown): { name: string; size: number } | null {
  if (kindOf(meta) !== 'voffice.upload' || !isRecord(meta)) return null
  const name = str(meta.name)
  return name === '' ? null : { name, size: num(meta.size) }
}

/** Narrow `album.search` / `album.photos` metadata. */
export function albumPhotos(meta: unknown): {
  kind: 'album.search' | 'album.photos'
  total: number
  photos: readonly AlbumPhotoMeta[]
} | null {
  const kind = kindOf(meta)
  if ((kind !== 'album.search' && kind !== 'album.photos') || !isRecord(meta)) return null
  const rows = rowsOf(meta, 'photos')
  if (rows === null) return null
  const photos: AlbumPhotoMeta[] = []
  for (const row of rows) {
    if (typeof row.id !== 'string' || row.id === '') return null
    if (typeof row.thumbPath !== 'string' || row.thumbPath === '') return null
    photos.push({
      id: row.id,
      filename: str(row.filename),
      takenAt: str(row.takenAt),
      city: str(row.city),
      type: str(row.type) || 'image',
      favorite: row.favorite === true,
      thumbPath: row.thumbPath,
    })
  }
  return { kind, total: num(meta.total) || photos.length, photos }
}

/** Narrow `album.person` metadata. */
export function albumPerson(meta: unknown): {
  name: string
  people: readonly { id: string; name: string; assets: number }[]
} | null {
  if (kindOf(meta) !== 'album.person' || !isRecord(meta)) return null
  const rows = rowsOf(meta, 'people')
  if (rows === null) return null
  const people: { id: string; name: string; assets: number }[] = []
  for (const row of rows) {
    if (typeof row.id !== 'string' || row.id === '' || typeof row.name !== 'string' || row.name === '') return null
    people.push({ id: row.id, name: row.name, assets: num(row.assets) })
  }
  return { name: str(meta.name), people }
}

/** Narrow `album.albums` metadata. */
export function albumAlbums(meta: unknown): {
  albums: readonly { id: string; name: string; assets: number }[]
} | null {
  if (kindOf(meta) !== 'album.albums' || !isRecord(meta)) return null
  const rows = rowsOf(meta, 'albums')
  if (rows === null) return null
  const albums: { id: string; name: string; assets: number }[] = []
  for (const row of rows) {
    if (typeof row.id !== 'string' || row.id === '' || typeof row.name !== 'string' || row.name === '') return null
    albums.push({ id: row.id, name: row.name, assets: num(row.assets) })
  }
  return { albums }
}

/** Narrow `album.upload` metadata. */
export function albumUpload(meta: unknown): {
  id: string
  name: string
  duplicate: boolean
  album?: string
} | null {
  if (kindOf(meta) !== 'album.upload' || !isRecord(meta)) return null
  const id = str(meta.id)
  const name = str(meta.name)
  if (id === '' || name === '') return null
  return {
    id,
    name,
    duplicate: meta.duplicate === true,
    ...typeof meta.album === 'string' && meta.album !== '' ? { album: meta.album } : {},
  }
}
