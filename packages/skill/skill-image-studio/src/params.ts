/**
 * The generation-parameter form: fields the human confirms, the values read
 * back out of the answer, and the CLI flags they become.
 */

import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'

/** One catalog entry the form offers as a model choice. */
export interface CatalogEntry {
  readonly key: string
  readonly capabilities?: readonly string[]
  /** What the service will apply when a field is left empty; the form shows these. */
  readonly runtime?: {
    readonly mode?: string
    readonly defaults?: Readonly<Record<string, string | number>>
  }
}

/** Starting values the model supplied before the human confirmed them. */
export interface RequestedParameters {
  prompt: string
  model_key?: string
  negative_prompt?: string
}

/** Values the human accepted, in the units the CLI takes. */
export interface ConfirmedParameters {
  modelKey: string
  prompt: string
  negativePrompt?: string
  width?: number
  height?: number
  steps?: number
  cfgScale?: number
  sampler?: string
  seed?: number
}

/**
 * Read one answered field as text.
 * @param answers - the human's answer batch.
 * @param id - field id.
 * @returns The chosen option label, else the typed text, else an empty string.
 */
function answerText(answers: AskUserQuestionAnswer, id: string): string {
  const answer = answers.answers.find(item => item.id === id)
  if (answer === undefined) return ''
  return answer.selected[0] ?? answer.custom ?? ''
}

/**
 * Read one answered numeric field.
 * @param answers - the human's answer batch.
 * @param id - field id.
 * @returns The number, or undefined when the field was left empty.
 * @throws when the typed text is not a number.
 */
function answerNumber(answers: AskUserQuestionAnswer, id: string): number | undefined {
  const text = answerText(answers, id).trim()
  if (text === '') return undefined
  const value = Number(text)
  if (!Number.isFinite(value)) throw new Error(`field ${id} expects a number, got ${text}`)
  return value
}

/**
 * A model key as a person reads it.
 *
 * The catalog names models by storage path (`stabilityai/stable-diffusion-xl`),
 * which is unreadable in a menu and pushes every row past the panel's width.
 * The menu shows this form; the CLI still receives the exact key.
 * @param key - catalog key.
 * @returns the readable name, e.g. "Stable Diffusion XL".
 */
export function displayName(key: string): string {
  const tail = key.slice(key.lastIndexOf('/') + 1)
  const words = tail.split(/[-_\s]+/u).filter(part => part !== '')
  return words.map(shout).join(' ')
}

/** Model-name initialisms that read badly title-cased ("Xl", "Vae"). */
const ACRONYMS = new Set(['sdxl', 'sd', 'xl', 'vae', 'gguf', 'fp8', 'fp16', 'lcm'])

/**
 * @param word - one hyphen-separated part of a model name.
 * @returns the part as a person writes it: initialisms and version tags upper
 *   case, everything else capitalised.
 */
function shout(word: string): string {
  if (ACRONYMS.has(word.toLowerCase())) return word.toUpperCase()
  if (/\d/u.test(word) || word.length <= 3) return word.toUpperCase()
  return word.charAt(0).toUpperCase() + word.slice(1)
}

/**
 * The menu label for every model.
 *
 * Two keys can end in the same name (`a/model`, `b/model`); the second then
 * carries its organisation so both rows stay distinguishable, and the map is
 * the exact inverse `readConfirmed` uses to recover the key.
 * @param models - ready text-to-image models.
 * @returns model key → label.
 */
function modelMenu(models: readonly CatalogEntry[]): Map<string, string> {
  const labels = new Map<string, string>()
  const used = new Set<string>()
  for (const model of models) {
    const base = displayName(model.key)
    const org = model.key.includes('/') ? model.key.slice(0, model.key.indexOf('/')) : ''
    let label = base
    if (used.has(label)) label = org === '' ? `${base} (${model.key})` : `${base} (${org})`
    used.add(label)
    labels.set(model.key, label)
  }
  return labels
}

/**
 * Build the confirmation form.
 * @param args - model-supplied starting values.
 * @param models - ready text-to-image models.
 * @returns One field per confirmed parameter, every field declaring the form intent.
 */
export function buildFormFields(
  args: RequestedParameters,
  models: readonly CatalogEntry[],
): AskUserQuestionItem[] {
  const requested = args.model_key
  const defaultModel = requested !== undefined && models.some(model => model.key === requested)
    ? requested
    : models[0]?.key ?? ''
  const labels = modelMenu(models)
  const intent = { kind: 'form' } as const
  // What generation will use when the user changes nothing. The service owns
  // these numbers (they follow each model's calibrated ceiling), so showing
  // them is honest in a way a hardcoded 512 never was.
  const defaults = models.find(model => model.key === defaultModel)?.runtime?.defaults ?? {}
  const preset = (key: string): Record<string, string> => {
    const value = defaults[key]
    return value === undefined ? {} : { default: String(value) }
  }
  return [
    {
      id: 'model_key',
      question: '模型',
      options: models.map(model => ({ label: labels.get(model.key) ?? model.key })),
      input: { default: labels.get(defaultModel) ?? '' },
      intent,
    },
    {
      id: 'prompt',
      question: '提示词',
      input: {
        kind: 'longtext',
        default: args.prompt,
        placeholder: '描述你想生成的画面',
      },
      intent,
    },
    {
      id: 'negative_prompt',
      question: '反向提示词',
      input: { default: args.negative_prompt ?? '', placeholder: '不想出现的内容，可留空' },
      intent,
    },
    {
      id: 'width',
      question: '宽度',
      input: { kind: 'number', min: 256, max: 2048, step: 32, placeholder: '服务默认', ...preset('width') },
      intent,
    },
    {
      id: 'height',
      question: '高度',
      input: { kind: 'number', min: 256, max: 2048, step: 32, placeholder: '服务默认', ...preset('height') },
      intent,
    },
    {
      id: 'steps',
      question: '步数',
      input: { kind: 'number', min: 1, max: 150, placeholder: '服务默认', ...preset('steps') },
      intent,
    },
    {
      id: 'cfg_scale',
      question: '提示词强度',
      input: { kind: 'number', min: 0, max: 30, step: 0.5, placeholder: '服务默认', ...preset('cfg_scale') },
      intent,
    },
    {
      id: 'sampler',
      question: '采样器',
      input: { placeholder: '服务默认', ...preset('sampler') },
      intent,
    },
    {
      id: 'seed',
      question: '随机种子',
      // -1 is the service's "pick one for me"; showing it matches the app.
      input: { kind: 'number', min: -1, default: '-1', placeholder: '随机' },
      intent,
    },
  ]
}

/**
 * The same fields with every presentation intent removed.
 *
 * A runtime older than the form intent's own validation reads any intent as a
 * plan review, so `ask()` rejects the batch before a UI can show it. Dropping
 * the intent keeps the dialog: a batch whose every field declares a control is
 * a form either way.
 * @param items - fields carrying the form intent.
 * @returns the fields, unchanged except for the intent.
 */
export function withoutFormIntent(items: readonly AskUserQuestionItem[]): AskUserQuestionItem[] {
  return items.map((item) => {
    const { intent: dropped, ...rest } = item
    void dropped
    return rest
  })
}

/**
 * Map the accepted form onto confirmed parameters, omitting what the human left empty.
 * @param answers - the human's answer batch.
 * @param models - the catalog the form's menu was built from, so the chosen
 *   readable name maps back to the exact key the CLI expects.
 * @returns The confirmed parameters.
 * @throws when a required field is empty or a numeric field is not a number.
 */
export function readConfirmed(
  answers: AskUserQuestionAnswer,
  models: readonly CatalogEntry[],
): ConfirmedParameters {
  const chosen = answerText(answers, 'model_key').trim()
  const modelKey = [...modelMenu(models)].find(([, label]) => label === chosen)?.[0] ?? chosen
  if (modelKey === '') throw new Error('the confirmed form has no model')
  const prompt = answerText(answers, 'prompt').trim()
  if (prompt === '') throw new Error('the confirmed form has no prompt')
  const negativePrompt = answerText(answers, 'negative_prompt').trim()
  const sampler = answerText(answers, 'sampler').trim()
  const width = answerNumber(answers, 'width')
  const height = answerNumber(answers, 'height')
  const steps = answerNumber(answers, 'steps')
  const cfgScale = answerNumber(answers, 'cfg_scale')
  const seed = answerNumber(answers, 'seed')
  return {
    modelKey,
    prompt,
    ...(negativePrompt === '' ? {} : { negativePrompt }),
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    ...(steps === undefined ? {} : { steps }),
    ...(cfgScale === undefined ? {} : { cfgScale }),
    ...(sampler === '' ? {} : { sampler }),
    ...(seed === undefined ? {} : { seed }),
  }
}

/**
 * Spell confirmed parameters as CLI arguments, leaving out every empty field so
 * the service applies its own default instead of a fabricated one.
 * @param confirmed - values the human accepted.
 * @returns CLI arguments after `generate`.
 */
export function generateArguments(confirmed: ConfirmedParameters): string[] {
  return [
    '--prompt', confirmed.prompt,
    '--model-key', confirmed.modelKey,
    ...confirmed.negativePrompt === undefined ? [] : ['--negative-prompt', confirmed.negativePrompt],
    ...confirmed.width === undefined ? [] : ['--width', String(confirmed.width)],
    ...confirmed.height === undefined ? [] : ['--height', String(confirmed.height)],
    ...confirmed.steps === undefined ? [] : ['--steps', String(confirmed.steps)],
    ...confirmed.cfgScale === undefined ? [] : ['--cfg-scale', String(confirmed.cfgScale)],
    ...confirmed.sampler === undefined ? [] : ['--sampler', confirmed.sampler],
    ...confirmed.seed === undefined ? [] : ['--seed', String(confirmed.seed)],
    '--wait',
    '--timeout', '1800',
  ]
}
