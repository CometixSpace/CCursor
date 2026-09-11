import { dirname, posix } from 'node:path'
import type {
  ParsedAgentSkill,
  ParsedCursorRule,
  ParsedCustomSubagent,
  ParsedRunRequest,
} from './protocol/types'

const CURSOR_RULE_SOURCE_TEAM = 1
const CURSOR_RULE_SOURCE_USER = 2

const SKILL_PATH_SEGMENTS = [
  '/.cursor/skills/',
  '/.cursor/skills-cursor/',
  '/.agents/skills/',
  '/.claude/skills/',
  '/.codex/skills/',
]

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function normalizeRuleSource(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value))
    return value
  if (typeof value !== 'string')
    return 0
  const normalized = value.toUpperCase()
  if (normalized.includes('TEAM')) return CURSOR_RULE_SOURCE_TEAM
  if (normalized.includes('USER')) return CURSOR_RULE_SOURCE_USER
  return 0
}

function readOneofCase(container: unknown): { kind: ParsedCursorRule['kind'], value?: Record<string, unknown> } {
  if (!container || typeof container !== 'object' || Array.isArray(container))
    return { kind: 'unknown' }
  const ruleType = container as Record<string, unknown>
  const native = ruleType.type as { case?: unknown, value?: unknown } | undefined
  if (typeof native?.case === 'string') {
    const kind = normalizeRuleKind(native.case)
    return {
      kind,
      value: native.value && typeof native.value === 'object' && !Array.isArray(native.value)
        ? native.value as Record<string, unknown>
        : undefined,
    }
  }
  for (const candidate of ['global', 'fileGlobbed', 'agentFetched', 'manuallyAttached'] as const) {
    if (!(candidate in ruleType) || ruleType[candidate] == null)
      continue
    const rawValue = ruleType[candidate]
    return {
      kind: candidate,
      value: rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)
        ? rawValue as Record<string, unknown>
        : undefined,
    }
  }
  return { kind: 'unknown' }
}

function normalizeRuleKind(value: string): ParsedCursorRule['kind'] {
  const compact = value.replace(/[_-]/g, '').toLowerCase()
  if (compact === 'global') return 'global'
  if (compact === 'fileglobbed' || compact === 'fileglobs') return 'fileGlobbed'
  if (compact === 'agentfetched') return 'agentFetched'
  if (compact === 'manuallyattached') return 'manuallyAttached'
  return 'unknown'
}

function extractFrontmatter(content: string): string | undefined {
  return content.match(/^---[^\S\r\n]*\r?\n([\s\S]*?)\r?\n---/)?.[1]
}

export function extractSkillDescription(content: string): string {
  const frontmatter = extractFrontmatter(content)
  if (frontmatter === undefined)
    return content.trim().slice(0, 120)
  const description = frontmatter.match(/^description:([^\r\n]*)/m)
  return description ? description[1].trim() : content.trim().slice(0, 120)
}

export function isSkillPath(fullPath: string): boolean {
  const normalized = normalizePath(fullPath)
  if (normalized === 'SKILL.md' || normalized.endsWith('/SKILL.md'))
    return true
  if (SKILL_PATH_SEGMENTS.some(segment => normalized.includes(segment)))
    return true
  const pluginCache = normalized.indexOf('/.cursor/plugins/cache/')
  return pluginCache >= 0 && normalized.indexOf('/skills/', pluginCache) >= 0
}

export function normalizeCursorRule(raw: Record<string, unknown>): ParsedCursorRule {
  const { kind, value } = readOneofCase(raw.type)
  const globs = kind === 'fileGlobbed'
    ? stringArray(value?.globs ?? (typeof value?.glob === 'string' ? [value.glob] : []))
    : []
  return {
    fullPath: stringValue(raw.fullPath),
    content: stringValue(raw.content),
    kind,
    source: normalizeRuleSource(raw.source),
    globs,
    ...(globs.length > 0 ? { glob: globs.join(', ') } : {}),
    ...(kind === 'agentFetched' && typeof value?.description === 'string'
      ? { description: value.description }
      : {}),
    ...(optionalString(raw.gitRemoteOrigin) ? { gitRemoteOrigin: optionalString(raw.gitRemoteOrigin) } : {}),
    ...(optionalString(raw.parseError) ? { parseError: optionalString(raw.parseError) } : {}),
    environments: stringArray(raw.environments),
    disabledEnvironments: stringArray(raw.disabledEnvironments),
    ...(optionalString(raw.plugin) ? { plugin: optionalString(raw.plugin) } : {}),
    ...(optionalString(raw.marketplace) ? { marketplace: optionalString(raw.marketplace) } : {}),
    ...(optionalString(raw.pluginId) ? { pluginId: optionalString(raw.pluginId) } : {}),
    ...(optionalString(raw.marketplaceId) ? { marketplaceId: optionalString(raw.marketplaceId) } : {}),
    scopedTo: stringArray(raw.scopedTo),
    frontmatter: stringValue(raw.frontmatter),
    ...(optionalBoolean(raw.isRequired) !== undefined ? { isRequired: optionalBoolean(raw.isRequired) } : {}),
    raw,
  }
}

export function normalizeAgentSkill(raw: Record<string, unknown>): ParsedAgentSkill {
  const content = stringValue(raw.content)
  return {
    fullPath: stringValue(raw.fullPath),
    content,
    description: stringValue(raw.description) || extractSkillDescription(content),
    ...(optionalString(raw.parseError) ? { parseError: optionalString(raw.parseError) } : {}),
    environments: stringArray(raw.environments),
    disabledEnvironments: stringArray(raw.disabledEnvironments),
    ...(optionalString(raw.gitRemoteOrigin) ? { gitRemoteOrigin: optionalString(raw.gitRemoteOrigin) } : {}),
    disableModelInvocation: raw.disableModelInvocation === true,
    ...(optionalString(raw.plugin) ? { plugin: optionalString(raw.plugin) } : {}),
    ...(optionalString(raw.marketplace) ? { marketplace: optionalString(raw.marketplace) } : {}),
    ...(optionalString(raw.pluginId) ? { pluginId: optionalString(raw.pluginId) } : {}),
    ...(optionalString(raw.marketplaceId) ? { marketplaceId: optionalString(raw.marketplaceId) } : {}),
    globs: stringArray(raw.globs),
    scopedTo: stringArray(raw.scopedTo),
    raw,
  }
}

function normalizePermissionMode(value: unknown): ParsedCustomSubagent['permissionMode'] {
  if (value === 2 || (typeof value === 'string' && value.toUpperCase().includes('READONLY')))
    return 'readonly'
  if (value === 3 || (typeof value === 'string' && value.toUpperCase().includes('AGENT_ONLY')))
    return 'agentOnly'
  return 'default'
}

export function normalizeCustomSubagent(raw: Record<string, unknown>): ParsedCustomSubagent {
  return {
    fullPath: stringValue(raw.fullPath),
    name: stringValue(raw.name),
    description: stringValue(raw.description),
    tools: stringArray(raw.tools),
    model: stringValue(raw.model),
    prompt: stringValue(raw.prompt),
    permissionMode: normalizePermissionMode(raw.permissionMode),
    isBackground: raw.isBackground === true,
    forceDefaultModel: raw.forceDefaultModel === true,
    ...(optionalString(raw.plugin) ? { plugin: optionalString(raw.plugin) } : {}),
    ...(optionalString(raw.marketplace) ? { marketplace: optionalString(raw.marketplace) } : {}),
    ...(optionalString(raw.pluginId) ? { pluginId: optionalString(raw.pluginId) } : {}),
    ...(optionalString(raw.marketplaceId) ? { marketplaceId: optionalString(raw.marketplaceId) } : {}),
    ...(optionalString(raw.source) ? { source: optionalString(raw.source) } : {}),
    raw,
  }
}

function basename(fullPath: string): string {
  const normalized = normalizePath(fullPath)
  const slash = normalized.lastIndexOf('/')
  return slash >= 0 ? normalized.slice(slash + 1) : normalized
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/g, '')
}

/** .cursor/rules 下的规则以包含该目录的 workspace 为作用域。 */
export function ruleWorkspaceRoot(fullPath: string): string {
  const normalized = posix.normalize(normalizePath(fullPath))
  const segments = posix.dirname(normalized).split('/')
  for (let index = segments.length - 2; index >= 0; index--) {
    if (segments[index] !== '.cursor' || segments[index + 1] !== 'rules')
      continue
    const root = segments.slice(0, index).join('/')
    return root || '/'
  }
  return posix.dirname(normalized)
}

function isInsidePath(target: string, root: string): boolean {
  const normalizedTarget = posix.normalize(normalizePath(target))
  const normalizedRoot = posix.normalize(normalizePath(root))
  return normalizedRoot === '/'
    ? normalizedTarget.startsWith('/')
    : normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`)
}

/** 官方 WK: fileGlobbed 与嵌套 workspace global rule 随 Read 结果自动附加。 */
export function isAutoAttachedRule(rule: ParsedCursorRule, workspacePaths: string[]): boolean {
  if (rule.kind === 'fileGlobbed')
    return true
  if (rule.kind !== 'global' || !rule.fullPath)
    return false
  const root = ruleWorkspaceRoot(rule.fullPath)
  const workspace = workspacePaths.find(path => isInsidePath(root, path))
  return !!workspace && posix.normalize(normalizePath(workspace)) !== posix.normalize(normalizePath(root))
}

function isAvailableInLocalEnvironment(item: { environments: string[], disabledEnvironments: string[] }): boolean {
  const normalize = (value: string) => value.trim().toLowerCase()
  const isLocal = (value: string) => value === 'local' || value.endsWith('_local')
  const disabled = item.disabledEnvironments.map(normalize)
  if (disabled.some(isLocal))
    return false
  const enabled = item.environments.map(normalize).filter(Boolean)
  return enabled.length === 0 || enabled.some(isLocal)
}

function filterEffectiveRules(
  rules: ParsedCursorRule[],
  disabledTeamRules: string[],
): ParsedCursorRule[] {
  const disabled = new Set(disabledTeamRules)
  const seenTeamNames = new Set<string>()
  return rules.filter((rule) => {
    if (rule.source !== CURSOR_RULE_SOURCE_TEAM)
      return true
    const name = basename(rule.fullPath)
    if (!rule.isRequired && disabled.has(name))
      return false
    if (seenTeamNames.has(name))
      return false
    seenTeamNames.add(name)
    return true
  })
}

export interface CategorizedCursorRules {
  cursorRules: ParsedCursorRule[]
  alwaysRules: ParsedCursorRule[]
  requestableRules: ParsedCursorRule[]
  userRules: string[]
  skills: ParsedAgentSkill[]
}

/** 对齐 agent-exec UX()/SK() 的 Rule/Skill 分类。 */
export function categorizeCursorRules(params: {
  rules: Array<Record<string, unknown>>
  nonFileRules?: Array<Record<string, unknown>>
  disabledTeamRules?: string[]
  workspacePaths?: string[]
}): CategorizedCursorRules {
  const normalized = filterEffectiveRules(
    [...params.rules, ...(params.nonFileRules ?? [])]
      .map(normalizeCursorRule)
      .filter(isAvailableInLocalEnvironment),
    params.disabledTeamRules ?? [],
  )
  const alwaysRules: ParsedCursorRule[] = []
  const requestableRules: ParsedCursorRule[] = []
  const userRules: string[] = []
  const skills: ParsedAgentSkill[] = []
  const workspacePaths = params.workspacePaths ?? []

  for (const rule of normalized) {
    if (isSkillPath(rule.fullPath)) {
      if (rule.kind === 'global') {
        alwaysRules.push(rule)
      }
      else if (!skillDisablesModelInvocation(rule.content)) {
        skills.push(normalizeAgentSkill({
          ...rule.raw,
          fullPath: rule.fullPath,
          content: rule.content,
          description: rule.description ?? extractSkillDescription(rule.content),
        }))
      }
      continue
    }

    if (rule.source === CURSOR_RULE_SOURCE_USER) {
      if (rule.content)
        userRules.push(rule.content)
      continue
    }
    if (rule.source === CURSOR_RULE_SOURCE_TEAM) {
      alwaysRules.push(rule)
      continue
    }
    if (rule.kind === 'manuallyAttached')
      continue
    if (rule.kind === 'global' && !isAutoAttachedRule(rule, workspacePaths)) {
      alwaysRules.push(rule)
      continue
    }
    // Content-only legacy rules without a path cannot be fetched, so preserve the old eager fallback.
    if (rule.kind === 'unknown' && !rule.fullPath) {
      if (rule.content)
        userRules.push(rule.content)
      continue
    }
    requestableRules.push(rule)
  }

  return {
    cursorRules: normalized,
    alwaysRules,
    requestableRules,
    userRules,
    skills,
  }
}

function skillDisablesModelInvocation(content: string): boolean {
  const frontmatter = extractFrontmatter(content)
  return frontmatter !== undefined && /^disable-model-invocation:\s*true\s*$/mi.test(frontmatter)
}

export function mergeAgentSkills(
  current: ParsedAgentSkill[],
  incoming: ParsedAgentSkill[],
): ParsedAgentSkill[] {
  const byPath = new Map<string, ParsedAgentSkill>()
  for (const skill of [...current, ...incoming]) {
    if (!skill.fullPath || !isAvailableInLocalEnvironment(skill))
      continue
    const existing = byPath.get(skill.fullPath)
    if (!existing) {
      byPath.set(skill.fullPath, skill)
      continue
    }
    byPath.set(skill.fullPath, {
      ...existing,
      ...skill,
      content: skill.content || existing.content,
      description: skill.description || existing.description,
      globs: skill.globs.length > 0 ? skill.globs : existing.globs,
      scopedTo: skill.scopedTo.length > 0 ? skill.scopedTo : existing.scopedTo,
    })
  }
  return [...byPath.values()]
}

export function applyRuleContext(params: {
  parsed: ParsedRunRequest
  rules: Array<Record<string, unknown>>
  nonFileRules?: Array<Record<string, unknown>>
  cloudRule?: string
  disabledTeamRules?: string[]
  preserveExistingUserRules?: boolean
}): void {
  const categorized = categorizeCursorRules({
    rules: params.rules,
    nonFileRules: params.nonFileRules,
    disabledTeamRules: params.disabledTeamRules ?? params.parsed.disabledTeamRules,
    workspacePaths: params.parsed.env.workspacePaths,
  })
  const preserved = params.preserveExistingUserRules ? params.parsed.userRules : []
  const userRules: string[] = []
  const seenUserRules = new Set<string>()
  for (const rule of [...categorized.userRules, ...preserved]) {
    const key = rule.trim()
    if (!key || seenUserRules.has(key))
      continue
    seenUserRules.add(key)
    userRules.push(rule)
  }
  params.parsed.cursorRules = categorized.cursorRules
  params.parsed.alwaysRules = categorized.alwaysRules
  params.parsed.projectRules = categorized.requestableRules
  params.parsed.userRules = userRules
  params.parsed.agentSkills = mergeAgentSkills(categorized.skills, params.parsed.agentSkills)
  if (params.cloudRule !== undefined)
    params.parsed.cloudRule = params.cloudRule
}

/** Skill 根目录，用于按 workspace/glob 提示关联 Skill。 */
export function skillWorkspaceRoot(fullPath: string): string {
  const normalized = posix.normalize(normalizePath(fullPath))
  const segments = posix.dirname(normalized).split('/')
  const pairs = [
    ['.cursor', 'skills'],
    ['.cursor', 'skills-cursor'],
    ['.agents', 'skills'],
    ['.claude', 'skills'],
    ['.codex', 'skills'],
  ]
  for (let index = segments.length - 2; index >= 0; index--) {
    if (!pairs.some(([left, right]) => segments[index] === left && segments[index + 1] === right))
      continue
    const root = segments.slice(0, index).join('/')
    return root || '/'
  }
  return dirname(normalized).replace(/\\/g, '/')
}

function expandBraces(pattern: string, limit = 64): string[] {
  const pending = [pattern]
  const expanded: string[] = []
  while (pending.length > 0 && expanded.length < limit) {
    const candidate = pending.shift()!
    const open = candidate.indexOf('{')
    const close = open >= 0 ? candidate.indexOf('}', open + 1) : -1
    if (open < 0 || close < 0) {
      expanded.push(candidate)
      continue
    }
    const alternatives = candidate.slice(open + 1, close).split(',')
    if (alternatives.length < 2) {
      expanded.push(candidate)
      continue
    }
    for (const alternative of alternatives.slice(0, limit - pending.length)) {
      pending.push(`${candidate.slice(0, open)}${alternative}${candidate.slice(close + 1)}`)
    }
  }
  return expanded
}

function globToRegExp(pattern: string): RegExp {
  let source = '^'
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index++
        if (pattern[index + 1] === '/') {
          index++
          source += '(?:.*/)?'
        }
        else {
          source += '.*'
        }
      }
      else {
        source += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      source += '[^/]'
      continue
    }
    if (char === '[') {
      const close = pattern.indexOf(']', index + 1)
      if (close > index + 1) {
        const body = pattern.slice(index + 1, close).replace(/^!/, '^')
        source += `[${body}]`
        index = close
        continue
      }
    }
    source += /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char
  }
  return new RegExp(`${source}$`)
}

function matchesGlob(value: string, pattern: string): boolean {
  const normalizedValue = posix.normalize(normalizePath(value))
  const normalizedPattern = normalizePath(pattern).replace(/^\.\//, '')
  try {
    return expandBraces(normalizedPattern).slice(0, 64)
      .some(expanded => globToRegExp(expanded).test(normalizedValue))
  }
  catch {
    return false
  }
}

function isAbsolutePattern(pattern: string): boolean {
  return pattern.startsWith('/') || /^[A-Za-z]:\//.test(pattern)
}

/** 官方 VK: file glob 相对 .cursor/rules 所属 workspace，absolute glob 对绝对路径。 */
export function ruleMatchesReadPath(rule: ParsedCursorRule, readPath: string): boolean {
  const target = posix.normalize(normalizePath(readPath))
  const root = posix.normalize(ruleWorkspaceRoot(rule.fullPath))
  if (rule.kind === 'global')
    return !!rule.fullPath && isInsidePath(target, root)
  if (rule.kind !== 'fileGlobbed')
    return false
  const relative = isInsidePath(target, root)
    ? target.slice(root === '/' ? 1 : root.length + 1)
    : undefined
  return rule.globs.some(pattern => isAbsolutePattern(normalizePath(pattern))
    ? matchesGlob(target, pattern)
    : relative !== undefined && matchesGlob(relative, pattern))
}

/** 官方 XK: Skill globs 匹配当前文件；嵌套 workspace Skill 无 globs 时按目录提示。 */
export function skillMatchesReadPath(
  skill: ParsedAgentSkill,
  readPath: string,
  workspacePaths: string[],
): boolean {
  if (skill.disableModelInvocation || skill.parseError || !skill.fullPath)
    return false
  const target = posix.normalize(normalizePath(readPath))
  const root = posix.normalize(skillWorkspaceRoot(skill.fullPath))
  const containingWorkspace = workspacePaths
    .map(path => posix.normalize(normalizePath(path)))
    .find(workspace => isInsidePath(root, workspace))

  if (skill.globs.length === 0)
    return !!containingWorkspace && containingWorkspace !== root && isInsidePath(target, root)

  if (containingWorkspace && !isInsidePath(target, root))
    return false
  const relativeToRoot = isInsidePath(target, root)
    ? target.slice(root === '/' ? 1 : root.length + 1)
    : undefined
  const relativeWorkspacePaths = containingWorkspace
    ? []
    : workspacePaths
        .map(path => posix.normalize(normalizePath(path)))
        .filter(workspace => isInsidePath(target, workspace))
        .map(workspace => target.slice(workspace === '/' ? 1 : workspace.length + 1))

  return skill.globs.some(pattern => {
    const normalizedPattern = normalizePath(pattern)
    if (isAbsolutePattern(normalizedPattern))
      return matchesGlob(target, normalizedPattern)
    if (relativeToRoot !== undefined && matchesGlob(relativeToRoot, normalizedPattern))
      return true
    return relativeWorkspacePaths.some(relative => matchesGlob(relative, normalizedPattern))
  })
}

/** ReadToolSuccess.related_cursor_rules 需要正式 CursorRule oneof init，而非 flattened JSON。 */
export function cursorRuleToProtoInit(rule: ParsedCursorRule): Record<string, unknown> {
  const typeValue: Record<string, unknown> | undefined = (() => {
    switch (rule.kind) {
      case 'global': return { type: { case: 'global', value: {} } }
      case 'fileGlobbed': return { type: { case: 'fileGlobbed', value: { globs: rule.globs } } }
      case 'agentFetched': return { type: { case: 'agentFetched', value: { description: rule.description ?? '' } } }
      case 'manuallyAttached': return { type: { case: 'manuallyAttached', value: {} } }
      default: return undefined
    }
  })()
  return {
    fullPath: rule.fullPath,
    content: rule.content,
    ...(typeValue ? { type: typeValue } : {}),
    source: rule.source,
    ...(rule.gitRemoteOrigin ? { gitRemoteOrigin: rule.gitRemoteOrigin } : {}),
    ...(rule.parseError ? { parseError: rule.parseError } : {}),
    environments: rule.environments,
    disabledEnvironments: rule.disabledEnvironments,
    ...(rule.plugin ? { plugin: rule.plugin } : {}),
    ...(rule.marketplace ? { marketplace: rule.marketplace } : {}),
    ...(rule.pluginId ? { pluginId: rule.pluginId } : {}),
    ...(rule.marketplaceId ? { marketplaceId: rule.marketplaceId } : {}),
    scopedTo: rule.scopedTo,
    frontmatter: rule.frontmatter,
    ...(rule.isRequired !== undefined ? { isRequired: rule.isRequired } : {}),
  }
}

export interface ReadContextState {
  cursorRules: ParsedCursorRule[]
  agentSkills: ParsedAgentSkill[]
  workspacePaths: string[]
  /** Rule/Skill 文件已由模型直接读取或已作为关联上下文注入。 */
  readPaths: Set<string>
}

export function collectReadContextAttachments(
  state: ReadContextState,
  readPath: string,
): { rules: ParsedCursorRule[], skills: ParsedAgentSkill[] } {
  const normalizedReadPath = posix.normalize(normalizePath(readPath))
  for (const existingPath of [...state.readPaths])
    state.readPaths.add(posix.normalize(normalizePath(existingPath)))
  const rules = state.cursorRules
    .filter(rule => isAutoAttachedRule(rule, state.workspacePaths))
    .filter(rule => !!rule.fullPath && !state.readPaths.has(posix.normalize(normalizePath(rule.fullPath))))
    .filter(rule => ruleMatchesReadPath(rule, normalizedReadPath))
    .sort((left, right) => left.fullPath.localeCompare(right.fullPath))
  const skills = state.agentSkills
    .filter(skill => !state.readPaths.has(posix.normalize(normalizePath(skill.fullPath))))
    .filter(skill => skillMatchesReadPath(skill, normalizedReadPath, state.workspacePaths))
    .sort((left, right) => left.fullPath.localeCompare(right.fullPath))

  for (const rule of rules)
    state.readPaths.add(posix.normalize(normalizePath(rule.fullPath)))
  for (const skill of skills)
    state.readPaths.add(posix.normalize(normalizePath(skill.fullPath)))
  state.readPaths.add(normalizedReadPath)
  return { rules, skills }
}
