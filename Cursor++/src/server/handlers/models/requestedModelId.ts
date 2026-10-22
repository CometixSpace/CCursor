/**
 * 客户端 "默认模型" 占位 id 解析
 *
 * Cursor 客户端在某些场景下不会发送具体模型 id, 而是发送占位名:
 *   - 会话创建时保存的 modelName 仍是 "default" (Auto/Routed 视图的默认值)
 *   - Agent Window 新建/旧会话, 模型选择从未落成具体 id
 *   - 请求里 modelDetails.modelId 缺省
 *
 * 官方服务端有路由层, 可以把占位名二次路由到真实模型; BYOK 没有这一层,
 * 占位名会直接落到 providers.json 的反向索引里命中失败, 表现为
 * "Model \"default\" not found in ~/.ccursor/providers.json"。
 *
 * 因此这里把占位名统一映射到 providers.json 中的默认模型 —— 与
 * AiService.getDefaultModel 推送给 Composer / Cmd+K 的默认模型保持同一套选择规则
 * (defaultOn !== false 的第一个模型, 都不符合时退到列表首项)。
 */
import { flattenModels } from '../../config/providersStore'

const DEFAULT_MODEL_ALIASES: ReadonlySet<string> = new Set(['', 'default', 'auto'])

/** 是否为客户端 "默认模型" 占位名 (空串也算 —— 客户端没给模型) */
export function isDefaultModelAlias(modelId: string | undefined | null): boolean {
  if (typeof modelId !== 'string')
    return true
  return DEFAULT_MODEL_ALIASES.has(modelId.trim().toLowerCase())
}

/** providers.json 里当前生效的默认模型 id; 一个模型都没有时返回 null */
export function resolveDefaultModelId(): string | null {
  const all = flattenModels()
  const preferred = all.find(entry => entry.model.defaultOn !== false)
  return (preferred ?? all[0])?.model.id ?? null
}

/**
 * 把客户端发来的 modelId 归一成 providers.json 中登记的 id。
 *
 * 占位名 → 默认模型 id; 已有具体 id → 原样返回 (不做任何前缀推断)。
 * 占位名且没有任何可用模型时返回原始占位名, 让上游照常报 ModelNotFoundError,
 * 用户能看到 "providers.json 为空" 的真实原因。
 */
export function resolveRequestedModelId(modelId: string | undefined | null): string {
  if (!isDefaultModelAlias(modelId))
    return modelId as string
  return resolveDefaultModelId() ?? (modelId ?? '')
}
