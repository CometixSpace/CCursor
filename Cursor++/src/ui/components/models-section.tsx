import { ModelCard } from './model-card'

/** Models 子区域 — 在 provider accordion body 内 */
export function ModelsSection() {
  return (
    <div class="models-section" style="position:relative">
      {/* Loading 遮罩 */}
      <template {...{ 'x-if': '$store.app.remoteModels[p.id] && $store.app.remoteModels[p.id].loading' }}>
        <div class="models-loading-overlay">
          <span class="models-loading-spinner">Fetching models...</span>
        </div>
      </template>

      <div class="models-header">
        <span
          class="models-title"
          title="Enabled / total models"
          {...{ 'x-text': '\'Models (\' + $store.app.modelCountLabel(p.id) + \')\'' }}
        >
        </span>
        <span class="models-header-actions">
          <button class="tiny secondary" {...{ 'x-on:click': '$store.app.fetchRemoteModels(p.id)' }}>↓ Fetch</button>
          <button class="tiny secondary" {...{ 'x-on:click': '$store.app.addModel(p.id)' }}>+ Add Model</button>
        </span>
      </div>

      {/* Remote models 结果面板 */}
      <template {...{ 'x-if': '$store.app.remoteModels[p.id] && $store.app.remoteModels[p.id].models && $store.app.remoteModels[p.id].models.length > 0' }}>
        <div class="remote-models-panel">
          <div class="remote-models-header">
            <span
              class="remote-models-title"
              {...{ 'x-text': '\'Available (\' + $store.app.remoteModels[p.id].models.length + \')\'' }}
            >
            </span>
            <button class="tiny ghost" {...{ 'x-on:click': '$store.app.dismissRemoteModels(p.id)' }}>✕</button>
          </div>
          <div class="remote-models-list">
            <template {...{ 'x-for': 'rm in $store.app.remoteModels[p.id].models' }}>
              <div
                class="remote-model-item"
                {...{
                  'x-on:click': '$store.app.applyRemoteModel(p.id, rm.id)',
                  'x-text': 'rm.id',
                }}
              >
              </div>
            </template>
          </div>
        </div>
      </template>

      <template {...{ 'x-if': '!$store.app.getDraft(p.id).models || $store.app.getDraft(p.id).models.length === 0' }}>
        <div class="model-empty">
          No models. Click
          {' '}
          <b>+ Add Model</b>
          {' '}
          or
          {' '}
          <b>↓ Fetch</b>
          {' '}
          to get started.
        </div>
      </template>
      <template {...{ 'x-for': 'm in ($store.app.getDraft(p.id).models || [])', 'x-bind:key': 'm.id' }}>
        <ModelCard />
      </template>
    </div>
  )
}
