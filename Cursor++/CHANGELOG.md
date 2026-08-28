# Change Log

All notable changes to the Cursor++ BYOK extension are documented here.

Format follows [Keep a Changelog](http://keepachangelog.com/).

## [Unreleased]

### Added

- Vision model routing: when the selected main model has `supportsImages: false`,
  user attachments, image reads, and MCP/browser screenshot results route the next
  image-bearing Agent round to the configured `visionModelId`
- Sidebar **Vision Routing** selector with validation that the fallback model supports
  both image input and Agent mode
- Text-only fallback sanitization: historical image bytes are replaced with a text
  placeholder when returning to the main model, while the vision model analysis remains

### Fixed

- MCP image results are now forwarded into the Agent conversation instead of being
  reduced to an `[image ...]` text marker only

## [0.0.7]

### Added

- Edit 工具实时流式预览:对齐官方帧序列 partialToolCall → editToolCallDelta → toolCallStarted,
  LLM streaming 阶段即时显示文件名和编辑内容,不再等到 tool 执行完成才渲染
- Thinking 全链路回传:Anthropic (signature)、OpenAI Responses (encrypted_content)、
  Gemini (thoughtSignature) 各 provider 的 thinking 块正确捕获、存储、回传
- 跨 provider 切换 thinking 降级:三元组判定 (provider:model) 不匹配时 thinking 块
  安全降级为 text,避免 signature 不兼容导致 API 400 错误
- Proto Schema 类型化构造:buildToolCall 使用注册表映射 23 种 ToolCallSchema,
  替代裸 JS 对象 + as any,确保 protobuf 嵌套 submessage 正确序列化
- UI Toast 消息系统:Save 成功/失败、校验错误精确到模型名+字段,替代静默失败
- Thinking 配置全链路:前端按 provider 分类 Level/Budget 选项 → 客户端参数 →
  Server 覆盖 → LLM API 映射 (Anthropic adaptive/enabled, OpenAI reasoning_effort, Gemini thinkingLevel)
- maxOutputTokens 必填项:前端校验 + 后端验证,替代硬编码 8192 默认值
- Checkpoint committed/draft 分离:provider 错误不再覆盖已提交的恢复基线
- Anthropic prompt caching:对齐 Claude Code 策略,system 全标 + 最后 user 消息标
  cache_control ephemeral 断点,第二轮起 system prompt 从缓存读取 (0.1x 费用)
- OpenAI prompt caching:prompt_cache_key = conversationId (Chat + Responses),
  对齐 Codex CLI,同会话共享前缀缓存
- Custom Headers:ProviderEntry.headers 字段支持自定义请求头 (anthropic-beta 等),
  四家 provider 消费,UI JSON 编辑器实时语法校验
- User-Agent 对齐:Anthropic → Claude Code UA,OpenAI Responses → Codex CLI UA,
  默认值可被 headers 覆盖
- Idle hint:空窗期注入 thinkingCompleted(0) 信号,解决兼容性较差模型
  (GLM 等不流式 tool_use) 导致 UI 看起来卡死的问题

### Changed

- Edit 工具重命名:StrReplace → Edit (对齐 Claude Code 命名),保持 old_string/new_string 单编辑 Schema
- Edit description 增强:添加 Read 前置要求、行号前缀提示、连续行合并引导 (对齐 Claude Code 风格)
- Shell 工具 description:引用 "use Edit instead" 替代已移除的 StrReplace
- ApplyPatch 改用 diff 库 (structuredPatch) 生成 unified diff,替代手写 LCS
- System prompt 配置驱动:thinking 检测改用 promptProfile.thinking boolean,
  不再用 modelId.includes('opus') 等字符串匹配
- 模型选择器 context label:1048567 → "1M" (四舍五入到 0.1M 精度)
- OpenAI Responses 工具参数架构:done-first (item.arguments 为权威来源),
  delta 仅驱动 UI 流式,对齐 Codex CLI 架构
- @anthropic-ai/sdk 升级至 0.91.1:CacheControlEphemeral 类型支持

### Fixed

- Edit card 文件名不显示:修复 partialToolCall path 发送时序 (path 检测到即发,不等 content)
- Edit card 无流式预览:恢复 editRuntime fallback delta + conversationRuntime 实时流式,
  content 分 30 chars/帧发送模拟官方逐字效果
- Thinking 多轮 400 错误:toAnthropicMessage 缺少 thinking case 导致 thinking 块被丢弃;
  无 signature 时安全降级为 text (修复 DeepSeek v4 Pro 等 Anthropic 兼容 API)
- OpenAI Responses 跨 provider 切换 400:不再合成 rs_ 开头的 ResponseReasoningItem,
  仅回传有效 JSON signature 的同 provider reasoning items
- OpenAI Responses 工具参数为空:部分模型 (Codex-Spark) 不流式传参,
  arguments 在 output_item.done 一次性交付,原代码仅靠 delta 累积导致 JSON.parse("") 失败
- Windows EOL 处理:Edit/Write 工具全面 LF 规范化管线 (BOM 保留、\r\n + 裸 \r 处理、
  diff 计算两端统一 LF、写回还原原始 EOL,防 \r\r\n 双换行)
- Save provider 静默失败:校验错误精确定位到具体模型的具体字段,自动展开问题模型卡片
- 混淆器 stringConcealing 破坏 Alpine 模板:toast.tsx 使用 spread 语法避免 $store 字符串被混淆
- Fuzzy Search 点击不填入:mousedown.prevent 阻止 input 失焦导致 x-effect guard 阻止 DOM 更新,
  修复为 queueMicrotask blur
- 空窗期 UI 冻结:兼容性较差的模型 (如 GLM 不流式 tool_use) 文本结束后 23 秒无响应,
  注入 thinkingCompleted(0) 信号让客户端从 streaming_text 转到 "Generating response"

## [0.0.6]

### Fixed

- 修复云控情况下模型获取到空串的问题
  (`Model '' was not found in ~/.ccursor/providers.json`)

## [0.0.5]

### Added

- 追加 openai responses 接口类型提供商
- 追加 LLM 错误到客户端侧的错误类型包装,避免错误成为消息内容显示到对话流中,
  部分错误情况可重试继续

### Changed

- UI 简化,移除用户侧迷惑字段
- UI 优化,弃用浏览器默认组件
- V3 跟进:实施多 Variant 映射显示模型
- 热重载改进,Save 后能及时刷新模型列表
- 日志大幅详尽化,多实例显示各自的日志内容

### Fixed

- revert 行为修正:LLM 不再记得已被回滚的部分内容
- 子代理正确沿用主代理所使用的模型
- 通过对齐 Tool 定义,修正 Qwen 3.5 / Qwen 3.6 模型的
  DUMMY_TOOL_RESULT 持续性工具调用错误
- 大幅改进 GPT 模型的文件修改动作与 diff 显示
- 修复 BYOK Mode 关闭状态下不能正确登录 Cursor 的问题
