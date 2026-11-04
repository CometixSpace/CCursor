/** Per-round multimodal fallback for text-only main models. */
export function VisionRouting() {
  return (
    <div class="vision-routing" x-show="$store.app.state">
      <div class="vision-routing-copy">
        <div class="vision-routing-title">Image-capable model</div>
        <div class="vision-routing-hint">
          Used only for rounds containing new images. Text-only rounds automatically return to the main model.
        </div>
      </div>

      <div
        class="custom-select"
        x-data="{ open: false }"
        {...{ 'x-on:click.outside': 'open = false' }}
      >
        <button
          type="button"
          class="custom-select-trigger"
          x-bind:disabled="$store.app.visionModelSaving"
          x-on:click="open = !open"
          {...{ 'x-on:keydown.escape.prevent': 'open = false' }}
        >
          <span class="custom-select-label" x-text="$store.app.visionModelLabel"></span>
          <span class="custom-select-caret" x-text="open ? '^' : 'v'"></span>
        </button>
        <div class="custom-select-dropdown" x-show="open" x-cloak>
          <div
            class="custom-select-option"
            x-bind:class="{ 'selected': !$store.app.state?.visionModelId }"
            x-on:click="$store.app.saveVisionModel(''); open = false"
          >
            Not configured
          </div>
          <template x-for="model in $store.app.visionCapableModels" x-bind:key="model.id">
            <div
              class="custom-select-option"
              x-text="model.label"
              x-bind:title="model.id"
              x-bind:class="{ 'selected': $store.app.state?.visionModelId === model.id }"
              x-on:click="$store.app.saveVisionModel(model.id); open = false"
            >
            </div>
          </template>
        </div>
      </div>

      <div class="vision-routing-warning" x-show="$store.app.visionCapableModels.length === 0" x-cloak>
        No saved model supports both Images and Agent mode.
      </div>
      <div class="vision-routing-warning" x-show="$store.app.visionModelInvalid" x-cloak>
        The configured model is missing or no longer supports Images and Agent mode. Choose another model.
      </div>
    </div>
  )
}
