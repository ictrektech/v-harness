import { useEffect, useState, useSyncExternalStore } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { QuestionComposerProps, QuestionForm, QuestionFormField, PendingQuestion } from './contract/slots.ts'
import css from './FormPanel.module.css'

/** The panel's own props: the question domain face, the narrowed form, and the locale seat. */
export type FormPanelProps =
  { pending: PendingQuestion; form: QuestionForm } & Pick<QuestionComposerProps, 't'>

/**
 * Starting value of one field: its declared default, else the first option a
 * menu would show, else empty. A field that starts empty means "let the service
 * decide", so submitting unchanged never invents a value.
 * @param field - one form field.
 * @returns The draft the dialog opens with.
 */
function initialValue(field: QuestionFormField): string {
  if (field.input?.default !== undefined) return field.input.default
  return field.options?.[0]?.label ?? ''
}

/**
 * Render one field's control.
 * @param props.field - the field to render.
 * @param props.value - current draft.
 * @param props.disabled - whether a submission is in flight.
 * @param props.onChange - receives the whole new value.
 * @param props.first - whether this control takes initial focus.
 * @returns The labelled control row.
 */
function Field(props: {
  field: QuestionFormField
  value: string
  disabled: boolean
  first: boolean
  onChange: (value: string) => void
}) {
  const { field, value, disabled, first, onChange } = props
  const input = field.input
  const common = { 'data-modal-autofocus': first ? true : undefined, disabled }
  return (
    <label className={css.field}>
      <span className={css.label}>{field.label}</span>
      {field.options !== undefined
        ? (
          <select
            className={css.control}
            value={value}
            {...common}
            onChange={(event) => { onChange(event.target.value) }}
          >
            {field.options.map(option => (
              <option key={option.label} value={option.label}>{option.label}</option>
            ))}
          </select>
        )
        : input?.kind === 'longtext'
          ? (
            <textarea
              className={css.longtext}
              value={value}
              placeholder={input.placeholder}
              {...common}
              onChange={(event) => { onChange(event.target.value) }}
            />
          )
          : (
            <Input
              className={css.control ?? ''}
              type={input?.kind === 'number' ? 'number' : 'text'}
              value={value}
              min={input?.min}
              max={input?.max}
              step={input?.step}
              placeholder={input?.placeholder}
              {...common}
              onChange={(event) => { onChange(event.target.value) }}
            />
          )}
      {field.detail !== undefined && <span className={css.detail}>{field.detail}</span>}
    </label>
  )
}

/**
 * Render a `form` request as one modal dialog over every field.
 *
 * The dialog answers with the same batch encoding the generic flow uses: a menu
 * field answers the chosen label, and a free field answers its text, so the
 * asker needs no second protocol for parameters. Submitting unchanged sends the
 * declared defaults; closing the dialog ends the request instead of hiding it,
 * because a parameter form that disappears must not leave its caller waiting.
 *
 * @param props - the question domain face, the narrowed form, and `t`.
 * @returns The parameter dialog for this request.
 */
export function FormPanel({ pending, form, t }: FormPanelProps) {
  const card = useSyncExternalStore(pending.subscribe, pending.snapshot)
  const [values, setValues] = useState<Record<string, string>>(() => {
    const seeded: Record<string, string> = {}
    for (const field of form.fields) seeded[field.id] = initialValue(field)
    return seeded
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Editing a field engages the request, which freezes any countdown: a form
  // the user is filling must not advance work behind their back.
  useEffect(() => { pending.engage() }, [pending])
  const locked = busy
  const submit = (): void => {
    if (card.channel === 'none') {
      setError(t('error.unavailable'))
      return
    }
    setBusy(true)
    setError(null)
    const answers = form.fields.map((field) => {
      const value = values[field.id] ?? ''
      return field.options !== undefined
        ? { id: field.id, selected: value === '' ? [] : [value] }
        : { id: field.id, selected: [], ...(value === '' ? {} : { custom: value }) }
    })
    void pending.answer({ answers })
      .then(() => {
        setBusy(false)
        // The parameter form's call need not be one the question projection
        // tracks, so the panel withdraws itself instead of waiting for a row
        // that never appears.
        void pending.dismiss().catch(() => { setError(t('status.sent')) })
      })
      .catch((cause: unknown) => {
        setBusy(false)
        setError(cause instanceof Error ? cause.message : String(cause))
      })
  }
  const cancel = (): void => {
    setBusy(true)
    void pending.cancel().catch((cause: unknown) => {
      setBusy(false)
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }
  return (
    <Modal
      open
      onClose={cancel}
      title={form.title ?? t('form.title')}
      closeLabel={t('form.close')}
      className={css.dialog ?? ''}
      footer={(
        <div className={css.footer}>
          <div className={css.feedback} role="status">{error ?? ''}</div>
          <div className={css.actions}>
            <Button variant="outline" disabled={locked} onClick={cancel}>{t('form.cancel')}</Button>
            <Button variant="primary" disabled={locked || card.channel === 'none'} onClick={submit}>
              {busy ? t('submitting') : t('form.submit')}
            </Button>
          </div>
        </div>
      )}
    >
      <div className={css.grid} data-form-key={pending.key}>
        {form.fields.map((field, index) => (
          <Field
            key={field.id}
            field={field}
            first={index === 0}
            value={values[field.id] ?? ''}
            disabled={locked}
            onChange={(value) => {
              setValues(current => ({ ...current, [field.id]: value }))
              setError(null)
            }}
          />
        ))}
      </div>
    </Modal>
  )
}
