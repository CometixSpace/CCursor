import { structuredPatch } from 'diff'
import { str } from '../shared'
import type { ToolRegistryEntry } from '../types'

// ── Patch 解析器 (移植自 Codex apply-patch crate) ──

interface UpdateFileChunk {
  changeContext: string | null
  oldLines: string[]
  newLines: string[]
  isEndOfFile: boolean
}

export interface ParsedPatch {
  action: 'add' | 'update' | 'delete'
  path: string
  movePath?: string
  addContents?: string
  chunks?: UpdateFileChunk[]
}

export function parsePatch(patch: string): ParsedPatch | null {
  const lines = patch.trim().replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  let i = 0

  while (i < lines.length && !lines[i].startsWith('*** Begin Patch'))
    i++
  if (i >= lines.length)
    return null
  i++

  let endIdx = lines.length - 1
  while (endIdx > i && !lines[endIdx].startsWith('*** End Patch'))
    endIdx--

  if (i > endIdx)
    return null

  const bodyLines = lines.slice(i, endIdx)
  if (bodyLines.length === 0)
    return null

  const headerLine = bodyLines[0].trim()

  // *** Add File: <path>
  if (headerLine.startsWith('*** Add File: ')) {
    const path = headerLine.slice('*** Add File: '.length).trim()
    const addLines: string[] = []
    for (let j = 1; j < bodyLines.length; j++) {
      const line = bodyLines[j]
      if (line.startsWith('+'))
        addLines.push(line.slice(1))
    }
    return { action: 'add', path, addContents: `${addLines.join('\n')}\n` }
  }

  // *** Delete File: <path>
  if (headerLine.startsWith('*** Delete File: ')) {
    const path = headerLine.slice('*** Delete File: '.length).trim()
    return { action: 'delete', path }
  }

  // *** Update File: <path>
  if (headerLine.startsWith('*** Update File: ')) {
    const path = headerLine.slice('*** Update File: '.length).trim()
    let j = 1
    let movePath: string | undefined

    // Optional: *** Move to: <path>
    if (j < bodyLines.length && bodyLines[j].startsWith('*** Move to: ')) {
      movePath = bodyLines[j].slice('*** Move to: '.length).trim()
      j++
    }

    const chunks: UpdateFileChunk[] = []
    while (j < bodyLines.length) {
      // 跳过空行
      if (bodyLines[j].trim() === '') {
        j++
        continue
      }
      // 遇到下一个 *** 标记 → 结束
      if (bodyLines[j].startsWith('***'))
        break

      const [chunk, consumed] = parseUpdateFileChunk(bodyLines, j, chunks.length === 0)
      if (!chunk)
        break
      chunks.push(chunk)
      j += consumed
    }

    if (chunks.length === 0)
      return null

    return { action: 'update', path, movePath, chunks }
  }

  return null
}

function parseUpdateFileChunk(
  lines: string[],
  start: number,
  allowMissingContext: boolean,
): [UpdateFileChunk | null, number] {
  if (start >= lines.length)
    return [null, 0]

  let changeContext: string | null = null
  let startIndex = start

  if (lines[start] === '@@') {
    startIndex = start + 1
  }
  else if (lines[start].startsWith('@@ ')) {
    changeContext = lines[start].slice(3).trim()
    startIndex = start + 1
  }
  else if (!allowMissingContext) {
    return [null, 0]
  }

  const chunk: UpdateFileChunk = {
    changeContext,
    oldLines: [],
    newLines: [],
    isEndOfFile: false,
  }
  let parsed = 0
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i]

    if (line === '*** End of File') {
      chunk.isEndOfFile = true
      parsed++
      break
    }

    const firstChar = line.length > 0 ? line[0] : null
    if (firstChar === ' ') {
      chunk.oldLines.push(line.slice(1))
      chunk.newLines.push(line.slice(1))
    }
    else if (firstChar === '+') {
      chunk.newLines.push(line.slice(1))
    }
    else if (firstChar === '-') {
      chunk.oldLines.push(line.slice(1))
    }
    else if (line === '') {
      // 空行 = 空 context line
      chunk.oldLines.push('')
      chunk.newLines.push('')
    }
    else {
      if (parsed === 0)
        return [null, 0]
      break
    }
    parsed++
  }

  if (parsed === 0)
    return [null, 0]

  return [chunk, (startIndex - start) + parsed]
}

// ── seekSequence: 4 级降级匹配 (移植自 Codex) ──

function normalizeTextForCursorWrite(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function normalizeUnicode(s: string): string {
  return s.trim().replace(/./g, (c) => {
    switch (c) {
      // dashes → ASCII -
      case '\u2010': case '\u2011': case '\u2012': case '\u2013':
      case '\u2014': case '\u2015': case '\u2212':
        return '-'
      // curly single quotes → '
      case '\u2018': case '\u2019': case '\u201A': case '\u201B':
        return '\''
      // curly double quotes → "
      case '\u201C': case '\u201D': case '\u201E': case '\u201F':
        return '"'
      // non-breaking/special spaces → space
      case '\u00A0': case '\u2002': case '\u2003': case '\u2004':
      case '\u2005': case '\u2006': case '\u2007': case '\u2008':
      case '\u2009': case '\u200A': case '\u202F': case '\u205F':
      case '\u3000':
        return ' '
      default:
        return c
    }
  })
}

function seekSequence(
  lines: string[],
  pattern: string[],
  start: number,
  eof: boolean,
): number | null {
  if (pattern.length === 0)
    return start
  if (pattern.length > lines.length)
    return null

  const searchStart = eof && lines.length >= pattern.length
    ? lines.length - pattern.length
    : start
  const limit = lines.length - pattern.length

  // Level 1: exact match
  for (let i = searchStart; i <= limit; i++) {
    let ok = true
    for (let k = 0; k < pattern.length; k++) {
      if (lines[i + k] !== pattern[k]) { ok = false; break }
    }
    if (ok) return i
  }

  // Level 2: trim trailing whitespace
  for (let i = searchStart; i <= limit; i++) {
    let ok = true
    for (let k = 0; k < pattern.length; k++) {
      if (lines[i + k].trimEnd() !== pattern[k].trimEnd()) { ok = false; break }
    }
    if (ok) return i
  }

  // Level 3: trim both sides
  for (let i = searchStart; i <= limit; i++) {
    let ok = true
    for (let k = 0; k < pattern.length; k++) {
      if (lines[i + k].trim() !== pattern[k].trim()) { ok = false; break }
    }
    if (ok) return i
  }

  // Level 4: Unicode punctuation normalization
  for (let i = searchStart; i <= limit; i++) {
    let ok = true
    for (let k = 0; k < pattern.length; k++) {
      if (normalizeUnicode(lines[i + k]) !== normalizeUnicode(pattern[k])) { ok = false; break }
    }
    if (ok) return i
  }

  return null
}

// ── Patch 应用器 ──

function computeReplacements(
  originalLines: string[],
  chunks: UpdateFileChunk[],
): Array<[number, number, string[]]> {
  const replacements: Array<[number, number, string[]]> = []
  let lineIndex = 0

  for (const chunk of chunks) {
    // change_context 定位
    if (chunk.changeContext) {
      const idx = seekSequence(originalLines, [chunk.changeContext], lineIndex, false)
      if (idx !== null) {
        lineIndex = idx + 1
      }
    }

    if (chunk.oldLines.length === 0) {
      // 纯添加 — 添加到文件末尾
      const insertionIdx = originalLines.length > 0 && originalLines[originalLines.length - 1] === ''
        ? originalLines.length - 1
        : originalLines.length
      replacements.push([insertionIdx, 0, chunk.newLines.slice()])
      continue
    }

    // 尝试匹配 old_lines
    let pattern = chunk.oldLines
    let found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile)
    let newSlice = chunk.newLines

    // 尾部空行容错 — 与 Codex 一致
    if (found === null && pattern.length > 0 && pattern[pattern.length - 1] === '') {
      pattern = pattern.slice(0, -1)
      if (newSlice.length > 0 && newSlice[newSlice.length - 1] === '')
        newSlice = newSlice.slice(0, -1)
      found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile)
    }

    if (found !== null) {
      replacements.push([found, pattern.length, newSlice.slice()])
      lineIndex = found + pattern.length
    }
    // 匹配失败 → 跳过此 chunk (不中断整个 patch)
  }

  replacements.sort((a, b) => a[0] - b[0])
  return replacements
}

function applyReplacements(lines: string[], replacements: Array<[number, number, string[]]>): string[] {
  const result = [...lines]
  // 从后往前 splice，避免偏移
  for (let r = replacements.length - 1; r >= 0; r--) {
    const [startIdx, oldLen, newSegment] = replacements[r]
    result.splice(startIdx, oldLen, ...newSegment)
  }
  return result
}

export function applyPatchToContent(patch: ParsedPatch, beforeContent: string): string {
  if (patch.action === 'add')
    return normalizeTextForCursorWrite(patch.addContents ?? '')

  if (patch.action === 'delete')
    throw new Error('ApplyPatch Delete File is not supported by editToolCall; use the Delete tool instead')

  if (patch.movePath)
    throw new Error('Move/Rename is not supported by ApplyPatch in BYOK yet')

  // Cursor agent-exec 文本协议使用 LF canonical text：
  // client read 会把 CRLF 归一化成 LF，client write 会按目标文件格式把 LF 恢复为 CRLF。
  // 因此 server 侧 ApplyPatch 结果必须保持 LF，不能按原文件 CRLF join，否则会被客户端二次转换为 \r\r\n。
  const content = normalizeTextForCursorWrite(beforeContent)
  const originalLines = content.split('\n')

  // 去掉尾部空元素 (与 Codex 一致: split('\n') 对 "foo\n" 产生 ["foo", ""])
  if (originalLines.length > 0 && originalLines[originalLines.length - 1] === '')
    originalLines.pop()

  const replacements = computeReplacements(originalLines, patch.chunks ?? [])
  if (replacements.length === 0)
    throw new Error(`Patch did not apply to ${patch.path}: no hunks matched`)
  const newLines = applyReplacements(originalLines, replacements)

  // 确保尾部换行
  if (newLines.length === 0 || newLines[newLines.length - 1] !== '')
    newLines.push('')

  return normalizeTextForCursorWrite(newLines.join('\n'))
}

// ── Diff 生成 (使用 diff 库) ──

export function computeDiffFromContents(
  oldContent: string,
  newContent: string,
): { diffString: string, linesAdded: number, linesRemoved: number } {
  const patch = structuredPatch('file', 'file', oldContent, newContent, undefined, undefined, { context: 3 })

  let linesAdded = 0
  let linesRemoved = 0
  const parts: string[] = ['--- a', '+++ b']

  for (const hunk of patch.hunks) {
    parts.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`)
    for (const line of hunk.lines) {
      if (line.startsWith('+'))
        linesAdded++
      else if (line.startsWith('-'))
        linesRemoved++
      parts.push(line)
    }
  }

  return { diffString: parts.join('\n'), linesAdded, linesRemoved }
}

// ── OpenAI 工具定义 ──
// ApplyPatch 只有 OpenAI provider 使用

const OPENAI_DESCRIPTION = `Use this tool to edit files.
Your patch language is a stripped-down, file-oriented diff format designed to be easy to parse and safe to apply. You can think of it as a high-level envelope:

*** Begin Patch
[ one file section ]
*** End Patch

Within that envelope, you get one file operation.
You MUST include a header to specify the action you are taking.
Each operation starts with one of two headers:

*** Add File: <path> - create a new file. Every following line is a + line (the initial contents).
*** Update File: <path> - patch an existing file in place (optionally with a rename).

Then one or more "hunks", each introduced by @@ (optionally followed by a hunk header).
Within a hunk each line starts with:

For instructions on [context_before] and [context_after]:
- By default, show 3 lines of code immediately above and 3 lines immediately below each change. If a change is within 3 lines of a previous change, do NOT duplicate the first change's [context_after] lines in the second change's [context_before] lines.
- If 3 lines of context is insufficient to uniquely identify the snippet of code within the file, use the @@ operator to indicate the class or function to which the snippet belongs.
- If a code block is repeated so many times in a class or function such that even a single @@ statement and 3 lines of context cannot uniquely identify the snippet of code, you can use multiple @@ statements to jump to the right context.

It is important to remember:
- You must only include one file per call
- You must include a header with your intended action (Add/Update)
- You must prefix new lines with \` +\` even when creating a new file

All file paths must be absolute paths. Make sure to read the file before applying a patch to get the latest file content, unless you are creating a new file.`

function getPatchString(input: Record<string, unknown> | string): string {
  return typeof input === 'string'
    ? input
    : typeof input.patch === 'string'
      ? input.patch
      : str(input)
}

const OPENAI = {
  name: 'ApplyPatch',
  description: OPENAI_DESCRIPTION,
  // 官方 Cursor 用 { type: 'string' }（与 OpenAI 的专有协议），
  // 但标准 OpenAI API 强制要求 type: 'object'。BYOK 走标准 API，必须包装。
  inputSchema: {
    type: 'object',
    required: ['patch'],
    properties: {
      patch: {
        type: 'string',
        description: 'The patch content following the format described above. Must obey the lark grammar and start with "*** Begin Patch" and end with "*** End Patch". All file paths must be absolute paths.',
      },
    },
  },
}

export const ApplyPatchTool: ToolRegistryEntry = {
  canonicalName: 'ApplyPatch',
  aliases: ['ApplyPatch'],
  cursorToolType: 'editToolCall',
  execArgsType: 'writeArgs',
  llmToolByProvider: {
    // ApplyPatch 仅 OpenAI provider 使用
    openai: OPENAI,
  },
  buildStartedArgs: (input) => {
    // 官方: toolCallStarted 只发 path，不含 streamContent
    // patch 内容通过 editToolCallDelta 发送
    const patchStr = getPatchString(input)
    const parsed = parsePatch(patchStr)
    if (!parsed)
      throw new Error('Failed to parse patch: invalid format')
    return { path: parsed.path }
  },
  buildExecArgs: (input, callId, options) => {
    const plan = ApplyPatchTool.buildEditPlan?.(input, callId, options)
    return {
      path: plan?.path ?? '',
      patchText: plan?.kind === 'applyPatch' ? plan.patchText : '',
      streamContent: plan?.streamContent ?? '',
      toolCallId: callId,
    }
  },
  buildEditPlan: (input) => {
    const patchStr = getPatchString(input)
    const parsed = parsePatch(patchStr)
    if (!parsed)
      throw new Error('Failed to parse patch: invalid format')
    // streamContent = patch 格式内容（用于 editToolCallDelta）
    const normalizedPatchStr = patchStr.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    const patchBody = normalizedPatchStr
      .replace(/^\*\*\* Begin Patch\n/, '')
      .replace(/^\*\*\* (?:Add|Update|Delete) File:.*\n/, '')
      .replace(/\*\*\* End Patch\s*$/, '')
      .trim()
    return {
      kind: 'applyPatch',
      path: parsed.path,
      patchText: patchStr,
      parsedPatch: parsed,
      streamContent: `${patchBody}\n*** End Patch\n`,
    }
  },
}
