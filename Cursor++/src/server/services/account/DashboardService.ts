/**
 * aiserver.v1.DashboardService — 账户/设置/管理服务
 *
 * 306 方法，Cursor 最大的管理服务，涵盖:
 *   - 计费 (28): GetPlanInfo, GetCurrentPeriodUsage, GetUsageLimitStatus, IsOnNewPricing...
 *   - 团队 (77): GetTeams, GetTeamAdminSettings, SendTeamInvite, ChangeSeat...
 *   - 插件 (27): GetEffectiveUserPlugins, GetManagedSkills, InstallUserPlugin...
 *   - Slack (19): GetSlackInstallUrl, SetSlackAuth, GetSlackTeamSettings...
 *   - GitHub/Linear (22): ConnectGithubCallback, ConnectLinearCallback...
 *   - MCP (12): GetPluginMcpConfig, StoreMcpOAuthToken...
 *   - 命令 (2): GetGlobalCommands, GetTeamCommands
 *   - 隐私 (4): GetUserPrivacyMode, SetPrivacyMode...
 *   - 反馈 (19): SubmitFeedback, ReportBugbotDeeplinkEvent...
 *   - BGComposer (5): ListBackgroundComposerSecrets, CreateBackgroundComposerSecret...
 *   - 其他 (71): GetDefaultModel, GetServerConfig, Bedrock IAM...
 *
 * Transport: backendUrl (api2.cursor.sh)
 *   部分方法有 transport 覆盖:
 *     - listBackgroundComposerSecrets, create/revoke → backgroundComposerProxyTransport
 */
import type { ConnectRouter } from '@connectrpc/connect';
import { create } from '@bufbuild/protobuf';
import {
    DashboardService,
    GetPlanInfoResponse_PlanInfoSchema,
    GetCurrentPeriodUsageResponse_PlanUsageSchema,
    PrivacyMode,
    GetUsageLimitStatusAndActiveGrantsResponse_UsageLimitPolicyStatusSchema,
} from '../../gen/aiserver_v1_pb';
import { exportCanvasHtml, getCanvasesDir, lookupCanvasByKey, storeCanvas } from '../../handlers/canvas/canvasStore';
import { fetchManagedSkills } from '../../config/managedSkillsStore';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BYOK_GET_ME_RESPONSE = {
    authId: 'auth0|user_COMETIX01J4XQQFHW0644WB114',
    userId: 39831831,
    email: 'Cursor@cometix.dev',
    firstName: 'Cursor',
    lastName: 'BYOK',
    workosId: 'user_COMETIX01J4XQQFHW0644WB114',
    createdAt: '2024-08-10T08:51:16.450Z',
    isEnterpriseUser: false,
    emailDomainType: 'professional',
    country: 'SG',
    teamName: 'Cometix Space',
    profilePictureUrl: 'data:image/jpeg;base64,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',
    cursorReviewOnboardingUseCursorGithubApp: false,
}

export default (router: ConnectRouter) => {
    router.service(DashboardService, {
        getPlanInfo: async () => ({
            planInfo: create(GetPlanInfoResponse_PlanInfoSchema, {
                planName: 'Cometix',
                includedAmountCents: 999900,
                price: '$200/mo (BYOK)',
                billingCycleEnd: BigInt(Date.now() + 365 * 86400000),
            }),
        }),

        getCurrentPeriodUsage: async () => ({
            billingCycleStart: BigInt(Date.now() - 30 * 86400000),
            billingCycleEnd: BigInt(Date.now() + 30 * 86400000),
            planUsage: create(GetCurrentPeriodUsageResponse_PlanUsageSchema, {
                remaining: 999900,
                limit: 999900,
            }),
            enabled: true,
            displayMessage: 'BYOK — unlimited',
        }),

        getTeams: async () => ({}),
        getUserPrivacyMode: async () => ({ privacyMode: PrivacyMode.NO_TRAINING }),

        getUsageLimitStatusAndActiveGrants: async () => ({
            usageLimitPolicyStatus: create(GetUsageLimitStatusAndActiveGrantsResponse_UsageLimitPolicyStatusSchema, {
                canConfigureSpendLimit: true,
            }),
        }),

        getEffectiveUserPlugins: async () => ({}),
        // 插件市场 — 后续可考虑透传到官方 API 获取真实数据
        listMarketplacePlugins: async () => ({ plugins: [] }),
        // hasAutoSpillover: true → Settings 侧边栏显示 "Plan & Usage" (对齐官方)
        isOnNewPricing: async () => ({
            isOnNewPricing: true,
            hasAutoSpillover: true,
        }),
        getManagedSkills: async (_req, { requestHeader }) => {
            return await fetchManagedSkills(requestHeader ?? new Headers()) as any
        },
        getTeamAdminSettingsOrEmptyIfNotInTeam: async () => ({}),
        getTeamReposOrEmptyIfNotInTeam: async () => ({}),
        // 3.6 新增: 不带 OrEmpty 后缀 — 非 team 用户打官方返回 unauthenticated 重试风暴
        getTeamAdminSettings: async () => ({}),
        getTeamBackgroundAgentSettings: async () => ({}),
        getTeamRepos: async () => ({}),
        // GetMe — 使用 rpc-test 从官方账号抓取的真实响应形状与属性值。
        getMe: async () => ({ ...BYOK_GET_ME_RESPONSE }),
        getGlobalCommands: async () => ({}),
        getTeamCommands: async () => ({}),
        getSlackInstallUrl: async () => ({}),

        shareCanvas: async (req) => {
            const result = storeCanvas({
                title: req.title,
                appJs: req.appJs,
                dataJson: req.dataJson,
                canvasKey: req.canvasKey,
            })
            const html = exportCanvasHtml({
                title: req.title,
                appJsGzip: req.appJs,
                dataJson: req.dataJson,
            })
            const safeName = Array.from(req.title || 'canvas', character =>
                /[<>:"/\\|?*]/.test(character) || character.charCodeAt(0) < 32 ? '_' : character,
            ).join('').trim() || 'canvas'
            const exportPath = join(getCanvasesDir(), `${safeName}.html`)
            writeFileSync(exportPath, html)
            return { shareId: result.shareId, shareUrl: `file://${exportPath}` }
        },

        lookupSharedCanvasByKey: async (req) => {
            const meta = lookupCanvasByKey(req.canvasKey)
            if (!meta) return {}
            return { shareId: meta.shareId, shareUrl: `file://${join(meta.dir, 'export.html')}` }
        },
    });
};
