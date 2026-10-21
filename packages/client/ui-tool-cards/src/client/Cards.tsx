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
  albumAlbums, albumPerson, albumPhotos, albumUpload,
  vofficeList, vofficeOpen, vofficeRename, vofficeUpload,
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

function formatTime(epochSeconds: number): string {
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return ''
  const date = new Date(epochSeconds * 1000)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
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
  meta?: string
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

/** `voffice_list`: document rows with per-document preview links. */
function VofficeListCard(props: ResultProps) {
  const model = vofficeList(props.block.meta)
  if (model === null) return <UnavailableCard {...props} />
  return <CardShell toolName={props.toolName} title={props.t('voffice.listTitle')} meta={props.t('voffice.listTotal', { total: model.total })}>
    <div className={css.rows}>
      {model.files.map(file => <div key={file.name} className={css.docRow}>
        <span className={css.docIcon}>{file.name.split('.').pop()?.toUpperCase() ?? '?'}</span>
        <span className={css.docBody}>
          {file.viewUrl === undefined
            ? <span className={css.docName}>{file.name}</span>
            : <a className={css.docLink} href={file.viewUrl} target="_blank" rel="noreferrer">{file.name}</a>}
          <span className={css.docMeta}>{formatTime(file.modified)} · {formatBytes(file.size)}</span>
        </span>
        {file.viewUrl === undefined ? null : <a className={css.action} href={file.viewUrl} target="_blank" rel="noreferrer">{props.t('voffice.open')}</a>}
      </div>)}
    </div>
    <div className={css.footer}>{props.t('voffice.listHint')}</div>
  </CardShell>
}

/** `voffice_open`: the online-editor link card. */
function VofficeOpenCard(props: ResultProps) {
  const model = vofficeOpen(props.block.meta)
  if (model === null) return <UnavailableCard {...props} />
  return <CardShell toolName={props.toolName} title={model.canWrite ? props.t('voffice.openTitle') : props.t('voffice.openReadonly')} meta={model.name}>
    <div className={css.body}>
      {model.canWrite ? <div className={css.line}>{props.t('voffice.openSaveNote')}</div> : null}
    </div>
    <a className={css.button} href={model.url} target="_blank" rel="noreferrer">
      {model.canWrite ? props.t('voffice.openWrite') : props.t('voffice.openReadonly')}
    </a>
    <div className={css.footer}>{props.t('voffice.openExpiry', { minutes: Math.round(model.expiresIn / 60) })}</div>
  </CardShell>
}

/** `voffice_rename`: old name struck through, new name beside it. */
function VofficeRenameCard(props: ResultProps) {
  const model = vofficeRename(props.block.meta)
  if (model === null) return <UnavailableCard {...props} />
  return <CardShell toolName={props.toolName} title={props.t('voffice.renameTitle')}>
    <div className={css.body}>
      <div className={css.rename}>
        <span className={css.oldName}>{model.from}</span>
        <span className={css.newName}>{model.to}</span>
      </div>
    </div>
    <div className={css.warn}>{props.t('voffice.renameWarn')}</div>
  </CardShell>
}

/** `voffice_upload`: saved receipt. */
function VofficeUploadCard(props: ResultProps) {
  const model = vofficeUpload(props.block.meta)
  if (model === null) return <UnavailableCard {...props} />
  return <CardShell toolName={props.toolName} title={props.t('voffice.uploadTitle')} meta={model.name}>
    <div className={css.footer}>{props.t('voffice.uploadHint', { name: model.name })}</div>
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
  voffice_list: VofficeListCard,
  voffice_open: VofficeOpenCard,
  voffice_rename: VofficeRenameCard,
  voffice_upload: VofficeUploadCard,
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
