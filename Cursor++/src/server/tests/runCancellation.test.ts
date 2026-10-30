import { create, toBinary, toJson } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { AgentClientMessageSchema, ConversationActionSchema } from '../gen/agent_v1_pb'
import {
  createEphemeralSession,
  isSessionCancelled,
  pushSessionMessage,
  waitForMessageMatching,
} from '../handlers/agent/session'
import {
  AgentRunAbortedError,
  isAgentRunAbortedError,
  isSessionCancellationError,
  throwIfSessionCancelled,
  waitForExecMessageMatching,
} from '../handlers/agent/wait'

/**
 * 客户端中断 (cancelAction) 的消费。
 *
 * ControlledConversationActionManager.abort() 会往 BiDi 客户端流发
 * ConversationAction{cancelAction},随后才本地 abort。这是服务端唯一能
 * 感知"该停了"的应用层信号 —— 不消费它,旧 run 会一直跑到 LLM 流自然结束。
 *
 * 触发场景 (3.17.19 实测 reason):
 *   "new_message_submitted"    submitChatMaybeAbortCurrent —— 提交新消息抢占,
 *                              也是 steer 降级后 escalation 走的路径
 *   "user_stopped_generation"  用户点停止按钮
 */

function cancelMessage(reason: string): Record<string, unknown> {
  return { conversationAction: { cancelAction: { reason } } }
}

describe('cancelAction 的识别', () => {
  it('设置 cancelledReason 并且不堆进消息队列', () => {
    const session = createEphemeralSession('cancel-1')
    pushSessionMessage(session, cancelMessage('new_message_submitted'))

    expect(session.cancelledReason).toBe('new_message_submitted')
    expect(isSessionCancelled(session)).toBe(true)
    // 没有任何 predicate 会匹配它,留在 messages 里只会永久积压
    expect(session.messages).toHaveLength(0)
  })

  it('缺省 reason 同样算中断 —— proto3 里空串与缺省不可区分', () => {
    const session = createEphemeralSession('cancel-2')
    pushSessionMessage(session, { conversationAction: { cancelAction: {} } })
    expect(isSessionCancelled(session)).toBe(true)
    expect(session.cancelledReason).toBe('cancelled')
  })

  it('reason 以最先到达的为准,重复中断不覆盖', () => {
    const session = createEphemeralSession('cancel-3')
    pushSessionMessage(session, cancelMessage('new_message_submitted'))
    pushSessionMessage(session, cancelMessage('user_stopped_generation'))
    expect(session.cancelledReason).toBe('new_message_submitted')
  })

  it('普通 conversationAction 不误判', () => {
    const session = createEphemeralSession('cancel-4')
    pushSessionMessage(session, {
      conversationAction: { userMessageAction: { userMessage: { text: 'hi' } } },
    })
    expect(isSessionCancelled(session)).toBe(false)
    expect(session.messages).toHaveLength(1)
  })

  it('从真实 proto 编解码后仍能识别', () => {
    const msg = create(AgentClientMessageSchema, {
      message: {
        case: 'conversationAction',
        value: { action: { case: 'cancelAction', value: { reason: 'new_message_submitted' } } },
      },
    })
    const session = createEphemeralSession('cancel-5')
    pushSessionMessage(session, toJson(AgentClientMessageSchema, msg) as Record<string, unknown>)
    expect(session.cancelledReason).toBe('new_message_submitted')
  })

  it('对得上线上实测的 27 字节 —— 该报文确系 cancelAction', () => {
    // 日志实测: steer ack 后 78ms 客户端发来 protoBytes=27 的 conversationAction。
    // 客户端 submitChatMaybeAbortCurrent 调的是
    //   abort("new_message_submitted", { interruptedPendingToolCallResolutions })
    const action = create(ConversationActionSchema, {
      action: {
        case: 'cancelAction',
        value: { reason: 'new_message_submitted', interruptedPendingToolCallResolutions: {} },
      },
    })
    expect(toBinary(ConversationActionSchema, action).length).toBe(27)
  })
})

describe('中断对等待中的工具的影响', () => {
  it('中断立即结束等待,不再空等到超时', async () => {
    const session = createEphemeralSession('cancel-6')
    const pending = waitForMessageMatching(session, msg => 'execClientMessage' in msg, 5000)

    pushSessionMessage(session, cancelMessage('user_stopped_generation'))

    expect(await pending).toBeNull()
  })

  it('工具等待转成 AgentRunAbortedError,而不是拿着 null 继续跑', async () => {
    const session = createEphemeralSession('cancel-7')
    const pending = waitForExecMessageMatching(session, 1, msg => 'execClientMessage' in msg, 5000)

    pushSessionMessage(session, cancelMessage('new_message_submitted'))

    await expect(pending).rejects.toSatisfy(isAgentRunAbortedError)
  })

  it('throwIfSessionCancelled 未中断时是空操作', () => {
    const session = createEphemeralSession('cancel-8')
    expect(() => throwIfSessionCancelled(session)).not.toThrow()
    pushSessionMessage(session, cancelMessage('user_stopped_generation'))
    expect(() => throwIfSessionCancelled(session)).toThrow(/user_stopped_generation/)
  })

  it('区分父会话取消与单个 exec throw', () => {
    const session = createEphemeralSession('cancel-9')
    const execError = new AgentRunAbortedError('subagent failed', { execMessageId: 9 })

    expect(isSessionCancellationError(session, execError)).toBe(false)

    pushSessionMessage(session, cancelMessage('user_stopped_generation'))
    expect(isSessionCancellationError(session, execError)).toBe(true)
  })
})
