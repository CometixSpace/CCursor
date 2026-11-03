import { CustomSelect } from './custom-select'
import { Modal } from './modal'

const SEARCH_PROVIDERS = [
  { type: 'duckduckgo', name: 'DuckDuckGo', needsKey: false, hint: 'Free, no API key needed' },
  { type: 'exa', name: 'Exa', needsKey: true, hint: 'Semantic search — 1,000 free/month' },
  { type: 'tavily', name: 'Tavily', needsKey: true, hint: 'LLM-optimized — 1,000 free/month' },
  { type: 'brave', name: 'Brave Search', needsKey: true, hint: 'Independent index — ~1,000 free/month' },
  { type: 'jina', name: 'Jina', needsKey: true, hint: 'Full content extraction — 10M free tokens' },
  { type: 'firecrawl', name: 'Firecrawl', needsKey: true, hint: 'Scrape + search — self-hostable' },
  { type: 'keenable', name: 'Keenable', needsKey: false, hint: 'AI-agent search — free, no API key needed' },
] as const

const FETCH_PROVIDERS = [
  { type: 'builtin', name: 'Built-in (supermarkdown)', hint: 'Local HTML→Markdown, zero config' },
  { type: 'jina', name: 'Jina Reader', hint: 'r.jina.ai — handles JS-rendered pages' },
  { type: 'firecrawl', name: 'Firecrawl', hint: 'Scrape API — self-hostable' },
] as const

export function WebToolsButton() {
  return (
    <button
      class="search-btn"
      x-on:click="$store.app.webToolsOpen = true"
      title="Configure search and fetch providers"
    >
      Web Tools
    </button>
  )
}

export function WebToolsDialog() {
  return (
    <Modal showExpr="$store.app.webToolsOpen" title="Web Tools">
      <div class="wt-tabs">
        <button
          class="wt-tab"
          x-bind:class="{ active: $store.app.webToolsTab === 'search' }"
          x-on:click="$store.app.webToolsTab = 'search'"
        >
          Search
        </button>
        <button
          class="wt-tab"
          x-bind:class="{ active: $store.app.webToolsTab === 'fetch' }"
          x-on:click="$store.app.webToolsTab = 'fetch'"
        >
          Fetch
        </button>
      </div>

      {/* ── Search Tab ── */}
      <div x-show="$store.app.webToolsTab === 'search'">
        <div class="search-providers">
          {SEARCH_PROVIDERS.map(sp => (
            <div class="search-provider-card" key={sp.type}>
              <div class="search-provider-row">
                <div class="search-provider-info">
                  <span class="search-provider-name">{sp.name}</span>
                  <span class="search-provider-hint">{sp.hint}</span>
                </div>
                <label class="qs-switch">
                  <input
                    type="checkbox"
                    x-bind:checked={`$store.app.isSearchProviderEnabled('${sp.type}')`}
                    x-on:change={`$store.app.toggleSearchProvider('${sp.type}', $event.target.checked)`}
                  />
                  <span class="qs-switch-track"></span>
                  <span class="qs-switch-knob"></span>
                </label>
              </div>
              {sp.needsKey && (
                <div class="search-provider-key" x-show={`$store.app.isSearchProviderEnabled('${sp.type}')`}>
                  <input
                    type="password"
                    placeholder="API Key"
                    x-bind:value={`$store.app.getSearchProviderKey('${sp.type}')`}
                    x-on:input={`$store.app.setSearchProviderKey('${sp.type}', $event.target.value)`}
                    autocomplete="off"
                  />
                </div>
              )}
            </div>
          ))}
          <div class="search-options">
            <label class="check" title="Search all enabled providers in parallel and merge results">
              <input
                type="checkbox"
                x-bind:checked="$store.app.webTools?.search?.parallel === true"
                x-on:change="$store.app.setSearchOption('parallel', $event.target.checked)"
              />
              {' Parallel Search'}
            </label>
            <div class="search-max-results">
              <label>Max Results</label>
              <CustomSelect
                valueExpr="String($store.app.webTools?.search?.maxResults || 5)"
                changeExpr="$store.app.setSearchOption('maxResults', Number($value))"
                options={[
                  { value: '5', label: '5' },
                  { value: '10', label: '10' },
                  { value: '15', label: '15' },
                  { value: '20', label: '20' },
                  { value: '25', label: '25' },
                ]}
              />
            </div>
          </div>
        </div>
      </div>

      {/* ── Fetch Tab ── */}
      <div x-show="$store.app.webToolsTab === 'fetch'">
        <div class="fetch-providers">
          {FETCH_PROVIDERS.map(fp => (
            <div class="fetch-provider-card" key={fp.type}>
              <label class="fetch-provider-row">
                <input
                  type="radio"
                  name="fetch-provider"
                  value={fp.type}
                  x-bind:checked={`$store.app.webTools?.fetch?.provider === '${fp.type}'`}
                  x-on:change={`$store.app.setFetchProvider('${fp.type}')`}
                />
                <span class="search-provider-name">{fp.name}</span>
              </label>
              <div class="fetch-provider-hint">{fp.hint}</div>
              {fp.type === 'jina' && (
                <div class="search-provider-key" x-show="$store.app.webTools?.fetch?.provider === 'jina'">
                  <input
                    type="password"
                    placeholder="API Key (optional)"
                    x-bind:value="$store.app.webTools?.fetch?.jina?.apiKey || ''"
                    x-on:input="$store.app.setFetchKey('jina', 'apiKey', $event.target.value)"
                    autocomplete="off"
                  />
                </div>
              )}
              {fp.type === 'firecrawl' && (
                <div class="search-provider-key" x-show="$store.app.webTools?.fetch?.provider === 'firecrawl'">
                  <input
                    type="password"
                    placeholder="API Key"
                    x-bind:value="$store.app.webTools?.fetch?.firecrawl?.apiKey || ''"
                    x-on:input="$store.app.setFetchKey('firecrawl', 'apiKey', $event.target.value)"
                    autocomplete="off"
                  />
                  <input
                    type="text"
                    placeholder="Base URL (optional, default: api.firecrawl.dev)"
                    x-bind:value="$store.app.webTools?.fetch?.firecrawl?.baseUrl || ''"
                    x-on:input="$store.app.setFetchKey('firecrawl', 'baseUrl', $event.target.value)"
                    style="margin-top:4px"
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div class="search-dialog-actions">
        <button x-on:click="$store.app.saveWebTools()">Save</button>
        <button class="ghost" x-on:click="$store.app.webToolsOpen = false">Cancel</button>
      </div>
    </Modal>
  )
}
