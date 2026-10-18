/**
 * 服务注册入口 — 27 个 ConnectRPC 服务
 *
 * 按用途分类:
 *   core/       — 核心 AI 能力 (AiService, ChatService, AgentService, BackgroundComposer, Bidi, Replay)
 *   completion/ — 代码补全 (CppService, CmdKService, FileSyncService)
 *   account/    — 账户/设置 (DashboardService, AuthService, InAppAdService)
 *   telemetry/  — 遥测/事件 (Analytics, Metrics, Profiling, Trace, *EventService)
 *   infra/      — 基础设施 (ServerConfig, Network, Health)
 *   repo/       — 代码仓库 (Repository, GitIndex, Upload)
 *   mcp/        — MCP (MCPRegistryService)
 *
 * Transport 分布:
 *   api2 (BYOK 拦截)  — core/, account/, telemetry/ 大部分, infra/ServerConfig+Network, completion/Cpp
 *   api5 (BYOK 拦截)  — core/AgentService, infra/HealthService
 *   repo42 (不拦截)    — repo/*
 *   api3 (不拦截)      — completion/CmdKService
 *   geoCpp (不拦截)    — completion/FileSyncService
 *   bcProxy (BYOK stub) — core/BackgroundComposerService
 */
import type { ConnectRouter } from '@connectrpc/connect';

// core
import AiService from './core/AiService';
import ChatService from './core/ChatService';
import AgentService from './core/AgentService';
import InferenceService from './core/InferenceService';
import BackgroundComposerService from './core/BackgroundComposerService';
import BidiService from './core/BidiService';
import ReplayChatService from './core/ReplayChatService';

// completion
import CppService from './completion/CppService';
import CmdKService from './completion/CmdKService';
import FileSyncService from './completion/FileSyncService';

// account
import DashboardService from './account/DashboardService';
import AuthService from './account/AuthService';
import InAppAdService from './account/InAppAdService';

// telemetry
import AnalyticsService from './telemetry/AnalyticsService';
import MetricsService from './telemetry/MetricsService';
import ProfilingService from './telemetry/ProfilingService';
import WebProfilingService from './telemetry/WebProfilingService';
import TraceService from './telemetry/TraceService';
import ChatRequestEventService from './telemetry/ChatRequestEventService';
import ToolCallEventService from './telemetry/ToolCallEventService';
import PerformanceEventService from './telemetry/PerformanceEventService';

// infra
import ServerConfigService from './infra/ServerConfigService';
import NetworkService from './infra/NetworkService';
import HealthService from './infra/HealthService';

// repo
import RepositoryService from './repo/RepositoryService';
import GitIndexService from './repo/GitIndexService';
import UploadService from './repo/UploadService';

// mcp
import MCPRegistryService from './mcp/MCPRegistryService';

export default (router: ConnectRouter) => {
    // core
    AiService(router);
    ChatService(router);
    AgentService(router);
    InferenceService(router);
    BackgroundComposerService(router);
    BidiService(router);
    ReplayChatService(router);

    // completion
    CppService(router);
    CmdKService(router);
    FileSyncService(router);

    // account
    DashboardService(router);
    AuthService(router);
    InAppAdService(router);

    // telemetry
    AnalyticsService(router);
    MetricsService(router);
    ProfilingService(router);
    WebProfilingService(router);
    TraceService(router);
    ChatRequestEventService(router);
    ToolCallEventService(router);
    PerformanceEventService(router);

    // infra
    ServerConfigService(router);
    NetworkService(router);
    HealthService(router);

    // repo
    RepositoryService(router);
    GitIndexService(router);
    UploadService(router);

    // mcp
    MCPRegistryService(router);
};
