import type { LLMContentBlock, LLMMessage } from '../llm/types'
import { loadProviders, lookupModel } from '../../config/providersStore'
import { makeVisionModelConfigurationError } from '../errors'

const OMITTED_IMAGE_TEXT = '[Image omitted for this text-only model. Use the previous vision-model response as the image analysis.]'

export interface RoundModelSelection {
  modelId: string
  supportsImages: boolean
  switchedToVisionModel: boolean
}

function supportsAgentImages(modelId: string): boolean {
  const resolved = lookupModel(modelId)
  return resolved !== null
    && resolved.model.supportsImages !== false
    && resolved.model.supportsAgent !== false
}

/**
 * 为当前 LLM 轮次选择模型。
 *
 * 只有“本轮刚收到新图片”且主模型明确 supportsImages=false 时才临时路由；
 * 纯文本轮次始终返回主模型，避免后续对话持续占用更贵的多模态模型。
 */
export function selectRoundModel(mainModelId: string, hasNewImages: boolean): RoundModelSelection {
  const mainModel = lookupModel(mainModelId)
  const mainSupportsImages = mainModel?.model.supportsImages !== false

  if (!hasNewImages || mainSupportsImages) {
    return {
      modelId: mainModelId,
      supportsImages: mainSupportsImages,
      switchedToVisionModel: false,
    }
  }

  const visionModelId = loadProviders().visionModelId?.trim() ?? ''
  if (!visionModelId) {
    throw makeVisionModelConfigurationError(
      `Model \`${mainModelId}\` does not support image input, and no vision model is configured.\n\n`
      + 'Open the Cursor++ side panel → Vision Routing, then select an image-capable Agent model.',
      { mainModelId },
    )
  }

  const visionModel = lookupModel(visionModelId)
  if (!visionModel) {
    throw makeVisionModelConfigurationError(
      `Configured vision model \`${visionModelId}\` was not found in \`~/.ccursor/providers.json\`.\n\n`
      + 'Choose an existing model in the Cursor++ side panel → Vision Routing.',
      { mainModelId, visionModelId },
    )
  }

  if (!supportsAgentImages(visionModelId)) {
    throw makeVisionModelConfigurationError(
      `Configured vision model \`${visionModelId}\` must support both image input and Agent mode.\n\n`
      + 'Enable Supports Images and Supports Agent for that model, or select another model.',
      { mainModelId, visionModelId },
    )
  }

  return {
    modelId: visionModelId,
    supportsImages: true,
    switchedToVisionModel: true,
  }
}

/**
 * 不支持图片的模型不能接收历史中的 image block。
 *
 * 看图轮生成的 assistant 分析仍保留在历史里；这里只把二进制图片替换成文字
 * 占位，确保下一轮切回主模型时不会被上游 API 以“不支持图片”拒绝。
 */
export function omitImagesForTextOnlyModel(messages: LLMMessage[]): LLMMessage[] {
  return messages.map((message) => {
    if (typeof message.content === 'string')
      return message

    let replacedImage = false
    const content = message.content.map<LLMContentBlock>((block) => {
      if (block.type !== 'image')
        return block
      replacedImage = true
      return { type: 'text', text: OMITTED_IMAGE_TEXT }
    })

    return replacedImage ? { ...message, content } : message
  })
}
