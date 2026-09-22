/**
 * GetServerConfig 响应构造
 *
 * 配置内容参照官方服务器实际返回值 (analysis/GetServerConfig.json)。
 * 所有字段按官方响应原样复刻，关键配置项影响客户端行为:
 *   - chatConfig: Agent 对话行为 (token 限制、规则长度、MCP 工具数等)
 *   - clientVersionStatus: 客户端版本检查 (updateLevel=NONE 阻止更新提示)
 *   - useNlbForNal: 网络负载均衡 (NAL = cursor-always-local)
 *   - agentUrlConfig: Agent 服务 URL (BYOK 指向本地)
 *   - http2Config: 必须显式回 FORCE_BIDI_DISABLED, 否则客户端会走 BiDi Run 打本地
 *     HTTP/1.1 server (HTTP 505)。实测于 Cursor 3.20.21; 行为切换的精确版本
 *     尚未定论, 区间依据见下方字段处注释
 *   - claudeCodeHooksEnabled: Claude Code hooks 开关
 *   - metricsConfig: 指标采集开关 (隐私模式+非隐私模式)
 *   - backgroundComposerConfig: 后台 Agent 配置
 *   - runTerminalServerConfig: shell 命令解析白名单
 *   - indexingConfig: 代码索引配置
 *   - agentLayoutPolicy: Agent 布局允许/禁止的 action IDs
 *   - currentInAppAd: 应用内广告 (InAppAdService 用)
 *   - onboardingConfig: 新用户引导配置
 */

import { config } from '../../runtime-config';
import { Http2Config } from '../../gen/aiserver_v1_pb';

export function buildServerConfig() {
    const byokUrl = `http://${config.server.host}:${config.server.port}`;

    return {
        bugConfigResponse: {
            bugBotV1: { backgroundCallFrequencyMs: 3600000 },
        },

        indexingConfig: {
            maxConcurrentUploads: 64,
            absoluteMaxNumberFiles: 100000,
            maxFileRetries: 30,
            syncConcurrency: 20,
            autoIndexingMaxNumFiles: 50000,
            indexingPeriodSeconds: 298,
            incremental: true,
            multiRootIndexingEnabled: true,
            copyStatusCheckPeriodSeconds: 1,
            copyTimeoutSeconds: 3600,
            maxBatchBytes: 2097152,
            maxBatchNumRequests: 20,
            maxSyncMerkleBatchSize: 50,
        },

        clientTracingConfig: {
            globalSampleRate: 1,
            tracesSampleRate: 0.0001,
            loggerSampleRate: 0.1,
            minidumpSampleRate: 1,
            errorRateLimit: 10,
            performanceUnitRateLimit: 100,
            profilesSampleRate: 0.001,
            jsonStringifySampleRate: 0.00001,
        },

        chatConfig: {
            fullContextTokenLimit: 30000,
            maxRuleLength: 100000,
            maxMcpTools: 100,
            warnMcpTools: 80,
            summarizationMessage: 'Chat context summarized.',
            numFilesForMemoryGeneration: 999999,
            numSummarizationsBeforeWarningShown: 10,
            cursorRulesReadFileFixEnabled: true,
            dontSendCtrlCBeforeCommand: true,
            clientStatsigPollIntervalMs: 300000,
            listDirV2PredefinedIgnoreGlobs: ['**/node_modules/*', '**/__pycache__/*', '**/.*'],
        },

        configVersion: 'da2221eb-11d4-4bfa-b704-f76111f1e801',

        /**
         * http2_config = 7 —— 必须显式回 FORCE_BIDI_DISABLED(3), 不能省略。
         *
         * ── 行为变动的版本边界 ──
         * 实测(事实): 故障在 Cursor 3.20.21 (commit f09fca3, 2026-09-13 构建) 上复现。
         *
         * 下界(推断, 依据两条): 扩展源码中标注过的最高 Cursor 版本为 3.17.19;
         * 且 `agent.v1.AgentService/RunSSE` 自 v0.0.6 起就在 BYOK 重定向白名单里,
         * 而 `Run` 从未进入白名单 —— 说明此前客户端实际走的是 RunSSE, 否则本扩展
         * 不可能工作。承载该选择逻辑的 AiConnectTransportHandler 位于 Agent Host,
         * 仓库中标注为 3.13+ 组件。
         *
         * 结论: 行为切换发生在 (3.17.19, 3.20.21] 区间内。精确到某一版本需要用旧版
         * 构建二分, 本地无旧构建, 故未定论。此赋值对不消费该字段的旧版本无副作用,
         * 只在消费它的版本上把客户端引回 RunSSE。
         *
         * 背景: BYOK 的 agentUrlConfig 把 Agent 服务指向本地, 而本地 server 是
         * Fastify over HTTP/1.1, **无法承载 BiDi streaming** (agent.v1.AgentService/Run)。
         * 实测对 HTTP/1.1 的 bidi 请求, 服务端直接回 `HTTP 505 HTTP Version Not Supported`,
         * 响应体为空 —— 客户端 Connect 层解不出任何信封, 只能抛
         * `Code.Internal` + "Protocol error", 即 UI 上的
         * `RetriableError: [internal] Protocol error`。
         *
         * 该错误发生在 RPC 方法选择阶段, 早于任何 LLM 调用, 因此**与 provider / 模型
         * 完全无关** —— 换任何模型都报同一个错, 且服务端日志里连
         * `[SVC] AgentService/Run bidi started` 都不会出现。
         *
         * 置为 FORCE_BIDI_DISABLED 后客户端改走 server streaming 的 RunSSE
         * (HTTP/1.1 可用), 配合 unary 的 aiserver.v1.BidiService/BidiAppend 投递
         * runRequest, 这正是本扩展设计的传输路径。
         *
         * 不要改用 FORCE_ALL_DISABLED(1): 那会连非 bidi 的 HTTP/2 能力一起关掉,
         * 而本地只需要关 bidi。
         */
        http2Config: Http2Config.FORCE_BIDI_DISABLED,

        profilingConfig: {},

        metricsConfig: {
            enabledInPrivacyMode: true,
            enabledInNonPrivacyMode: true,
        },

        backgroundComposerConfig: {
            showBackgroundAgentInBetaSettings: true,
            windowInWindowPreloadCount: 4,
            windowInWindowPingIntervalMs: 10000,
            showBackgroundAgentDisclaimer: true,
            showBackgroundAgentSlackAd: false,
            showBackgroundAgentHistoryAction: true,
            maxWindowInWindows: 4,
        },

        memoryMonitorConfig: {
            baseThresholdMb: 1536,
            criticalOffsetMb: 512,
            processMemoryIntervalSec: 0,
        },

        folderSizeLimit: {
            maxTotalBytes: 5000000,
            maxNumFiles: 250,
        },

        gitIndexingConfig: {
            enabled: false,
        },

        traceConfig: {
            bufferSize: 5000,
            flushIntervalMs: 60000,
            sampleRate: 0.1,
        },

        runTerminalServerConfig: {
            compositeShellCommands: [
                'ansible', 'apt', 'az', 'aws', 'aws-vault', 'brew', 'buildah', 'cargo',
                'cf', 'chef', 'circleci', 'composer', 'conda', 'consul', 'docker',
                'docker-compose', 'doctl', 'eksctl', 'firebase', 'flyctl', 'gem', 'gh',
                'git', 'gcloud', 'glab', 'helm', 'heroku', 'ibmcloud', 'ip', 'kops',
                'kubectl', 'kustomize', 'linode-cli', 'mercurial', 'nerdctl', 'nomad',
                'npm', 'oci', 'op', 'pacman', 'packer', 'pip', 'pipenv', 'pipx', 'pnpm',
                'podman', 'pulumi', 'systemctl', 'terraform', 'uv', 'vault', 'yarn',
            ],
        },

        onlineMetricsConfig: {
            enabled: true,
            maxRequestsTracked: 1000,
            maxRequestsTrackedMb: 100,
            maxRequestRetentionSeconds: 604800,
            numCommitsTracked: 3,
            timeIntervalsTrackedMinutes: [5, 15, 60],
            tooBigFileSizeBytes: 1000000,
        },

        interactionConfig: {
            profilingIntervalSec: 30,
            metricsIntervalSec: 120,
            profilingMaxBufferSize: 10000,
            profilingInteractionDurationThresholdMs: 100,
            profilingSampleIntervalMs: 5,
            metricsMinInteractionsForLoaf: 10,
            metricsMinForegroundTimeMs: 7000,
            metricsCombinedInpDropHighestCount: 35,
            metricsClickInpDropHighestCount: 15,
            metricsKeypressInpDropHighestCount: 30,
            metricsStartupThresholdSec: 15,
        },

        agentTelemetryConfig: {
            enabled: true,
        },

        clientVersionStatus: {
            updateLevel: 0, // CLIENT_UPDATE_LEVEL_NONE
            currentClientVersion: '2.6.19',
            minSupportedClientVersion: '2.4.0',
            minAllowedClientVersion: '2.3.0',
        },

        agentLayoutPolicy: {
            allowedActionIds: [
                'workbench.action.agentLayout', 'workbench.action.editorLayout',
                'workbench.action.toggleFullScreen', 'workbench.action.reloadWindow',
                'workbench.action.closeWindow', 'workbench.action.quit',
                'workbench.action.toggleDevTools', 'workbench.action.toggleSidebarVisibility',
                'workbench.action.togglePanel', 'workbench.action.toggleAuxiliaryBar',
                'workbench.action.zoomIn', 'workbench.action.zoomOut',
                'workbench.action.terminal.toggleTerminal',
                'typescript.restartTsServer', 'typescript.reloadProjects',
                'javascript.reloadProjects', 'cursorpyright.restartserver',
                'workbench.action.openWebviewDeveloperTools',
                'workbench.action.restartExtensionHost',
                'workbench.extensions.action.installExtensions',
                'workbench.extensions.action.reloadExtension',
                'workbench.action.files.openFile', 'workbench.action.files.openFolder',
                'workbench.action.files.openFolderViaWorkspace',
                'workbench.action.files.openFileFolder',
                'workbench.action.quickOpen',
                'workbench.action.files.save', 'workbench.action.files.saveAs',
                'workbench.action.files.saveAll', 'workbench.action.files.revert',
                'workbench.action.files.copyPathOfActiveFile',
                'revealFileInOS', 'copyFilePath', 'copyRelativeFilePath',
                'workbench.action.showCommands', 'workbench.action.clearCommandHistory',
                'workbench.action.openRecent', 'workbench.action.quickOpenView',
                'workbench.action.gotoLine', 'workbench.action.gotoSymbol',
                'workbench.action.showAllSymbols',
                'workbench.action.navigateBack', 'workbench.action.navigateForward',
                'workbench.action.navigateToLastEditLocation',
                'workbench.action.reopenClosedEditor',
                'workbench.action.nextEditor', 'workbench.action.previousEditor',
                'search.action.openResult', 'search.action.openResultToSide',
                'search.action.openInEditor', 'search.action.replaceAllInFile',
                'workbench.action.dismissNotification',
                'notifications.showList', 'notifications.hideList', 'notifications.toggleList',
                'notification.clear', 'notifications.clearAll',
                'composer.startComposerPrompt2', 'composer.startComposerPrompt',
                'composer.openComposer', 'composer.cancelChat',
                'composer.reapplyCodeblock', 'composer.resumeCurrentChat',
                'composer.updateTitle', 'composer.updateStatus',
                'workbench.action.backgroundComposer.refresh',
                'aiSettings.action.openhidden', 'workbench.action.openMCPSettings',
                'workbench.action.openAgentsView', 'workbench.action.openChat',
                'workbench.action.openSettings', 'workbench.action.openGlobalKeybindings',
                'workbench.action.showAboutDialog',
                'cursor.doupdate', 'cursor.checkonupdate',
                'update.checkForUpdate', 'update.downloadUpdate',
                'editor.action.acceptCppSuggestion', 'editor.cpp.toggle',
                'editor.action.revealDefinition', 'editor.action.peekDefinition',
                'editor.action.goToTypeDefinition', 'editor.action.goToImplementation',
                'editor.action.goToReferences', 'editor.action.findReferences',
                'editor.action.openLink',
                'workbench.action.closeActiveEditor',
                'editor.action.codeAction', 'editor.action.quickFix',
                'editor.action.refactor', 'editor.action.organizeImports',
                'actions.find', 'actions.findWithSelection',
                'type', 'paste', 'cut', 'undo', 'redo',
                'cursorLeft', 'cursorRight', 'cursorUp', 'cursorDown',
                'cursorHome', 'cursorEnd', 'cursorPageUp', 'cursorPageDown',
                'selectAll', 'deleteLeft', 'deleteRight', 'tab', 'outdent',
                'workbench.action.terminal.attachToSession',
                'workbench.action.terminal.detachSession',
                'workbench.action.mcp.clearAllTokens',
                'aiServerConfigService.getCachedServerConfig',
                'aiSettings.action.open', 'mcp.deeplinkInstall',
            ],
            deniedActionIds: [
                'workbench.action.splitEditor', 'workbench.action.splitEditorOrthogonal',
                'workbench.action.splitEditorLeft', 'workbench.action.splitEditorRight',
                'workbench.action.splitEditorUp', 'workbench.action.splitEditorDown',
                'workbench.action.splitEditorToPreviousGroup',
                'workbench.action.splitEditorToNextGroup',
                'workbench.action.duplicateActiveEditorGroupLeft',
                'workbench.action.duplicateActiveEditorGroupRight',
                'workbench.action.duplicateActiveEditorGroupUp',
                'workbench.action.duplicateActiveEditorGroupDown',
                'workbench.action.focusFirstEditorGroup',
                'workbench.action.focusSecondEditorGroup',
                'workbench.action.focusThirdEditorGroup',
                'workbench.action.moveEditorToPreviousGroup',
                'workbench.action.moveEditorToNextGroup',
                'workbench.action.joinAllGroups', 'workbench.action.joinTwoGroups',
                'workbench.action.newEditorGroupLeft', 'workbench.action.newEditorGroupRight',
                'workbench.action.newEditorGroupAbove', 'workbench.action.newEditorGroupBelow',
                'workbench.action.moveEditorGroupIntoNewWindow',
                'workbench.action.copyEditorGroupIntoNewWindow',
                'workbench.action.moveEditorIntoNewWindow',
                'workbench.action.copyEditorIntoNewWindow',
                'workbench.action.newEmptyEditorWindow',
            ],
        },

        useNlbForNal: true,

        agentUrlConfig: {
            agentUrl: byokUrl,
            agentnUrl: byokUrl,
        },

        cliSandboxDefaultEnabled: false,
        claudeCodeHooksEnabled: true,

        onboardingConfig: {
            marketplacePluginNames: ['datadog', 'figma', 'notion-workspace'],
        },
    };
}
