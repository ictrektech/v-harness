import { describe, expect, it } from 'vitest'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import { buildFormFields, generateArguments, readConfirmed, type CatalogEntry } from '../src/params.ts'

const MODELS: CatalogEntry[] = [
  { key: 'sdxl', capabilities: ['txt2img'] },
  { key: 'sd15', capabilities: ['txt2img', 'img2img'] },
]

/** Answer batch keyed the way the form dialog submits it: option label first, then free text. */
const answered = (values: Record<string, string>, selected: Record<string, string> = {}): AskUserQuestionAnswer => ({
  answers: [...new Set([...Object.keys(values), ...Object.keys(selected)])].map((id) => {
    const picked = selected[id]
    const custom = values[id] ?? ''
    return {
      id,
      selected: picked === undefined ? [] : [picked],
      ...(custom === '' ? {} : { custom }),
    }
  }),
})

describe('buildFormFields', () => {
  it('offers the ready models and keeps the requested one when it is offered', () => {
    const fields = buildFormFields({ prompt: 'a tea house', model_key: 'sd15' }, MODELS)
    const model = fields.find(field => field.id === 'model_key')

    expect(model?.options?.map(option => option.label)).toEqual(['SDXL', 'SD15'])
    expect(model?.input?.default).toBe('SD15')
  })

  it('falls back to the first ready model when the requested one is not in the catalog', () => {
    const fields = buildFormFields({ prompt: 'a tea house', model_key: 'not-pulled' }, MODELS)

    expect(fields.find(field => field.id === 'model_key')?.input?.default).toBe('SDXL')
  })

  it('carries the model-supplied prompt and negative prompt as starting values', () => {
    const fields = buildFormFields({ prompt: 'a tea house', negative_prompt: 'blurry' }, MODELS)

    expect(fields.find(field => field.id === 'prompt')?.input).toMatchObject({
      kind: 'longtext', default: 'a tea house',
    })
    expect(fields.find(field => field.id === 'negative_prompt')?.input?.default).toBe('blurry')
  })

  it('declares the form intent on every field, so the dialog owns the whole batch', () => {
    const fields = buildFormFields({ prompt: 'a tea house' }, MODELS)

    expect(fields.every(field => field.intent?.kind === 'form')).toBe(true)
    // Empty numeric fields mean "service default", never a fabricated value.
    expect(fields.find(field => field.id === 'steps')?.input?.default).toBeUndefined()
    expect(fields.find(field => field.id === 'seed')?.input?.default).toBe('-1')
  })
})

describe('readConfirmed', () => {
  it('reads option labels and free text back into the units the CLI takes', () => {
    const confirmed = readConfirmed(answered(
      { prompt: 'a tea house', negative_prompt: 'blurry', width: '768', height: '768', seed: '-1' },
      { model_key: 'SD15' },
    ), MODELS)

    expect(confirmed).toEqual({
      modelKey: 'sd15',
      prompt: 'a tea house',
      negativePrompt: 'blurry',
      width: 768,
      height: 768,
      seed: -1,
    })
  })

  it('omits every field the human left empty', () => {
    const confirmed = readConfirmed(answered({ prompt: 'a tea house' }, { model_key: 'SDXL' }), MODELS)

    expect(confirmed).toEqual({ modelKey: 'sdxl', prompt: 'a tea house' })
  })

  it.each([
    ['no model', answered({ prompt: 'a tea house' })],
    ['no prompt', answered({ prompt: '  ' }, { model_key: 'SDXL' })],
  ])('rejects a request with %s', (_label, answers) => {
    expect(() => readConfirmed(answers, MODELS)).toThrow()
  })

  it('rejects a numeric field that is not a number', () => {
    expect(() => readConfirmed(answered(
      { prompt: 'a tea house', steps: 'many' },
      { model_key: 'SDXL' },
    ), MODELS)).toThrow('expects a number')
  })
})

describe('generateArguments', () => {
  it('spells only the confirmed flags and always waits for the job', () => {
    expect(generateArguments({ modelKey: 'sdxl', prompt: 'a tea house', width: 512 })).toEqual([
      '--prompt', 'a tea house',
      '--model-key', 'sdxl',
      '--width', '512',
      '--wait', '--timeout', '1800',
    ])
  })

  it('keeps every optional parameter in a stable order', () => {
    expect(generateArguments({
      modelKey: 'sdxl', prompt: 'x', negativePrompt: 'blurry', width: 768, height: 768,
      steps: 20, cfgScale: 7, sampler: 'euler_a', seed: 42,
    })).toEqual([
      '--prompt', 'x', '--model-key', 'sdxl',
      '--negative-prompt', 'blurry',
      '--width', '768', '--height', '768',
      '--steps', '20', '--cfg-scale', '7', '--sampler', 'euler_a', '--seed', '42',
      '--wait', '--timeout', '1800',
    ])
  })
})
