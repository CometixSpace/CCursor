/** Usage dashboard in the Cursor++ sidebar */
export function Usage() {
  return (
    <div class="usage-panel" x-show="$store.app.usageOpen">
      <div class="usage-hero">
        <div class="usage-today" x-text="$store.app.usage ? $store.app.formatUsageCost($store.app.usage?.summary?.totalCostFormatted) : '—'"></div>
        <div class="usage-today-label">
          <span x-text="$store.app.usageRangeLabel"></span>
          <span x-show="$store.app.usageRange !== 'today'" x-text="' · today ' + $store.app.formatUsageCost($store.app.usage?.todayCostFormatted || '')"></span>
        </div>
      </div>

      <div class="usage-toolbar">
        <select x-model="$store.app.usageRange" x-on:change="$store.app.saveUsageSettings()">
          <option value="today">Today</option>
          <option value="7d">7 days</option>
          <option value="14d">14 days</option>
          <option value="30d">30 days</option>
          <option value="month">This month</option>
        </select>
        <select x-model="$store.app.usageCurrency" x-on:change="$store.app.saveUsageSettings()">
          <option value="CNY">CNY ¥</option>
          <option value="USD">USD $</option>
        </select>
        <button
          class="tiny secondary"
          title="Status bar statistics window (resets daily or monthly)"
          x-on:click="$store.app.toggleUsageBarScope()"
          x-text="$store.app.usageBarScopeLabel"
        >
        </button>
        <button class="tiny secondary" x-on:click="$store.app.loadUsage()">Refresh</button>
      </div>

      <div class="usage-metrics" x-show="$store.app.usage">
        <div class="usage-metric">
          <span class="usage-metric-label">Cost</span>
          <span class="usage-metric-value" x-text="$store.app.usage ? $store.app.formatUsageCost($store.app.usage?.summary?.totalCostFormatted) : '—'"></span>
        </div>
        <div class="usage-metric">
          <span class="usage-metric-label">Requests</span>
          <span class="usage-metric-value" x-text="$store.app.usage?.summary?.requestCount ?? 0"></span>
        </div>
        <div class="usage-metric">
          <span class="usage-metric-label">Success</span>
          <span class="usage-metric-value" x-text="$store.app.usageSuccessLabel"></span>
        </div>
        <div class="usage-metric">
          <span class="usage-metric-label">Tokens</span>
          <span class="usage-metric-value" x-text="$store.app.formatUsageTokens($store.app.usage?.summary?.realTotalTokens)"></span>
        </div>
        <div class="usage-metric">
          <span class="usage-metric-label">Cache hit</span>
          <span class="usage-metric-value" x-text="$store.app.cacheHitLabel"></span>
        </div>
        <div class="usage-metric">
          <span class="usage-metric-label">Cache write</span>
          <span class="usage-metric-value" x-text="$store.app.formatUsageTokens($store.app.usage?.summary?.cacheWriteTokens)"></span>
        </div>
      </div>

      <div class="usage-trend" x-show="($store.app.usage?.daily?.length || 0) > 1">
        <div class="usage-trend-bars">
          <template x-for="bar in $store.app.usageDailyBars" x-bind:key="bar.date">
            <div class="usage-trend-bar" x-bind:title="bar.title">
              <div class="usage-trend-fill" x-bind:style="'height:' + bar.heightPercent + '%'"></div>
            </div>
          </template>
        </div>
        <div class="usage-trend-axis" x-show="($store.app.usage?.daily?.length || 0) > 1">
          <span x-text="$store.app.usageTrendStartLabel"></span>
          <span x-text="$store.app.usageTrendEndLabel"></span>
        </div>
      </div>

      <div class="usage-unpriced" x-show="$store.app.usage?.summary?.unpricedCount > 0">
        <span x-text="$store.app.usage?.summary?.unpricedCount"></span>
        {' unpriced requests — fill prices on model cards'}
      </div>

      <div class="usage-hint" x-show="$store.app.usage && ($store.app.usage?.summary?.requestCount === 0)">
        No records for this currency and range. Bills are stored with the currency used at request time — try the other currency.
      </div>

      <div class="usage-section-title">Providers</div>
      <div class="usage-hint">Click a name to expand its models. Unchecked providers stay recorded but are excluded from totals.</div>
      <template x-for="p in $store.app.usageProvidersVisible" x-bind:key="p.id">
        <div class="usage-provider">
          <div class="usage-provider-row">
            <input
              type="checkbox"
              x-bind:checked="p.selected"
              x-on:change="$store.app.toggleUsageProvider(p.id, $event.target.checked)"
            />
            <span
              class="usage-provider-toggle"
              x-text="$store.app.usageProviderExpanded[p.id] ? '▾' : '▸'"
              x-on:click="$store.app.toggleUsageProviderExpanded(p.id)"
            >
            </span>
            <span class="usage-check-name" x-text="p.name" x-on:click="$store.app.toggleUsageProviderExpanded(p.id)"></span>
            <span class="usage-check-cost" x-text="p.totalCostFormatted"></span>
          </div>
          <template x-if="$store.app.usageProviderExpanded[p.id]">
            <div class="usage-models">
              <template x-for="m in $store.app.usageModelsFor(p.id)" x-bind:key="m.key">
                <label class="usage-check usage-check-nested">
                  <input
                    type="checkbox"
                    x-bind:checked="m.selected"
                    x-on:change="$store.app.toggleUsageModel(m.key, $event.target.checked)"
                  />
                  <span class="usage-check-name" x-text="m.displayName"></span>
                  <span class="usage-check-cost" x-text="m.totalCostFormatted"></span>
                </label>
              </template>
              <div class="usage-empty" x-show="!$store.app.usageModelsFor(p.id).length">No models.</div>
            </div>
          </template>
        </div>
      </template>
      <button
        class="usage-show-more"
        x-show="$store.app.usageProvidersHiddenCount > 0 || $store.app.usageShowAllProviders"
        x-on:click="$store.app.usageShowAllProviders = !$store.app.usageShowAllProviders"
        x-text="$store.app.usageHiddenProvidersLabel"
      >
      </button>

      <div class="usage-section-title">Recent</div>
      <template x-if="!$store.app.usageRecentList.length">
        <div class="usage-empty">No BYOK requests in this range.</div>
      </template>
      <template x-for="item in $store.app.usageRecentList" x-bind:key="item.requestId">
        <div class="usage-row" x-on:click="$store.app.toggleUsageRecentExpanded(item.requestId)">
          <div class="usage-row-main">
            <div class="usage-row-line">
              <span class="usage-row-time" x-text="$store.app.formatUsageTime(item.createdAt)"></span>
              <span x-text="item.displayName"></span>
            </div>
            <div class="usage-row-detail" x-show="$store.app.usageRecentExpanded[item.requestId]">
              <span x-text="'↑' + $store.app.formatUsageTokens(item.inputTokens)"></span>
              <span x-text="'↓' + $store.app.formatUsageTokens(item.outputTokens)"></span>
              <span x-text="'↻' + $store.app.formatUsageTokens(item.cacheReadTokens)"></span>
              <span x-show="item.cacheWriteTokens > 0" x-text="'✎' + $store.app.formatUsageTokens(item.cacheWriteTokens)"></span>
              <span x-text="$store.app.formatUsageDuration(item.durationMs)"></span>
            </div>
          </div>
          <div class="usage-row-cost">
            <span x-text="item.status === 'error' ? 'error' : (item.unpriced ? '—' : $store.app.formatUsageCost(item.totalCostFormatted))"></span>
          </div>
        </div>
      </template>
      <button
        class="usage-show-more"
        x-show="($store.app.usage?.recent || []).length > 3 || $store.app.usageRecentLimit > 3"
        x-on:click="$store.app.usageRecentLimit = $store.app.usageRecentLimit >= 30 ? 3 : 30"
        x-text="$store.app.usageRecentToggleLabel"
      >
      </button>
    </div>
  )
}
