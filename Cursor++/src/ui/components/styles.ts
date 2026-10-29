/** Webview CSS — VS Code 主题变量适配 */
export const styles = /* css */ `
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 0 12px 16px; margin: 0; }
  h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--vscode-sideBarSectionHeader-foreground); border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border); padding: 8px 0 4px; margin: 14px 0 6px; display: flex; align-items: center; justify-content: space-between; }
  h3 .h3-actions { display: flex; gap: 4px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 10px; border-radius: 2px; cursor: pointer; font-size: 11px; font-family: inherit; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.danger { background: transparent; color: var(--vscode-errorForeground); padding: 2px 6px; }
  button.danger:hover { background: var(--vscode-inputValidation-errorBackground); }
  button.ghost { background: transparent; color: var(--vscode-foreground); padding: 2px 6px; opacity: 0.7; }
  button.ghost:hover { opacity: 1; background: var(--vscode-list-hoverBackground); }
  button.tiny { padding: 2px 6px; font-size: 10px; }
  input:not([type=checkbox]):not([type=radio]), select, textarea { width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 3px 6px; font-size: 11px; border-radius: 2px; outline: none; font-family: var(--vscode-editor-font-family); resize: vertical; }
  input:not([type=checkbox]):not([type=radio]):focus, select:focus, textarea:focus { border-color: var(--vscode-focusBorder); }
  input[type=radio], input[type=checkbox] { outline: none; }
  /* 禁用态强调 — webview 默认 disabled 几乎无视觉差异。
     删除线表达"值保留但不生效"(如 Max Output Tokens 的 Off 开关) */
  input:not([type=checkbox]):not([type=radio]):disabled, select:disabled, textarea:disabled {
    opacity: 0.45;
    color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground));
    border-style: dashed;
    text-decoration: line-through;
    cursor: not-allowed;
  }

  /* 移除 number input 的原生上下 spinner — 视觉冗余, 用户直接输入数字即可 */
  input[type=number] { -moz-appearance: textfield; }
  input[type=number]::-webkit-outer-spin-button,
  input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }

  /* CustomSelect — 完全 div 实现的下拉选择器 (原生 <select> 的展开 list 由浏览器接管无法样式化)
     trigger 的视觉与 <input> 完全一致, dropdown 自绘, 样式跟随 VS Code 主题 */
  .custom-select { position: relative; width: 100%; }
  .custom-select-trigger {
    display: flex;
    align-items: center;
    width: 100%;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border);
    padding: 3px 6px;
    font-size: 11px;
    border-radius: 2px;
    cursor: pointer;
    font-family: inherit;
    text-align: left;
  }
  .custom-select-trigger:hover { border-color: var(--vscode-focusBorder); }
  .custom-select-trigger:focus { outline: none; border-color: var(--vscode-focusBorder); }
  .custom-select-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .custom-select-caret { opacity: 0.6; font-size: 8px; margin-left: 6px; }
  .custom-select-dropdown {
    position: absolute;
    top: calc(100% + 2px);
    left: 0;
    right: 0;
    z-index: 50;
    background: var(--vscode-quickInput-background, var(--vscode-editorWidget-background));
    border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
    border-radius: 2px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
    max-height: 240px;
    overflow-y: auto;
    padding: 2px 0;
  }
  .custom-select-option {
    padding: 4px 10px;
    font-size: 11px;
    cursor: pointer;
    color: var(--vscode-foreground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .custom-select-option.hover,
  .custom-select-option:hover { background: var(--vscode-list-hoverBackground); }
  .custom-select-option.selected {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
  }
  input.invalid, textarea.invalid { border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground)); }
  input::placeholder { color: var(--vscode-input-placeholderForeground); }
  label { display: block; font-size: 10px; opacity: 0.7; margin: 4px 0 1px; text-transform: uppercase; letter-spacing: 0.3px; }
  .row { display: flex; align-items: center; justify-content: space-between; padding: 3px 0; font-size: 12px; gap: 8px; }
  .byok-banner { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; margin: 10px -12px 0; background: var(--vscode-editorWidget-background); border-bottom: 1px solid var(--vscode-editorWidget-border); }
  .byok-banner .byok-label { display: flex; flex-direction: column; }
  .byok-banner .byok-title { font-weight: 600; font-size: 12px; }
  .byok-banner .byok-hint { font-size: 10px; opacity: 0.65; margin-top: 2px; }
  .byok-banner button.on { background: var(--vscode-statusBarItem-prominentBackground, #3794ff); color: var(--vscode-statusBarItem-prominentForeground, #fff); }
  .byok-banner button.off { background: var(--vscode-statusBarItem-warningBackground, #cc6633); color: var(--vscode-statusBarItem-warningForeground, #fff); }
  .server-row { display: flex; align-items: center; justify-content: space-between; padding: 4px 0; font-size: 12px; }

  .acc { border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border)); border-radius: 3px; margin-bottom: 6px; background: var(--vscode-editor-background); }
  .acc.dirty { border-color: var(--vscode-inputValidation-warningBorder, #cca700); }
  .acc-head { display: flex; align-items: center; gap: 6px; padding: 6px 8px; cursor: pointer; user-select: none; }
  .acc-head:hover { background: var(--vscode-list-hoverBackground); }
  .acc-caret { font-size: 9px; opacity: 0.7; width: 10px; display: inline-block; }
  .acc-title { flex: 1; font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .acc-type { font-size: 9px; text-transform: uppercase; padding: 1px 5px; border-radius: 2px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); letter-spacing: 0.3px; }
  .acc-meta { font-size: 10px; opacity: 0.6; }
  .acc-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--vscode-inputValidation-warningBorder, #cca700); display: inline-block; }
  .acc-sort { margin-left: auto; display: flex; flex-direction: column; gap: 0; }
  .sort-btn { background: transparent; border: none; color: var(--vscode-foreground); cursor: pointer; padding: 0 2px; font-size: 8px; line-height: 1; opacity: 0.4; min-width: auto; }
  .sort-btn:hover { opacity: 1; }
  .acc-body { padding: 8px 10px 10px; border-top: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border)); }
  .field { margin-bottom: 4px; }
  .field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .err { color: var(--vscode-errorForeground); font-size: 10px; margin-top: 2px; }

  .autocomplete { position: relative; }
  .ac-input-wrap { display: flex; align-items: stretch; }
  .ac-input-wrap input { flex: 1; border-top-right-radius: 0; border-bottom-right-radius: 0; border-right: none; min-width: 0; }
  .ac-toggle { display: flex; align-items: center; justify-content: center; width: 28px; padding: 0; border: 1px solid var(--vscode-input-border, var(--vscode-widget-border)); border-left: none; border-radius: 0 2px 2px 0; background: var(--vscode-input-background); color: var(--vscode-foreground); cursor: pointer; opacity: 0.55; font-size: 16px; min-width: auto; line-height: 1; }
  .ac-toggle:hover { opacity: 1; background: var(--vscode-list-hoverBackground); }
  .ac-toggle-caret { display: inline-block; transition: transform 0.15s ease; }
  .ac-toggle-caret.open { transform: rotate(180deg); }
  .ac-loading { display: flex; align-items: center; justify-content: center; padding: 12px 0; }
  @keyframes ac-spin { to { transform: rotate(360deg); } }
  .ac-spinner { width: 16px; height: 16px; border: 2px solid var(--vscode-widget-border, #555); border-top-color: var(--vscode-focusBorder, #007acc); border-radius: 50%; animation: ac-spin 0.6s linear infinite; }
  .autocomplete-list { position: absolute; top: 100%; left: 0; right: 0; z-index: 20; background: var(--vscode-quickInput-background, var(--vscode-editorWidget-background)); border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border)); box-shadow: 0 2px 8px rgba(0,0,0,0.2); max-height: 200px; overflow-y: auto; margin-top: 1px; }
  .autocomplete-item { padding: 4px 8px; cursor: pointer; font-size: 11px; border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border)); }
  .autocomplete-item:last-child { border-bottom: none; }
  .autocomplete-item:hover, .autocomplete-item.selected { background: var(--vscode-list-hoverBackground); }
  .autocomplete-item .ac-name { font-weight: 500; }
  .autocomplete-item .ac-id { font-family: var(--vscode-editor-font-family); font-size: 10px; opacity: 0.65; margin-top: 1px; }
  .autocomplete-item .ac-meta { font-size: 10px; opacity: 0.55; margin-top: 1px; }
  .models-section { margin-top: 10px; padding-top: 8px; border-top: 1px dashed var(--vscode-widget-border, var(--vscode-editorWidget-border)); }
  .models-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
  .models-title { font-size: 10px; text-transform: uppercase; letter-spacing: 0.3px; opacity: 0.7; }
  .model-item { border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border)); border-radius: 2px; margin-bottom: 4px; background: var(--vscode-editorWidget-background); }
  .model-head { display: flex; align-items: center; gap: 6px; padding: 4px 6px; cursor: pointer; user-select: none; font-size: 11px; }
  .model-head:hover { background: var(--vscode-list-hoverBackground); }
  .model-body { padding: 6px 8px 8px; border-top: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border)); }
  .model-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .model-empty { font-size: 10px; opacity: 0.5; font-style: italic; padding: 4px 0; }

  /* 模型标题栏右侧 defaultOn 开关 — iOS 风格 toggle switch
     尺寸 32x18, knob 12x12, track 边框 1px 计入外框。
     几何: 容器 32x18, knob (32-12)/2=10 剩余水平空间, knob 水平居中时 top=(18-12)/2=3
     off 位: left=3      (3 + 12 + border=1 = 16, 离右边 16)
     on  位: left=3+16=19 (翻译 16px, 离右边 1px)
     用显式 track + knob 子元素, 避免 ::before 伪元素渲染差异 */
  .model-switch {
    position: relative;
    display: inline-block;
    width: 32px;
    height: 18px;
    flex: 0 0 32px;
    cursor: pointer;
    vertical-align: middle;
    /* 覆盖全局 label { opacity: 0.7 } — 那是给字段标签 (uppercase 灰字) 用的,
       作为 <label> 的 switch 必须显式还原不透明才能显示本色 */
    opacity: 1;
    /* 也重置 label 的其他全局样式 */
    text-transform: none;
    letter-spacing: normal;
    margin: 0;
  }
  .model-switch input {
    position: absolute;
    inset: 0;
    opacity: 0;
    margin: 0;
    cursor: pointer;
    z-index: 3;
  }
  .model-switch-track {
    position: absolute;
    inset: 0;
    background: var(--vscode-input-background, #3c3c3c);
    border: 1px solid var(--vscode-input-border, #6c6c6c);
    border-radius: 9px;
    transition: background-color 0.15s ease, border-color 0.15s ease;
    z-index: 1;
    pointer-events: none;
    box-sizing: border-box;
  }
  .model-switch-knob {
    position: absolute;
    left: 3px;
    top: 3px;
    width: 12px;
    height: 12px;
    background: #cccccc;
    border-radius: 50%;
    transition: transform 0.2s ease, background-color 0.15s ease;
    z-index: 2;
    pointer-events: none;
    box-sizing: border-box;
  }
  .model-switch input:checked ~ .model-switch-track {
    background: var(--vscode-button-background, #d97757);
    border-color: var(--vscode-button-background, #d97757);
  }
  .model-switch input:checked ~ .model-switch-knob {
    transform: translateX(14px);
    background: #ffffff;
  }
  .model-switch:hover .model-switch-track { border-color: var(--vscode-focusBorder, #007fd4); }

  .actions-bar { display: flex; gap: 6px; justify-content: flex-end; margin-top: 10px; padding-top: 8px; border-top: 1px dashed var(--vscode-widget-border, var(--vscode-editorWidget-border)); }

  .qs-section { margin-top: 8px; border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border)); border-radius: 3px; }
  .qs-header { display: flex; align-items: center; gap: 6px; width: 100%; padding: 6px 8px; background: transparent; border: none; color: var(--vscode-foreground); cursor: pointer; font-size: 11px; font-weight: 600; text-align: left; min-width: auto; }
  .qs-header:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,.04)); }
  .qs-caret { font-size: 10px; opacity: .7; width: 10px; }
  .qs-hint { margin-left: auto; width: 16px; height: 16px; border-radius: 50%; border: 1px solid var(--vscode-widget-border); display: flex; align-items: center; justify-content: center; font-size: 9px; opacity: .5; font-weight: 400; cursor: help; }
  .qs-hint:hover { opacity: 1; }
  .qs-body { padding: 6px 10px 10px; display: flex; flex-direction: column; gap: 6px; }
  .qs-item { border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border)); border-radius: 3px; overflow: hidden; }
  .qs-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 5px 8px; }
  .qs-label { font-size: 11px; font-weight: 500; }
  .qs-item-body { padding: 4px 8px 6px; border-top: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border)); }
  .qs-switch { position: relative; display: inline-flex; align-items: center; cursor: pointer; flex-shrink: 0; opacity: 1; margin: 0; text-transform: none; }
  .qs-switch input { position: absolute; opacity: 0; width: 0; height: 0; }
  .qs-switch-track { width: 28px; height: 14px; border-radius: 7px; background: var(--vscode-widget-border, rgba(255,255,255,.2)); transition: background .15s; }
  .qs-switch input:checked + .qs-switch-track { background: var(--vscode-button-background, #d4875a); }
  .qs-switch-knob { position: absolute; left: 2px; top: 50%; transform: translateY(-50%); width: 10px; height: 10px; border-radius: 50%; background: #fff; transition: left .15s; pointer-events: none; }
  .qs-switch input:checked ~ .qs-switch-knob { left: 16px; }
  .qs-group { display: flex; flex-direction: column; gap: 4px; }
  .qs-chips { display: flex; flex-wrap: wrap; gap: 3px; padding-left: 18px; }
  .qs-chip { display: inline-flex; align-items: center; gap: 2px; font-size: 10px; padding: 1px 6px; border: 1px solid var(--vscode-widget-border); border-radius: 10px; cursor: pointer; user-select: none; }
  .qs-chip input { width: auto; margin: 0; }
  .qs-chip:has(input:checked) { background: var(--vscode-button-secondaryBackground, rgba(255,255,255,.1)); border-color: var(--vscode-focusBorder, #007fd4); }
  .qs-tags { display: flex; flex-wrap: wrap; gap: 3px; align-items: center; padding-left: 18px; }
  .qs-tag { display: inline-flex; align-items: center; gap: 2px; font-size: 10px; padding: 1px 6px; background: var(--vscode-badge-background, rgba(255,255,255,.15)); border-radius: 3px; font-weight: 600; }
  .qs-tag-x { background: none; border: none; color: var(--vscode-errorForeground, #f48771); cursor: pointer; font-size: 12px; padding: 0 2px; min-width: auto; line-height: 1; }
  .qs-tag-input { font-size: 10px; padding: 1px 4px; width: 100px; height: 18px; border: 1px dashed var(--vscode-widget-border); background: transparent; color: var(--vscode-input-foreground); border-radius: 3px; }
  .empty { font-size: 11px; opacity: 0.6; padding: 12px 0; text-align: center; }
  .check { display: flex; align-items: center; gap: 4px; font-size: 10px; margin: 0; white-space: nowrap; }
  .check input { width: auto; }
  .caps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px 8px; margin: 6px 0 4px; padding: 6px 0; border-top: 1px dashed var(--vscode-widget-border, var(--vscode-editorWidget-border)); border-bottom: 1px dashed var(--vscode-widget-border, var(--vscode-editorWidget-border)); }
  .caps .thinking-cell { grid-column: 1 / 2; }
  .caps .thinking-sub-disabled { grid-column: 2 / 4; }
  .caps .thinking-level-cell { grid-column: 2 / 4; }
  .caps .thinking-level-cell .custom-select-trigger { height: 20px; padding: 0 6px; font-size: 10px; }
  .caps .thinking-mode-group { grid-column: 2 / 4; display: flex; align-items: center; gap: 4px; flex-wrap: nowrap; }
  .thinking-mode-tabs { display: flex; flex-shrink: 0; }
  .thinking-mode-tab { font-size: 9px; padding: 1px 6px; border: 1px solid var(--vscode-widget-border); background: transparent; color: var(--vscode-foreground); cursor: pointer; opacity: 0.5; min-width: auto; height: 20px; }
  .thinking-mode-tab:first-child { border-radius: 3px 0 0 3px; }
  .thinking-mode-tab:last-child { border-radius: 0 3px 3px 0; border-left: none; }
  .thinking-mode-tab.active { opacity: 1; background: var(--vscode-button-secondaryBackground, rgba(255,255,255,0.08)); font-weight: 600; }
  .thinking-mode-value { flex: 1; min-width: 0; }
  .thinking-mode-value .custom-select-trigger { height: 20px; padding: 0 6px; font-size: 10px; }
  .input-reveal { position: relative; display: flex; align-items: center; }
  .input-reveal input { padding-right: 28px; }
  .reveal-btn { position: absolute; right: 2px; top: 50%; transform: translateY(-50%); background: transparent; border: none; padding: 2px 4px; cursor: pointer; color: var(--vscode-foreground); opacity: 0.6; min-width: auto; }
  .reveal-btn:hover { opacity: 1; background: transparent; }
  .footer { margin-top: 14px; display: flex; gap: 4px; }
  [x-cloak] { display: none !important; }

  .models-header-actions { display: flex; gap: 4px; align-items: center; }
  .models-loading-overlay { position: absolute; inset: 0; z-index: 10; background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; border-radius: 4px; backdrop-filter: blur(2px); }
  .models-loading-spinner { font-size: 12px; opacity: .9; letter-spacing: .3px; }
  .remote-models-panel { margin: 6px 0; border: 1px solid var(--vscode-panel-border, rgba(255,255,255,.1)); border-radius: 4px; overflow: hidden; }
  .remote-models-header { display: flex; justify-content: space-between; align-items: center; padding: 4px 8px; background: var(--vscode-sideBar-background, rgba(255,255,255,.03)); }
  .remote-models-title { font-size: 11px; opacity: .7; }
  .remote-models-list { max-height: 200px; overflow-y: auto; }
  .remote-model-item { padding: 3px 8px; font-size: 12px; font-family: var(--vscode-editor-font-family, monospace); cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .remote-model-item:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,.06)); }

  .toast-container { position: fixed; bottom: 12px; left: 12px; right: 12px; z-index: 999; display: flex; flex-direction: column; gap: 6px; pointer-events: none; }
  .toast { pointer-events: auto; padding: 8px 12px; border-radius: 4px; font-size: 12px; line-height: 1.4; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.3); }
  .toast-error { background: var(--vscode-inputValidation-errorBackground, #5a1d1d); border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100); color: var(--vscode-errorForeground, #f48771); }
  .toast-warn { background: var(--vscode-inputValidation-warningBackground, #352a05); border: 1px solid var(--vscode-inputValidation-warningBorder, #9d8600); color: var(--vscode-foreground); }

  .modal-backdrop { position: fixed; inset: 0; z-index: 100; background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; backdrop-filter: blur(2px); }
  .modal-dialog { background: var(--vscode-editor-background, #1e1e1e); border: 1px solid var(--vscode-widget-border); border-radius: 6px; width: 90%; max-width: 420px; max-height: 85vh; overflow: visible; box-shadow: 0 8px 32px rgba(0,0,0,.5); }
  .modal-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid var(--vscode-widget-border); }
  .modal-title { font-size: 13px; font-weight: 600; }
  .modal-close { background: transparent; border: none; color: var(--vscode-foreground); font-size: 18px; cursor: pointer; opacity: 0.6; min-width: auto; padding: 0 4px; }
  .modal-close:hover { opacity: 1; }
  .modal-body { padding: 6px 14px 12px; }

  .search-btn { font-size: 11px; padding: 4px 10px; }
  .wt-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--vscode-widget-border); margin-bottom: 6px; }
  .wt-tab { flex: 1; background: transparent; border: none; border-bottom: 2px solid transparent; color: var(--vscode-foreground); padding: 6px 0; font-size: 12px; cursor: pointer; opacity: 0.6; min-width: auto; }
  .wt-tab.active { opacity: 1; border-bottom-color: var(--vscode-button-background, #d4875a); font-weight: 600; }
  .wt-tab:hover { opacity: 0.9; }
  .search-providers { display: flex; flex-direction: column; gap: 0; }
  .search-provider-card { border-bottom: 1px solid var(--vscode-widget-border, rgba(255,255,255,.1)); padding: 8px 0; }
  .search-provider-card:last-of-type { border-bottom: none; }
  .search-provider-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .search-provider-info { display: flex; flex-direction: column; gap: 1px; }
  .search-provider-name { font-size: 12px; font-weight: 500; }
  .search-provider-hint { font-size: 9px; opacity: 0.5; }
  .search-provider-key { margin-top: 6px; }
  .search-provider-key input { width: 100%; font-size: 11px; padding: 3px 6px; }
  .search-options { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--vscode-widget-border); display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .search-max-results { display: flex; align-items: center; gap: 4px; font-size: 11px; }
  .search-max-results select { font-size: 11px; padding: 2px 4px; }
  .search-dialog-actions { display: flex; gap: 6px; justify-content: flex-end; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--vscode-widget-border); }
  .fetch-providers { display: flex; flex-direction: column; gap: 0; }
  .fetch-provider-card { border-bottom: 1px solid var(--vscode-widget-border, rgba(255,255,255,.1)); padding: 6px 0; }
  .fetch-provider-card:last-of-type { border-bottom: none; }
  .fetch-provider-row { display: flex !important; width: 100%; align-items: center; gap: 6px; cursor: pointer; margin: 0 !important; text-transform: none !important; opacity: 1 !important; letter-spacing: normal !important; font-size: 12px !important; justify-content: flex-start; }
  .fetch-provider-row .search-provider-name { white-space: nowrap; }
  .fetch-provider-hint { font-size: 9px; opacity: 0.5; padding-left: 20px; margin-top: 1px; }
  .fetch-provider-row input[type=radio] { flex-shrink: 0; margin: 0; width: auto; background: none; border: none; padding: 0; }
  .toast-info { background: var(--vscode-inputValidation-infoBackground, #063b49); border: 1px solid var(--vscode-inputValidation-infoBorder, #007acc); color: var(--vscode-foreground); }
  .toast-enter { animation: toast-in .2s ease-out; }
  .toast-leave { animation: toast-out .15s ease-in; }
  @keyframes toast-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes toast-out { from { opacity: 1; } to { opacity: 0; transform: translateY(8px); } }

  .usage-panel { display: flex; flex-direction: column; gap: 8px; padding: 4px 0 8px; }
  .usage-hero { padding: 8px 0 2px; }
  .usage-today { font-size: 22px; font-weight: 650; letter-spacing: -0.3px; }
  .usage-today-label { font-size: 10px; opacity: 0.6; margin-top: 2px; }
  .usage-toolbar { display: flex; gap: 6px; align-items: center; }
  .usage-toolbar select { width: auto; flex: 1; }
  .usage-metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
  .usage-metric { background: var(--vscode-editor-background); border: 1px solid var(--vscode-widget-border); border-radius: 4px; padding: 6px 8px; }
  .usage-metric-label { display: block; font-size: 10px; opacity: 0.6; }
  .usage-metric-value { font-size: 12px; font-weight: 600; }
  .usage-trend { display: flex; flex-direction: column; gap: 2px; }
  .usage-trend-bars { display: flex; align-items: flex-end; justify-content: center; gap: 2px; height: 36px; border-bottom: 1px solid var(--vscode-widget-border); }
  .usage-trend-bar { flex: 1; max-width: 28px; min-width: 0; height: 100%; display: flex; align-items: flex-end; }
  .usage-trend-fill { width: 100%; background: var(--vscode-charts-green, #4ec9b0); border-radius: 1px 1px 0 0; }
  .usage-trend-axis { display: flex; justify-content: space-between; font-size: 9px; opacity: 0.5; font-variant-numeric: tabular-nums; }
  .usage-unpriced { font-size: 10px; color: var(--vscode-errorForeground); }
  .usage-section-title { font-size: 10px; text-transform: uppercase; letter-spacing: 0.4px; opacity: 0.7; margin-top: 4px; }
  .usage-hint { font-size: 10px; opacity: 0.55; }
  .usage-check { display: flex; align-items: center; gap: 6px; font-size: 11px; margin: 0; }
  .usage-check input { width: auto; }
  .usage-check-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .usage-check-sub { opacity: 0.55; }
  .usage-check-cost { font-variant-numeric: tabular-nums; opacity: 0.8; }
  .usage-provider { display: flex; flex-direction: column; }
  .usage-provider-row { display: flex; align-items: center; gap: 4px; font-size: 11px; padding: 2px 0; }
  .usage-provider-toggle { width: 12px; flex-shrink: 0; cursor: pointer; opacity: 0.6; font-size: 9px; text-align: center; user-select: none; }
  .usage-models { margin: 1px 0 3px 20px; padding-left: 6px; border-left: 1px solid var(--vscode-widget-border); display: flex; flex-direction: column; gap: 1px; }
  .usage-check-nested { font-size: 10.5px; }
  .usage-row-time { opacity: 0.5; font-variant-numeric: tabular-nums; margin-right: 5px; }
  .usage-show-more { background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; font-size: 10px; padding: 2px 0; text-align: left; }
  .usage-empty { font-size: 11px; opacity: 0.55; padding: 4px 0; }
  .usage-row { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; padding: 3px 0; border-bottom: 1px solid var(--vscode-widget-border); cursor: pointer; }
  .usage-row:hover { background: var(--vscode-list-hoverBackground); }
  .usage-row-main { flex: 1; min-width: 0; overflow: hidden; }
  .usage-row-line { display: flex; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .usage-row-detail { display: flex; gap: 8px; font-size: 10px; opacity: 0.65; margin-top: 2px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .usage-row-cost { font-variant-numeric: tabular-nums; white-space: nowrap; }
`
