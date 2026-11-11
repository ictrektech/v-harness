import type {} from '@deepseek-ai/dsh-client-ui-context-menu/client'
/** Browser attachment plugin: composer entries and independently replaceable image galleries. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SlotFactoryMap } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-ui-trajectory/client'
import type {} from '@deepseek-ai/dsh-client-ui-file-drag/client'
import { ComposerAttachments, type ComposerAttachmentsInjected } from './ComposerAttachments.tsx'
import { MessageImages, MessageImagesContent } from './MessageImages.tsx'
import { RegionTokenChip } from './RegionTokenChip.tsx'
import { regionTokenRule } from './region-token-rule.ts'

type MessageImagesInjected = SlotFactoryMap['conversation.images.content']['inject']

/** Slot registry required by the attachment presentation plugin. */
export const inject = ['slots', 'fileDrag', 'uiConversation']

/**
 * Register composer attachments, the shared gallery, and the collapsed form of
 * the region/brush tokens this package writes into the draft.
 * @param ctx - client plugin context with the Slot registry and Conversation assembly.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.uiConversation.userText.register(regionTokenRule), 'ui-attachment: region tokens')
  ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register({
    name: 'conversation.user.text.node', key: 'region', locale: 'conversation',
  }, RegionTokenChip))
  ctx.slots.registerFactory({
    name: 'conversation.images.content', scope: 'root', locale: 'conversation',
    inject: (): MessageImagesInjected => ({
      fileDrag: ctx.fileDrag.actions,
    }),
  }, MessageImagesContent)
  ctx.slots.inject('conversation.input.attachments', () => ctx.slots.register({
    name: 'conversation.input.attachments',
    inject: (): ComposerAttachmentsInjected => ({ readFileDrag: ctx.fileDrag.read }),
    locale: 'conversation',
  }, ComposerAttachments))
  ctx.slots.inject('conversation.chat.message.images', () => ctx.slots.register({
    name: 'conversation.chat.message.images', priority: 100,
  }, MessageImages))
  ctx.slots.inject('conversation.chat.user.images', () => ctx.slots.register({
    name: 'conversation.chat.user.images', priority: 100,
  }, MessageImages))
  ctx.slots.inject('conversation.trajectory.images', () => ctx.slots.register({
    name: 'conversation.trajectory.images', priority: 100,
  }, MessageImages))
  ctx.slots.inject('tool.call.images', () => ctx.slots.register({
    name: 'tool.call.images', priority: 100,
  }, MessageImages))
}
