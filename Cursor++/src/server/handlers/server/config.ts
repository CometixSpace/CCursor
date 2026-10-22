/**
 * GetServerConfig 响应构造
 *
 * 配置内容参照官方服务器实际返回值 (analysis/GetServerConfig.json)。
 * 所有字段按官方响应原样复刻，关键配置项影响客户端行为:
 *   - chatConfig: Agent 对话行为 (token 限制、规则长度、MCP 工具数等)
 *   - clientVersionStatus: 客户端版本检查 (updateLevel=NONE 阻止更新提示)
 *   - useNlbForNal: 网络负载均衡 (NAL = cursor-always-local)
 *   - agentUrlConfig: Agent 服务 URL (BYOK 指向本地)
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
        // BYOK 的路由是 HTTP/1.1 白名单拦截 (http/https.request monkey patch)。
        // 3.26 的 Agent Host 在 http2Config=UNSPECIFIED 时会为部分 RPC 建 HTTP/2
        // transport (baseUrl api2/agentn)，完全绕过拦截，RunSSE 直达官方并被判
        // "Unknown model ID"。这里显式要求全量 HTTP/1.1，让所有 Cursor API 请求
        // 都经过本地路由。
        http2Config: Http2Config.FORCE_ALL_DISABLED,

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
