/**
 * 会话级压缩互斥锁 (设计文档 §7#7, 2026-08-29 审计修正升级为本阶段实施)
 *
 * 动机: inline 自动压缩与 summarizeAction 手动压缩并发时, 后写者可能用
 * 较旧的历史覆盖更新状态 (数据丢失, 严重性高于"无害只浪费")。
 * 同进程锁串行化摘要生成; checkpoint 写入另由 run admission 的版本作用域保护。
 *
 * 语义:
 *   - inline 路径用 tryAcquire: 锁被占则本轮跳过 (计数观测, 下轮重试)
 *   - summarizeAction 路径用 waitForRelease: 等待持锁者完成后再重新评估
 */

interface CompactionLockEntry {
    held: boolean;
    waiters: Array<() => void>;
    contentionCount: number;
}

const compactionLocks = new Map<string, CompactionLockEntry>();

function getOrCreateLock(conversationId: string): CompactionLockEntry {
    let entry = compactionLocks.get(conversationId);
    if (!entry) {
        entry = { held: false, waiters: [], contentionCount: 0 };
        compactionLocks.set(conversationId, entry);
    }
    return entry;
}

/** 尝试获取; 已被占则计数并返回 false (inline 路径: 跳过本轮) */
export function tryAcquireCompactionLock(conversationId: string): boolean {
    const entry = getOrCreateLock(conversationId);
    if (entry.held) {
        entry.contentionCount++;
        return false;
    }
    entry.held = true;
    return true;
}

/** 等待锁释放 (不获取 — summarizeAction 释放后重新评估是否仍需压缩) */
export function waitForCompactionLockRelease(conversationId: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted)
        return Promise.resolve();
    const entry = compactionLocks.get(conversationId);
    if (!entry?.held)
        return Promise.resolve();
    entry.contentionCount++;
    return new Promise((resolve) => {
        const finish = (): void => {
            signal?.removeEventListener('abort', finish);
            const waiterIndex = entry.waiters.indexOf(finish);
            if (waiterIndex >= 0)
                entry.waiters.splice(waiterIndex, 1);
            resolve();
        };
        entry.waiters.push(finish);
        signal?.addEventListener('abort', finish, { once: true });
    });
}

/** 释放; 唤醒全部等待者 (等待者自行重评估, 不自动传递锁) */
export function releaseCompactionLock(conversationId: string): void {
    const entry = compactionLocks.get(conversationId);
    if (!entry)
        return;
    entry.held = false;
    const waiters = [...entry.waiters];
    entry.waiters = [];
    for (const waiter of waiters)
        waiter();
    if (!entry.held && entry.waiters.length === 0)
        compactionLocks.delete(conversationId);
}

/** 当前持锁周期的争用计数; 随锁释放, 不保留历史会话表。 */
export function getCompactionContentionCount(conversationId: string): number {
    return compactionLocks.get(conversationId)?.contentionCount ?? 0;
}

/** 只读探测 (不计争用): 错误驱动重试路径的等待循环用 */
export function isCompactionLockHeld(conversationId: string): boolean {
    return compactionLocks.get(conversationId)?.held === true;
}
