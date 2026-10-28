/**
 * Narrow the persisted `presentationMeta` of the product tool calls into the
 * card models. Every field arrives unvalidated on replay: a missing key, a
 * malformed row, or a foreign kind declines to null and the card falls back to
 * the generic summary row.
 */

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
