/**
 * Cursor++ 共享默认值
 *
 * 这些常量是 installer 与 extension server 共同的兜底数据：
 *   - install 时若 ~/.ccursor/{routes,providers}.json 不存在，installer 用这里的值释放
 *   - patcher 注入到 Cursor 进程的代码读 routes.json 失败时也用这里的兜底
 *   - extension server 启动时若 routes.json 缺字段，按这里的默认补齐
 *
 * Cursor++/src/server/data/defaults.ts 必须与本文件保持一致。
 */

export const CCURSOR_DIR_NAME = '.ccursor';
export const ROUTES_FILE_NAME = 'routes.json';
export const PROVIDERS_FILE_NAME = 'providers.json';
export const DB_FILE_NAME = 'cursor.db';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 39831;
export const DEFAULT_COLLECTOR_PORT = 14800;

/**
 * BASE_REDIRECT —— 不论 BYOK 开关如何,**永远**生效的劫持白名单。
 *
 * 当前只包含"假装订阅"的 2 个 Stripe profile stub。
 * 这些是无 Cursor 付费账号的用户切到 OFF 模式后,仍然需要 stub 的最小集
 * (让 Cursor 渲染器认为账户是 ultra,不进入付费引导)。
 */
export const BASE_REDIRECT = [
  'REST:/auth/full_stripe_profile',
  'REST:/auth/stripe_profile',
];

/**
 * BYOK_REDIRECT —— 仅在 byokMode === 'on' 时追加进生效白名单。
 *
 * 关闭 BYOK 时这些项**必须**移除,让对应请求直通官方:
 *   - 模型列表 / Agent 流 / Bidi 队列: 关 BYOK 后客户端走真 Cursor
 *   - ChatService 摘要: BYOK Agent 流的本地 sqlite 持久化
 *   - 一组整服务 stub: 支撑 BYOK 流程下的账号 / dashboard / serverConfig 假数据
 *     (整服务挂入是为了后续逐方法实装,当前未实装的方法返回 unimplemented)
 *
 * 注意 BidiAppend 位于 aiserver.v1 包下, 不是 agent.v1 —— 切记别又写错。
 */
export const BYOK_REDIRECT = [
  // ── BYOK 核心 ──
  'aiserver.v1.AiService/AvailableModels',
  'agent.v1.AgentService/RunSSE',
  'agent.v1.AgentService/UploadConversationBlobs',
  'aiserver.v1.BidiService/BidiAppend',

  // ── 本地摘要持久化(BYOK Agent 配套) ──
  'aiserver.v1.ChatService/GetConversationSummary',
  'aiserver.v1.ChatService/StreamSpeculativeSummaries',

  // ── Rules / Knowledge Base (本地持久化) ──
  'aiserver.v1.AiService/KnowledgeBaseList',
  'aiserver.v1.AiService/KnowledgeBaseAdd',
  'aiserver.v1.AiService/KnowledgeBaseUpdate',
  'aiserver.v1.AiService/KnowledgeBaseRemove',
  // AiService: 模型/配置端点 — BYOK 拦截返回本地配置,不打官方
  'aiserver.v1.AiService/ServerTime',
  'aiserver.v1.AiService/GetDefaultModel',
  'aiserver.v1.AiService/GetDefaultModelNudgeData',

  // ── BYOK 流程下需要 stub 的服务 ──
  'aiserver.v1.AuthService',
  // AnalyticsService: 遥测上报返空; BootstrapStatsig 不拦截(直通官方拿真实 feature gate 配置)
  'aiserver.v1.AnalyticsService/Batch',
  // DashboardService: 逐方法挂入 — 未列出的方法 (如 ListMarketplacePlugins) 直接透传官方 API
  'aiserver.v1.DashboardService/GetPlanInfo',
  'aiserver.v1.DashboardService/GetCurrentPeriodUsage',
  'aiserver.v1.DashboardService/GetTeams',
  'aiserver.v1.DashboardService/GetUserPrivacyMode',
  'aiserver.v1.DashboardService/GetUsageLimitStatusAndActiveGrants',
  'aiserver.v1.DashboardService/GetEffectiveUserPlugins',
  'aiserver.v1.DashboardService/IsOnNewPricing',
  'aiserver.v1.DashboardService/GetManagedSkills',
  'aiserver.v1.DashboardService/GetTeamAdminSettingsOrEmptyIfNotInTeam',
  'aiserver.v1.DashboardService/GetTeamReposOrEmptyIfNotInTeam',
  // 3.6 新增: 不带 OrEmpty 后缀的 Team 端点 (非 team 用户打官方返回 unauthenticated 重试风暴)
  'aiserver.v1.DashboardService/GetTeamAdminSettings',
  'aiserver.v1.DashboardService/GetTeamBackgroundAgentSettings',
  'aiserver.v1.DashboardService/GetTeamRepos',
  // 'aiserver.v1.DashboardService/GetMe',
  'aiserver.v1.DashboardService/GetGlobalCommands',
  'aiserver.v1.DashboardService/GetTeamCommands',
  'aiserver.v1.DashboardService/GetSlackInstallUrl',
  'aiserver.v1.DashboardService/ShareCanvas',
  'aiserver.v1.DashboardService/LookupSharedCanvasByKey',
  'aiserver.v1.ServerConfigService',
  'aiserver.v1.NetworkService',
  'aiserver.v1.HealthService',
  'aiserver.v1.InAppAdService',

  // ── BackgroundComposerService (逐方法 stub — 启动轮询 + UI 初始化) ──
  'aiserver.v1.BackgroundComposerService/ListBackgroundComposers',
  'aiserver.v1.BackgroundComposerService/GetBackgroundComposerUserSettings',
  'aiserver.v1.BackgroundComposerService/ListTeamEnvironments',
  'aiserver.v1.BackgroundComposerService/ListPersonalEnvironments',

  // ── REST endpoints (BYOK 流程下需要的假账号 stub) ──
  'REST:/auth/has_valid_payment_method',
  'REST:/auth/poll',
  'REST:/auth/logout',
];

/** 兼容旧调用: 完整白名单 = BASE + BYOK */
export const DEFAULT_REDIRECT = [...BASE_REDIRECT, ...BYOK_REDIRECT];

// BYOK 开关: 1 = on (BYOK 启用), 0 = off (走官方)
export const DEFAULT_ROUTES = {
  $schemaVersion: 1,
  byokMode: 1,
  server: { host: DEFAULT_HOST, port: DEFAULT_PORT },
  collector: { host: DEFAULT_HOST, port: DEFAULT_COLLECTOR_PORT },
  redirect: [...BASE_REDIRECT, ...BYOK_REDIRECT],
};

/**
 * BYOK Provider 兜底常量 — server 读不到文件 / 文件损坏时的 fallback。
 * 不放任何 provider,避免"假装有配置"造成的歧义。
 * 用户通过 Cursor++ 设置面板或直接编辑 ~/.ccursor/providers.json 添加。
 */
export const DEFAULT_PROVIDERS = {
  $schemaVersion: 1,
  visionModelId: '',
  providers: [],
};

export const MODELS_CATALOG_FILE_NAME = 'models-catalog.json';
export const WEB_TOOLS_FILE_NAME = 'web-tools.json';

export const DEFAULT_WEB_TOOLS = {
  $schemaVersion: 1,
  search: {
    providers: [
      { id: 'default-ddg', type: 'duckduckgo', enabled: true },
      { id: 'default-exa', type: 'exa', enabled: false },
      { id: 'default-tavily', type: 'tavily', enabled: false },
      { id: 'default-brave', type: 'brave', enabled: false },
      { id: 'default-jina', type: 'jina', enabled: false },
      { id: 'default-firecrawl', type: 'firecrawl', enabled: false },
    ],
    parallel: false,
    maxResults: 10,
  },
  fetch: {
    provider: 'builtin',
  },
};
