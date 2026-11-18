import { ModelsSection } from './models-section'
import { ProviderFields } from './provider-fields'

/** 单个 Provider 折叠面板 — 在 x-for="p in ..." 作用域内使用 */
export function ProviderAccordion() {
  return (
    <div class="acc" {...{ 'x-bind:class': '{ \'dirty\': $store.app.isDirty(p.id) }' }}>
      {/* Head — 始終可見 */}
      <div class="acc-head" {...{ 'x-on:click': '$store.app.toggleExpand(p.id)' }}>
        <span class="acc-caret" {...{ 'x-text': '$store.app.expanded[p.id] ? \'▼\' : \'▶\'' }}></span>
        <span class="acc-title" {...{ 'x-text': '$store.app.getDraftOrOriginal(p.id).name || \'(unnamed)\'' }}></span>
        <span class="acc-type" {...{ 'x-text': '$store.app.getDraftOrOriginal(p.id).type' }}></span>
        <span class="acc-meta" title="Enabled / total models" {...{ 'x-text': '$store.app.modelCountLabel(p.id) + \' models\'' }}></span>
        <span class="acc-dot" title="Unsaved changes" {...{ 'x-show': '$store.app.isDirty(p.id)' }}></span>
        <span class="acc-sort" {...{ 'x-on:click.stop': '' }}>
          <button class="sort-btn" title="Move up" {...{ 'x-on:click': '$store.app.moveProvider(p.id, -1)' }} {...{ 'x-show': 'pIdx > 0' }}>&#9650;</button>
          <button class="sort-btn" title="Move down" {...{ 'x-on:click': '$store.app.moveProvider(p.id, 1)' }} {...{ 'x-show': 'pIdx < $store.app.providers.length - 1' }}>&#9660;</button>
        </span>
      </div>
      {/* Body — 可折叠 */}
      <div class="acc-body" {...{ 'x-show': '$store.app.expanded[p.id]' }} x-cloak>
        <ProviderFields />
        <ModelsSection />
        <div class="actions-bar">
          <button class="danger" {...{ 'x-on:click': '$store.app.deleteProvider(p.id)' }}>Delete</button>
          <button class="ghost" {...{ 'x-on:click': '$store.app.resetProvider(p.id)' }}>Reset</button>
          <button {...{ 'x-on:click': '$store.app.saveProvider(p.id)' }}>Save</button>
        </div>
      </div>
    </div>
  )
}
