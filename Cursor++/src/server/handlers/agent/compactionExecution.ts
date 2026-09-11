import type { AgentServerMessage } from '../../gen/agent_v1_pb';
import type { ProviderRuntime } from '../llm/providerRuntime';
import type { BlobRunContext } from './runContext';
import { logger } from '../../logger';
import { saveRunCheckpoint, throwIfBlobRunInactive } from './checkpointManager';
import { waitForCompactionLockRelease } from './compactionLock';
import {
    buildSummarySource,
    createCompactionArtifacts,
    measureMessagesTokens,
    retainCompactionArtifacts,
    streamSummaryWithFallback,
    type CompactionArtifacts,
    type CompactionPlan,
} from './compactionStrategy';
import { heartbeat, summary } from './stream';
import { clampTokenDetails } from './usage';
import { HEARTBEAT_TICK, pumpWithTimedHeartbeats, waitForPromiseWithHeartbeat } from './wait';

interface CompactionExecutionParams {
    run: BlobRunContext;
    conversationId: string;
    origin: 'inline' | 'client_summarize';
    plan: CompactionPlan;
    route: Pick<ProviderRuntime, 'provider' | 'model'>;
    contextTokenLimit: number;
    turnBlobIds: string[];
    previousSummaryArchiveIds: string[];
    mode: string;
}

export async function* waitForRunCompactionLockRelease(
    conversationId: string,
    run: BlobRunContext,
): AsyncGenerator<AgentServerMessage, void, void> {
    const cancellation = new AbortController();
    try {
        throwIfBlobRunInactive(run);
        yield* waitForPromiseWithHeartbeat(waitForCompactionLockRelease(
            conversationId, AbortSignal.any([run.signal, cancellation.signal]),
        ));
        throwIfBlobRunInactive(run);
    }
    finally {
        cancellation.abort();
    }
}

/** Execute an admitted plan; entry points retain lock, hook and UI completion policy. */
export async function* executeCompaction(params: CompactionExecutionParams): AsyncGenerator<AgentServerMessage, {
    artifacts: CompactionArtifacts;
    tokenDetails: ReturnType<typeof clampTokenDetails>;
}, void> {
    const { run, plan, route, contextTokenLimit, conversationId } = params;
    throwIfBlobRunInactive(run);
    const summarySourceText = buildSummarySource(plan.summarizeEntries, { contextTokenLimit });
    const startedAt = Date.now();
    logger.info({
        conversationId,
        model: route.model,
        sourceTextLen: summarySourceText.length,
        summarizeEntries: plan.summarizeEntries.length,
        keepTail: plan.keepTail.length,
    }, '[SUMMARIZE] LLM summary starting');

    let summaryText = '';
    for await (const summaryEvent of pumpWithTimedHeartbeats(signal => streamSummaryWithFallback({
        provider: route.provider,
        signal,
        model: route.model,
        sourceText: summarySourceText,
        contextTokenLimit,
    }), undefined, run.signal)) {
        throwIfBlobRunInactive(run);
        if (summaryEvent === HEARTBEAT_TICK) {
            yield heartbeat();
            continue;
        }
        if (summaryEvent.type === 'delta') {
            summaryText += summaryEvent.text;
            yield summary(summaryEvent.text);
        }
        if (summaryEvent.type === 'done')
            summaryText = summaryEvent.text;
    }
    throwIfBlobRunInactive(run);
    logger.info({
        conversationId,
        summaryLen: summaryText.length,
        durationMs: Date.now() - startedAt,
    }, '[SUMMARIZE] LLM summary done');

    const artifacts = createCompactionArtifacts({
        plan,
        summaryText,
        previousSummaryArchiveIds: params.previousSummaryArchiveIds,
    });
    retainCompactionArtifacts(run.blobs, artifacts);
    const tokenDetails = clampTokenDetails(
        measureMessagesTokens(artifacts.rootEntries.map(entry => entry.message)),
        contextTokenLimit,
    );
    logger.info({
        conversationId,
        origin: params.origin,
        kind: 'committed',
        usedTokens: tokenDetails.usedTokens,
        maxTokens: tokenDetails.maxTokens,
        rootBlobCount: artifacts.nextRootBlobIds.length,
        summaryArchiveCount: artifacts.nextSummaryArchiveIds.length,
    }, '[AUTOCOMPACT] checkpoint write');

    yield* saveRunCheckpoint(run, {
        conversationId,
        kind: 'committed',
        rootBlobIds: artifacts.nextRootBlobIds,
        turnBlobIds: params.turnBlobIds,
        summaryArchiveIds: artifacts.nextSummaryArchiveIds,
        tokenDetails,
        mode: params.mode,
    });
    return { artifacts, tokenDetails };
}
