/** Public page-bootstrap options shared by the Host and Client halves. */

import z from '@deepseek-ai/schemastery'

/** Onboarding options after schema defaults are applied. */
export interface Config {
  /** Offer the browser API-key step when no native shell owns credential onboarding. */
  credentialOnboarding: boolean
  /** Show managed V-Scheduler settings instead of credential forms. */
  schedulerManaged: boolean
}

/** Validate Host configuration and its public page-bootstrap payload. */
export const Config: z<Partial<Config>, Config> = z.object({
  credentialOnboarding: z.boolean().default(true),
  schedulerManaged: z.boolean().default(false),
})

/** Page-global key carrying only the public onboarding options. */
export const ONBOARDING_CONFIG_GLOBAL = '__DSH_MODELS_ONBOARDING__'
