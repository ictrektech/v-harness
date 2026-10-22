/**
 * The product tool cards: one component per bundled skill tool, each rendering
 * the persisted `presentationMeta` of its result. A card that cannot narrow its
 * metadata falls back to a plain summary row — malformed tool data must never
 * crash a replay.
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  albumAlbums, albumPerson, albumPhotos, albumUpload, imageStudio,
} from './meta.ts'
import type { NS } from './locales.ts'
import css from './Cards.module.css'

/** The workspace file-read face this plugin uses; satisfied by the Host remote. */
interface WorkspaceFileReader {
  readBytes(sessionId: unknown, path: string, params: Record<string, never>, signal?: AbortSignal): Promise<unknown>
}

/** The workspace-files remote, captured at registration and injected per call. */
export interface CardsInjected {
  readonly workspaceFiles: WorkspaceFileReader
}

type CardProps = ToolCallViewProps & PropsLocale<typeof NS> & CardsInjected

/** The settled block a result-side card renders. */
type ResultProps = CardProps & { readonly block: ToolResultNode }

/** One workspace thumbnail turned into an <img> through the file-read remote. */
function WorkspaceImage(props: {
  sessionId: CardProps['sessionId']
  cwd: CardProps['cwd']
  path: string
  workspaceFiles: WorkspaceFileReader
  alt: string
  onOpen: () => void
}) {
  const [url, setUrl] = useState<string>()

  useEffect(() => {
    const controller = new AbortController()
    let objectUrl: string | undefined
    const path = props.path
    const cwd = props.cwd
    const relative = cwd !== undefined && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path
    props.workspaceFiles.readBytes(props.sessionId, relative, {}, controller.signal).then((file) => {
      const bytes = (file as { data?: Uint8Array }).data ?? file
      objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/jpeg' }))
      setUrl(objectUrl)
    }).catch(() => {
      // A missing thumbnail degrades that cell to a plain button; the grid stays.
    })
    return () => {
      controller.abort()
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl)
    }
  }, [props.cwd, props.path, props.sessionId, props.workspaceFiles])

  return <button type="button" className={css.thumb} onClick={props.onOpen} aria-label={props.alt}>
    {url === undefined
      ? <span className={css.thumbPending}>{props.alt}</span>
      : <img className={css.thumbImage} src={url} alt={props.alt} loading="lazy" />}
  </button>
}

function formatBytes(size: number): string {
  if (size >= 1_048_576) return `${(size / 1_048_576).toFixed(1)} MB`
  if (size >= 1024) return `${Math.round(size / 1024)} KB`
  return `${size} B`
}

/** The row every card shows while its call runs. */
function RunningCard(props: CardProps) {
  return <div className={css.card} data-tool-card={props.toolName} data-state="running">
    <div className={css.header}><span className={css.title}>{props.t('card.running')}</span></div>
  </div>
}

/** The row a card shows when its metadata does not fit the tool. */
function UnavailableCard(props: ResultProps) {
  return <div className={css.card} data-tool-card={props.toolName} data-state="generic">
    <div className={css.header}>
      <span className={css.title}>{props.toolName}</span>
    </div>
  </div>
}

function CardShell(props: {
  title: string
  meta?: string | undefined
  children: ReactNode
  footer?: ReactNode
  toolName: string
}) {
  return <div className={css.card} data-tool-card={props.toolName} data-state="ok">
    <div className={css.header}>
      <span className={css.title}>{props.title}</span>
      {props.meta === undefined ? null : <span className={css.meta}>{props.meta}</span>}
    </div>
    {props.children}
    {props.footer === undefined ? null : <div className={css.footer}>{props.footer}</div>}
  </div>
}

/** Image extensions the result card renders inline; anything else stays a file row. */
const IMAGE_FILE = /\.(png|jpe?g|webp|gif)$/iu

/** `image_studio_generate`: the rendered image itself, plus the seed to reproduce it. */
function ImageStudioCard(props: ResultProps) {
  const model = imageStudio(props.block.meta)
  if (model === null) return <UnavailableCard {...props} />
  const images = model.files.filter(file => IMAGE_FILE.test(file.filename))
  const others = model.files.filter(file => !IMAGE_FILE.test(file.filename))
  return <CardShell
    toolName={props.toolName}
    title={props.t('image.studioTitle')}
    meta={model.seed < 0 ? undefined : props.t('image.studioSeed', { seed: model.seed })}
  >
    {images.length === 0 ? null : <div className={css.grid}>
      {images.map(file => <WorkspaceImage key={file.path}
        sessionId={props.sessionId} cwd={props.cwd} path={file.path}
        workspaceFiles={props.workspaceFiles} alt={file.filename}
        onOpen={() => { props.openFile(file.path) }} />)}
    </div>}
    {others.length === 0 ? null : <div className={css.rows}>
      {others.map(file => <div key={file.path} className={css.docRow}>
        <span className={css.docIcon}>{file.filename.split('.').pop()?.toUpperCase() ?? '?'}</span>
        <span className={css.docBody}>
          <span className={css.docName}>{file.filename}</span>
          <span className={css.docMeta}>{formatBytes(file.bytes)}</span>
        </span>
      </div>)}
    </div>}
    <div className={css.footer}>{props.t('image.studioHint')}</div>
  </CardShell>
}

/** `album_search` / `album_photos`: the photo grid with per-photo zoom. */
function AlbumPhotosCard(props: ResultProps) {
  const model = albumPhotos(props.block.meta)
  if (model === null) return <UnavailableCard {...props} />
  const title = model.kind === 'album.search' ? props.t('album.searchTitle') : props.t('album.photosTitle')
  const metaRecord = props.block.meta as Record<string, unknown>
  const query = typeof metaRecord.query === 'string' && metaRecord.query !== ''
    ? props.t('album.query', { query: metaRecord.query })
    : undefined
  return <CardShell toolName={props.toolName} title={title} meta={[query, props.t('album.total', { total: model.total })].filter(Boolean).join(' · ')}>
    <div className={css.grid}>
      {model.photos.map(photo => <WorkspaceImage key={photo.id}
        sessionId={props.sessionId} cwd={props.cwd} path={photo.thumbPath}
        workspaceFiles={props.workspaceFiles}
        alt={photo.city === '' ? photo.filename : `${photo.filename} · ${photo.city}`}
        onOpen={() => { props.openFile(photo.thumbPath) }} />)}
    </div>
    <div className={css.footer}>{props.t('album.viewHint')} {props.t('album.moreAfterGrid')}</div>
  </CardShell>
}

/** `album_person`: resolved people with their photo counts. */
function AlbumPersonCard(props: ResultProps) {
  const model = albumPerson(props.block.meta)
  if (model === null) return <UnavailableCard {...props} />
  return <CardShell toolName={props.toolName} title={props.t('album.personTitle')} meta={model.name}>
    <div className={css.rows}>
      {model.people.map(person => <div key={person.id} className={css.docRow}>
        <span className={css.docBody}>
          <span className={css.docName}>{person.name}</span>
          <span className={css.docMeta}>{props.t('album.personAssets', { assets: person.assets })}</span>
        </span>
      </div>)}
    </div>
    <div className={css.footer}>{props.t('album.personHint', { name: model.name })}</div>
  </CardShell>
}

/** `album_albums`: the album list. */
function AlbumAlbumsCard(props: ResultProps) {
  const model = albumAlbums(props.block.meta)
  if (model === null) return <UnavailableCard {...props} />
  return <CardShell toolName={props.toolName} title={props.t('album.albumsTitle')}>
    <div className={css.rows}>
      {model.albums.map(album => <div key={album.id} className={css.docRow}>
        <span className={css.docBody}>
          <span className={css.docName}>{album.name}</span>
          <span className={css.docMeta}>{props.t('album.albumsAssets', { assets: album.assets })}</span>
        </span>
      </div>)}
    </div>
    <div className={css.footer}>{props.t('album.albumsHint')}</div>
  </CardShell>
}

/** `album_upload`: saved receipt, including the deduplicated case. */
function AlbumUploadCard(props: ResultProps) {
  const model = albumUpload(props.block.meta)
  if (model === null) return <UnavailableCard {...props} />
  return <CardShell toolName={props.toolName} title={props.t('album.uploadTitle')} meta={model.name}>
    {model.duplicate ? <div className={css.warn}>{props.t('album.uploadDuplicate')}</div> : null}
    <div className={css.footer}>{props.t('album.uploadHint')}</div>
  </CardShell>
}

/** The tool name each card claims; unknown names never reach this component. */
const CARDS: Readonly<Record<string, (props: ResultProps) => ReactNode>> = {
  image_studio_generate: ImageStudioCard,
  album_search: AlbumPhotosCard,
  album_photos: AlbumPhotosCard,
  album_person: AlbumPersonCard,
  album_albums: AlbumAlbumsCard,
  album_upload: AlbumUploadCard,
}

/** The keyed card for every bundled product tool call. */
function ProductToolCard(props: CardProps) {
  if (props.phase !== 'result') return <RunningCard {...props} />
  const card = CARDS[props.toolName]
  if (card === undefined) return <UnavailableCard {...props} />
  return card({ ...props, block: props.block })
}

export { ProductToolCard }
