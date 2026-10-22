/**
 * Narrow the persisted `presentationMeta` of the product tool calls into the
 * card models. Every field arrives unvalidated on replay: a missing key, a
 * malformed row, or a foreign kind declines to null and the card falls back to
 * the generic summary row — a partial grid must never render.
 */

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

/** One file an Image Studio job produced. */
export interface ImageStudioFileMeta {
  readonly path: string
  readonly filename: string
  readonly bytes: number
}

/** Narrow `image.studio` metadata. */
export function imageStudio(meta: unknown): {
  jobId: string
  status: string
  seed: number
  files: readonly ImageStudioFileMeta[]
} | null {
  if (kindOf(meta) !== 'image.studio' || !isRecord(meta)) return null
  const rows = rowsOf(meta, 'files')
  if (rows === null) return null
  const files: ImageStudioFileMeta[] = []
  for (const row of rows) {
    const path = str(row.path)
    if (path === '') return null
    files.push({ path, filename: str(row.filename), bytes: num(row.bytes) })
  }
  return { jobId: str(meta.job_id), status: str(meta.status), seed: num(meta.seed), files }
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
