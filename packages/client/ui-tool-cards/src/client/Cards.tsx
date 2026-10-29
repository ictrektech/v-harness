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
import { imageStudio } from './meta.ts'
import type { NS } from './locales.ts'
import css from './Cards.module.css'

/** The workspace file-read face this plugin uses; satisfied by the Host remote. */
interface WorkspaceFileReader {
  readBytes(
    sessionId: unknown,
    path: string,
    params: Record<string, never>,
    signal?: AbortSignal,
  ): Promise<{ ok: true; value: { data: Uint8Array } } | { ok: false; error: unknown }>
}

/** The workspace-files remote, captured at registration and injected per call. */
export interface CardsInjected {
  readonly workspaceFiles: WorkspaceFileReader
}

type CardProps = ToolCallViewProps & PropsLocale<typeof NS> & CardsInjected

/** The settled block a result-side card renders. */
type ResultProps = CardProps & { readonly block: ToolResultNode }

/** One workspace image turned into an <img> through the file-read remote. */
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
      // The Remote answers in a result envelope; the bytes live in `value.data`.
      if (!file.ok) throw new Error('workspace file read failed')
      // Copy into an ArrayBuffer-backed view: the wire type allows any buffer.
      objectUrl = URL.createObjectURL(new Blob([new Uint8Array(file.value.data)], { type: imageTypeOf(path) }))
      setUrl(objectUrl)
    }).catch(() => {
      // A missing image degrades that cell to a plain button; the grid stays.
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

/** The MIME type a blob needs so the browser renders the file as an image. */
function imageTypeOf(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase() ?? ''
  if (extension === 'png') return 'image/png'
  if (extension === 'webp') return 'image/webp'
  if (extension === 'gif') return 'image/gif'
  return 'image/jpeg'
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

/** The tool name each card claims; unknown names never reach this component. */
const CARDS: Readonly<Record<string, (props: ResultProps) => ReactNode>> = {
  image_studio_generate: ImageStudioCard,
}

/** The keyed card for every bundled product tool call. */
function ProductToolCard(props: CardProps) {
  if (props.phase !== 'result') return <RunningCard {...props} />
  const card = CARDS[props.toolName]
  if (card === undefined) return <UnavailableCard {...props} />
  return card({ ...props, block: props.block })
}

export { ProductToolCard }
