import { Autocomplete } from './autocomplete'
import { CustomSelect } from './custom-select'

/** Level 选项按 Provider Type 分化 */
const THINKING_LEVELS_ANTHROPIC = [
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'xhigh', label: 'xhigh' },
  { value: 'max', label: 'max' },
]
const THINKING_LEVELS_OPENAI = [
  { value: 'minimal', label: 'minimal' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'xhigh', label: 'xhigh' },
  { value: 'max', label: 'max' },
]
const THINKING_LEVELS_GEMINI = [
  { value: 'minimal', label: 'minimal' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
]
const QS_LEVELS_ANTHROPIC = THINKING_LEVELS_ANTHROPIC.map(l => l.value)
const QS_LEVELS_OPENAI = THINKING_LEVELS_OPENAI.map(l => l.value)
const QS_LEVELS_GEMINI = THINKING_LEVELS_GEMINI.map(l => l.value)

/**
 * 单个 Model 卡片 — 在 x-for="m in ..." 作用域内使用
 *
 * 文本/数字输入框使用 x-effect + activeElement 守卫:
 *   - 非焦点时: x-effect 同步 store 值到 DOM (外部变更 / 初始化)
 *   - 焦点时: 只由 x-on:input 写 store, 不回写 DOM, 避免光标跳动
 *
 * apiModel 输入不再每次 keystroke 同步 m.id (会导致 x-for key 变化 → DOM 销毁重建 → 脱焦),
 * 改为 blur 时调用 syncModelId() 一次性同步。
 */
export function ModelCard() {
  return (
    <div class="model-item" x-data="{ me: {} }" x-effect="me = $store.app.getModelErrors(p.id, m.id)">
      <div class="model-head" x-on:click="$store.app.toggleModelExpand(p.id, m.id)">
        <span class="acc-caret" x-text="$store.app.modelExpanded[p.id]?.[m.id] ? '▼' : '▶'"></span>
        <span class="model-title" x-text="m.displayName || m.apiModel || m.id || '(unnamed model)'"></span>
        {/* 右对齐的 defaultOn 开关 — 控制模型是否注册到 Cursor 选择器。
            stop 阻止点击冒泡触发折叠/展开 */}
        <label
          class="model-switch"
          title="启用后模型出现在 Cursor 选择器列表中"
          {...{ 'x-on:click.stop': '' }}
        >
          <input
            type="checkbox"
            x-bind:checked="m.defaultOn === true"
            x-on:change="$store.app.updateModelField(p.id, m.id, 'defaultOn', $event.target.checked)"
          />
          <span class="model-switch-track"></span>
          <span class="model-switch-knob"></span>
        </label>
      </div>
      <div class="model-body" x-show="$store.app.modelExpanded[p.id]?.[m.id]" x-cloak>
        {/* API Model + autocomplete */}
        <div class="field autocomplete" {...{ 'x-on:click.outside': '$store.app.acClose()' }}>
          <label>
            {'API Model '}
            <span style="opacity:.5;font-weight:normal;text-transform:none">(fuzzy catalog search)</span>
          </label>
          <div class="ac-input-wrap">
            <input
              type="text"
              x-ref="acInput"
              x-effect="if(document.activeElement !== $el) $el.value = m.apiModel || ''"
              x-on:input="$store.app.updateModelField(p.id, m.id, 'apiModel', $event.target.value); $store.app.searchCatalog(p.id, m.id, $event.target.value)"
              {...{ 'x-on:blur': '$store.app.syncModelId(p.id, m.id)' }}
              {...{ 'x-on:keydown.arrow-down.prevent': '$store.app.acNavigate(1)' }}
              {...{ 'x-on:keydown.arrow-up.prevent': '$store.app.acNavigate(-1)' }}
              {...{ 'x-on:keydown.enter.prevent': '$store.app.acSelect(p.id, m.id)' }}
              {...{ 'x-on:keydown.escape.prevent': '$store.app.acClose()' }}
              autocomplete="off"
              x-bind:class="{'invalid': me?.apiModel}"
            />
            <button
              class="ac-toggle"
              type="button"
              title="Browse model catalog"
              tabindex={-1}
              {...{ 'x-on:mousedown.prevent': '$store.app.toggleCatalog(p.id, m.id, $refs.acInput)' }}
            >
              <span class="ac-toggle-caret" x-bind:class="{ 'open': $store.app.ac?.pid === p.id && $store.app.ac?.mid === m.id }">&#x25BE;</span>
            </button>
          </div>
          <div class="err" x-show="me?.apiModel" x-text="me?.apiModel"></div>
          <Autocomplete />
        </div>

        {/* Display Name — Cursor 客户端所有 UI 路径 (picker / inputbox / command palette)
            都走 clientDisplayName fallback, 不需要独立的 short name */}
        <div class="field">
          <label>
            {'Display Name '}
            <span style="color:var(--vscode-errorForeground);font-weight:normal" x-show="me?.displayName">*</span>
          </label>
          <input
            type="text"
            x-effect="if(document.activeElement !== $el) $el.value = m.displayName || ''"
            x-on:input="$store.app.updateModelField(p.id, m.id, 'displayName', $event.target.value)"
            x-bind:class="{'invalid': me?.displayName}"
          />
          <div class="err" x-show="me?.displayName" x-text="me?.displayName"></div>
        </div>

        {/* Capabilities grid */}
        <div class="caps">
          <label class="check">
            <input type="checkbox" x-bind:checked="m.supportsAgent !== false" x-on:change="$store.app.updateModelField(p.id, m.id, 'supportsAgent', $event.target.checked)" />
            {' Agent'}
          </label>
          <label class="check">
            <input type="checkbox" x-bind:checked="m.supportsImages !== false" x-on:change="$store.app.updateModelField(p.id, m.id, 'supportsImages', $event.target.checked)" />
            {' Images'}
          </label>
          <label class="check">
            <input type="checkbox" x-bind:checked="m.supportsCmdK !== false" x-on:change="$store.app.updateModelField(p.id, m.id, 'supportsCmdK', $event.target.checked)" />
            {' Cmd+K'}
          </label>
          <label class="check" title="Fast mode (OpenAI: service_tier=priority / Anthropic: fast-mode beta)">
            <input type="checkbox" x-bind:checked="m.fastMode === true" x-on:change="$store.app.updateModelField(p.id, m.id, 'fastMode', $event.target.checked || undefined)" />
            {' Fast'}
          </label>
          <label class="check thinking-cell" title="Enables extended reasoning">
            <input type="checkbox" x-bind:checked="m.thinking === true" x-on:change="$store.app.updateModelField(p.id, m.id, 'thinking', $event.target.checked)" />
            {' Thinking'}
          </label>
          {/* ── Thinking 子控件 ──
              thinking=false → 灰色提示
              Anthropic → Level/Budget 模式切换器,互斥
              OpenAI → Level 下拉 (thinking 开启时自动设 medium)
              Gemini → Level/Budget 模式切换器,互斥 (Level 需 2.5+; Budget 兼容旧模型) */}
          <template x-if="!m.thinking">
            <div class="check thinking-sub-disabled">
              <span style="opacity:.35;font-size:10px">—</span>
            </div>
          </template>

          {/* ── Anthropic: 模式选择 Level ↔ Budget ── */}
          <template x-if="m.thinking && p.type === 'anthropic'">
            <div class="check thinking-mode-group">
              <div class="thinking-mode-tabs">
                <button
                  class="thinking-mode-tab"
                  x-bind:class="{'active': !!m.thinkingLevel && !m.thinkingBudgetTokens}"
                  x-on:click="$store.app.setThinkingMode(p.id, m.id, 'level')"
                  title="Adaptive thinking (4.5-opus / 4.6+)"
                >
                  Level
                </button>
                <button
                  class="thinking-mode-tab"
                  x-bind:class="{'active': !m.thinkingLevel && !!m.thinkingBudgetTokens}"
                  x-on:click="$store.app.setThinkingMode(p.id, m.id, 'budget')"
                  title="Legacy budget (Claude 4.x)"
                >
                  Budget
                </button>
              </div>
              <div class="thinking-mode-value" x-show="!!m.thinkingLevel">
                <CustomSelect
                  valueExpr="m.thinkingLevel || ''"
                  changeExpr="$store.app.updateModelField(p.id, m.id, 'thinkingLevel', $value || undefined)"
                  options={THINKING_LEVELS_ANTHROPIC}
                  title="Anthropic effort: low → max"
                />
              </div>
              <div class="thinking-mode-value" x-show="!m.thinkingLevel">
                <input
                  type="number"
                  x-effect="if(document.activeElement !== $el) $el.value = m.thinkingBudgetTokens ?? ''"
                  x-on:input="$store.app.updateModelNumber(p.id, m.id, 'thinkingBudgetTokens', $event.target.value)"
                  placeholder="≥ 1024"
                  title="budget_tokens (≥ 1024, < maxOutputTokens)"
                  x-bind:class="{'invalid': me?.thinkingBudgetTokens}"
                  style="height:20px;padding:0 4px;font-size:10px;width:80px"
                />
                <div class="err" x-show="me?.thinkingBudgetTokens" x-text="me?.thinkingBudgetTokens" style="font-size:9px"></div>
              </div>
            </div>
          </template>

          {/* ── OpenAI: Level only ── */}
          <template x-if="m.thinking && (p.type === 'openai-chat' || p.type === 'openai-responses')">
            <div class="check thinking-level-cell">
              <CustomSelect
                valueExpr="m.thinkingLevel || 'medium'"
                changeExpr="$store.app.updateModelField(p.id, m.id, 'thinkingLevel', $value)"
                options={THINKING_LEVELS_OPENAI}
                title="reasoning_effort"
              />
            </div>
          </template>

          {/* ── Gemini: 模式选择 Level ↔ Budget ──
              Level (thinkingLevel) 需 Gemini 2.5+; Budget (thinkingBudget tokens) 兼容旧模型并可精确控制。
              后端 gemini.ts 优先级: budget > level > auto(-1)。 */}
          <template x-if="m.thinking && p.type === 'gemini'">
            <div class="check thinking-mode-group">
              <div class="thinking-mode-tabs">
                <button
                  class="thinking-mode-tab"
                  x-bind:class="{'active': !!m.thinkingLevel && !m.thinkingBudgetTokens}"
                  x-on:click="$store.app.setThinkingMode(p.id, m.id, 'level')"
                  title="thinkingLevel (Gemini 2.5+)"
                >
                  Level
                </button>
                <button
                  class="thinking-mode-tab"
                  x-bind:class="{'active': !m.thinkingLevel && !!m.thinkingBudgetTokens}"
                  x-on:click="$store.app.setThinkingMode(p.id, m.id, 'budget')"
                  title="thinkingBudget (兼容旧模型 / 精确控制)"
                >
                  Budget
                </button>
              </div>
              <div class="thinking-mode-value" x-show="!!m.thinkingLevel">
                <CustomSelect
                  valueExpr="m.thinkingLevel || ''"
                  changeExpr="$store.app.updateModelField(p.id, m.id, 'thinkingLevel', $value || undefined)"
                  options={THINKING_LEVELS_GEMINI}
                  title="Gemini thinkingLevel: minimal → high"
                />
              </div>
              <div class="thinking-mode-value" x-show="!m.thinkingLevel">
                <input
                  type="number"
                  x-effect="if(document.activeElement !== $el) $el.value = m.thinkingBudgetTokens ?? ''"
                  x-on:input="$store.app.updateModelNumber(p.id, m.id, 'thinkingBudgetTokens', $event.target.value)"
                  placeholder="tokens / -1 auto"
                  title="thinkingBudget (tokens; -1=auto, 0=off on supported models)"
                  x-bind:class="{'invalid': me?.thinkingBudgetTokens}"
                  style="height:20px;padding:0 4px;font-size:10px;width:80px"
                />
                <div class="err" x-show="me?.thinkingBudgetTokens" x-text="me?.thinkingBudgetTokens" style="font-size:9px"></div>
              </div>
            </div>
          </template>
        </div>

        {/* Context + Output limits */}
        <div class="field-row">
          <div class="field">
            <label>
              {'Context Token Limit '}
              <span style="color:var(--vscode-errorForeground);font-weight:normal">*</span>
            </label>
            <input
              type="number"
              x-effect="if(document.activeElement !== $el) $el.value = m.contextTokenLimit ?? ''"
              x-on:input="$store.app.updateModelNumber(p.id, m.id, 'contextTokenLimit', $event.target.value)"
              placeholder="required"
              x-bind:class="{'invalid': me?.contextTokenLimit}"
            />
            <div class="err" x-show="me?.contextTokenLimit" x-text="me?.contextTokenLimit"></div>
          </div>
          <div class="field">
            <label>
              {'Max Output Tokens '}
              <span style="color:var(--vscode-errorForeground);font-weight:normal" x-show="m.noMaxTokens !== true">*</span>
            </label>
            <div style="display:flex;align-items:center;gap:6px">
              {/* Off 仅切换 noMaxTokens 标志, 不清空 maxOutputTokens —
                  发送侧 (providerRuntime: noMaxTokens ? undefined : maxOutputTokens) 已守卫,
                  保留值才能在取消 Off 后恢复, 且禁用态灰显原值更直观 */}
              <input
                type="number"
                x-effect="if(document.activeElement !== $el) $el.value = m.maxOutputTokens ?? ''"
                x-on:input="$store.app.updateModelNumber(p.id, m.id, 'maxOutputTokens', $event.target.value)"
                placeholder="required"
                x-bind:placeholder="m.noMaxTokens === true ? 'disabled (omitted)' : 'required'"
                x-bind:disabled="m.noMaxTokens === true"
                title="Maximum tokens per LLM response"
                x-bind:class="{'invalid': me?.maxOutputTokens}"
                style="flex:1"
              />
              <label class="check" style="white-space:nowrap;font-size:10px" title="Don't send max_output_tokens to LLM (for gateways that reject this param)">
                <input
                  type="checkbox"
                  x-bind:checked="m.noMaxTokens === true"
                  x-on:change="$store.app.updateModelField(p.id, m.id, 'noMaxTokens', $event.target.checked)"
                />
                {' Off'}
              </label>
            </div>
            <div class="err" x-show="me?.maxOutputTokens" x-text="me?.maxOutputTokens"></div>
          </div>
        </div>

        <div class="field-row">
          <div class="field">
            <label>Input / 1M</label>
            <input
              type="text"
              x-effect="if(document.activeElement !== $el) $el.value = m.inputCostPerMillion ?? ''"
              x-on:input="$store.app.updateModelField(p.id, m.id, 'inputCostPerMillion', $event.target.value || undefined)"
              placeholder="0"
              title="Price per million input tokens in the selected currency"
            />
          </div>
          <div class="field">
            <label>Output / 1M</label>
            <input
              type="text"
              x-effect="if(document.activeElement !== $el) $el.value = m.outputCostPerMillion ?? ''"
              x-on:input="$store.app.updateModelField(p.id, m.id, 'outputCostPerMillion', $event.target.value || undefined)"
              placeholder="0"
              title="Price per million output tokens in the selected currency"
            />
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>Cache read / 1M</label>
            <input
              type="text"
              x-effect="if(document.activeElement !== $el) $el.value = m.cacheReadCostPerMillion ?? ''"
              x-on:input="$store.app.updateModelField(p.id, m.id, 'cacheReadCostPerMillion', $event.target.value || undefined)"
              placeholder="0"
            />
          </div>
          <div class="field">
            <label>Cache write / 1M</label>
            <input
              type="text"
              x-effect="if(document.activeElement !== $el) $el.value = m.cacheCreationCostPerMillion ?? ''"
              x-on:input="$store.app.updateModelField(p.id, m.id, 'cacheCreationCostPerMillion', $event.target.value || undefined)"
              placeholder="0"
            />
          </div>
        </div>
        <div class="field">
          <label>Cost multiplier</label>
          <input
            type="text"
            x-effect="if(document.activeElement !== $el) $el.value = m.costMultiplier ?? ''"
            x-on:input="$store.app.updateModelField(p.id, m.id, 'costMultiplier', $event.target.value || undefined)"
            placeholder="1"
            title="Applied after the four token buckets, e.g. 1.1 for a 10% markup"
          />
        </div>

        {/* Tooltip */}
        <div class="field">
          <label>Tooltip Markdown (hover in model picker)</label>
          <textarea
            rows={2}
            x-effect="if(document.activeElement !== $el) $el.value = m.tooltipMarkdown || ''"
            x-on:input="$store.app.updateModelField(p.id, m.id, 'tooltipMarkdown', $event.target.value)"
            placeholder="**Model name**<br/>Short description"
          >
          </textarea>
        </div>

        {/* ── QuickSwitch Options (accordion) ── */}
        <div class="qs-section" x-data="{ qsOpen: false }">
          <button class="qs-header" x-on:click="qsOpen = !qsOpen" type="button">
            <span class="qs-caret" x-text="qsOpen ? '▼' : '▶'"></span>
            <span>QuickSwitch Options</span>
            <span class="qs-hint" title="Checked options appear in Cursor's model picker Edit panel for runtime switching.">?</span>
          </button>
          <div class="qs-body" x-show="qsOpen" x-cloak>

            {/* ── Anthropic: Thinking Toggle + Effort Levels ── */}
            <template x-if="p.type === 'anthropic'">
              <div class="qs-item" title="Expose Thinking on/off toggle in Edit panel">
                <div class="qs-row">
                  <span class="qs-label">Thinking Toggle</span>
                  <label class="qs-switch">
                    <input type="checkbox" x-bind:checked="m.parameters?.thinking === true" x-on:change="$store.app.setEditParam(p.id, m.id, 'thinking', $event.target.checked || undefined)" />
                    <span class="qs-switch-track"></span>
                    <span class="qs-switch-knob"></span>
                  </label>
                </div>
              </div>
            </template>
            <template x-if="p.type === 'anthropic'">
              <div class="qs-item" title="Expose effort level selector in Edit panel">
                <div class="qs-row">
                  <span class="qs-label">Effort Levels</span>
                  <label class="qs-switch">
                    <input type="checkbox" x-bind:checked="Array.isArray(m.parameters?.effort)" x-on:change={`$store.app.setEditParam(p.id, m.id, 'effort', $event.target.checked ? ${JSON.stringify(QS_LEVELS_ANTHROPIC)} : undefined)`} />
                    <span class="qs-switch-track"></span>
                    <span class="qs-switch-knob"></span>
                  </label>
                </div>
                <template x-if="Array.isArray(m.parameters?.effort)">
                  <div class="qs-item-body">
                    <div class="qs-chips">
                      {QS_LEVELS_ANTHROPIC.map(lv => (
                        <label class="qs-chip" key={lv}>
                          <input type="checkbox" x-bind:checked={`m.parameters?.effort?.includes('${lv}')`} x-on:change={`$store.app.toggleEditParamArrayItem(p.id, m.id, 'effort', '${lv}', $event.target.checked)`} />
                          <span>{lv}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                </template>
              </div>
            </template>

            {/* ── Gemini: Thinking Toggle + Effort Levels (different set) ── */}
            <template x-if="p.type === 'gemini'">
              <div class="qs-item" title="Expose Thinking on/off toggle in Edit panel">
                <div class="qs-row">
                  <span class="qs-label">Thinking Toggle</span>
                  <label class="qs-switch">
                    <input type="checkbox" x-bind:checked="m.parameters?.thinking === true" x-on:change="$store.app.setEditParam(p.id, m.id, 'thinking', $event.target.checked || undefined)" />
                    <span class="qs-switch-track"></span>
                    <span class="qs-switch-knob"></span>
                  </label>
                </div>
              </div>
            </template>
            <template x-if="p.type === 'gemini'">
              <div class="qs-item" title="Expose effort level selector in Edit panel">
                <div class="qs-row">
                  <span class="qs-label">Effort Levels</span>
                  <label class="qs-switch">
                    <input type="checkbox" x-bind:checked="Array.isArray(m.parameters?.effort)" x-on:change={`$store.app.setEditParam(p.id, m.id, 'effort', $event.target.checked ? ${JSON.stringify(QS_LEVELS_GEMINI)} : undefined)`} />
                    <span class="qs-switch-track"></span>
                    <span class="qs-switch-knob"></span>
                  </label>
                </div>
                <template x-if="Array.isArray(m.parameters?.effort)">
                  <div class="qs-item-body">
                    <div class="qs-chips">
                      {QS_LEVELS_GEMINI.map(lv => (
                        <label class="qs-chip" key={lv}>
                          <input type="checkbox" x-bind:checked={`m.parameters?.effort?.includes('${lv}')`} x-on:change={`$store.app.toggleEditParamArrayItem(p.id, m.id, 'effort', '${lv}', $event.target.checked)`} />
                          <span>{lv}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                </template>
              </div>
            </template>

            {/* ── OpenAI: Reasoning Levels (single enum, None auto-prepended) ── */}
            <template x-if="p.type === 'openai-chat' || p.type === 'openai-responses'">
              <div class="qs-item" title="Expose reasoning level selector in Edit panel (None = off)">
                <div class="qs-row">
                  <span class="qs-label">Reasoning Levels</span>
                  <label class="qs-switch">
                    <input type="checkbox" x-bind:checked="Array.isArray(m.parameters?.reasoning)" x-on:change={`$store.app.setEditParam(p.id, m.id, 'reasoning', $event.target.checked ? ${JSON.stringify(QS_LEVELS_OPENAI)} : undefined)`} />
                    <span class="qs-switch-track"></span>
                    <span class="qs-switch-knob"></span>
                  </label>
                </div>
                <template x-if="Array.isArray(m.parameters?.reasoning)">
                  <div class="qs-item-body">
                    <div class="qs-chips">
                      {QS_LEVELS_OPENAI.map(lv => (
                        <label class="qs-chip" key={lv}>
                          <input type="checkbox" x-bind:checked={`m.parameters?.reasoning?.includes('${lv}')`} x-on:change={`$store.app.toggleEditParamArrayItem(p.id, m.id, 'reasoning', '${lv}', $event.target.checked)`} />
                          <span>{lv}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                </template>
              </div>
            </template>

            {/* Context options */}
            <div class="qs-item" title="Expose context window size selector in Edit panel">
              <div class="qs-row">
                <span class="qs-label">Context Options</span>
                <label class="qs-switch">
                  <input type="checkbox" x-bind:checked="Array.isArray(m.parameters?.context)" x-on:change="$store.app.setEditParam(p.id, m.id, 'context', $event.target.checked ? [m.contextTokenLimit || 200000] : undefined)" />
                  <span class="qs-switch-track"></span>
                  <span class="qs-switch-knob"></span>
                </label>
              </div>
              <template x-if="Array.isArray(m.parameters?.context)">
                <div class="qs-item-body">
                  <div class="qs-tags">
                    <template x-for="(cv, ci) in (m.parameters?.context || [])">
                      <span class="qs-tag">
                        <span x-text="cv >= 1000000 ? (cv/1000000)+'M' : Math.round(cv/1000)+'K'"></span>
                        <button class="qs-tag-x" x-on:click="$store.app.removeEditParamArrayIndex(p.id, m.id, 'context', ci)">&times;</button>
                      </span>
                    </template>
                    <input
                      type="number"
                      class="qs-tag-input"
                      placeholder="+ token count"
                      {...{ 'x-on:keydown.enter.prevent': '$store.app.addEditParamContextValue(p.id, m.id, parseInt($event.target.value)); $event.target.value = ""' }}
                    />
                  </div>
                </div>
              </template>
            </div>

            {/* Fast toggle */}
            <div class="qs-item" title="Expose Fast mode toggle in Edit panel">
              <div class="qs-row">
                <span class="qs-label">Fast Toggle</span>
                <label class="qs-switch">
                  <input type="checkbox" x-bind:checked="m.parameters?.fast === true" x-on:change="$store.app.setEditParam(p.id, m.id, 'fast', $event.target.checked || undefined)" />
                  <span class="qs-switch-track"></span>
                  <span class="qs-switch-knob"></span>
                </label>
              </div>
            </div>

          </div>
        </div>

        <div class="actions-bar">
          <button class="danger tiny" x-on:click="$store.app.deleteModel(p.id, m.id)">Remove Model</button>
        </div>
      </div>
    </div>
  )
}
