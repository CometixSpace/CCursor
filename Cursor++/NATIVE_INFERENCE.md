# Native Grok inference forwarding (experimental)

For an opted-in model, Cursor's local Agent loop owns prompts, tool execution,
conversation state, and compaction. Cursor++ implements the inference protocol
and sends each normal or summarization invocation through the configured provider.
It does not start a second Agent loop or run plugin compaction on that path.

The initial adapter supports configured Grok 4.6 and 4.7 models through an
Anthropic-compatible provider. Context size comes from the model configuration.
Other providers are rejected rather than assigned a different model family.

The native-loop installer patch checks the supported runtime structure and fails
before writing when it changes. It preserves Cursor's action/mode eligibility
checks. The feature is off by default. To opt in, add the configured model IDs to
`nativeInferenceModels` in `routes.json` and add these inference routes:

```json
{
  "nativeInferenceModels": ["grok-4.6", "grok-4.7"],
  "redirect": [
    "aiserver.v1.InferenceService/Stream",
    "aiserver.v1.InferenceService/RunInferenceSSE",
    "aiserver.v1.BidiService/BidiAppend"
  ]
}
```

Merge these entries with the existing redirect list. Keep the Agent routes for
models using the legacy loop. Toggling BYOK off removes the inference routes;
toggling it on preserves the opt-in. Remove `nativeInferenceModels` to restore
the previous routing policy, then reload Cursor.

The first supported transport is HTTP/1.1 SSE with BidiAppend. Appends are held
as opaque bytes until the SSE endpoint chooses its decoder. Sequence ordering,
retry deduplication, cancellation, stream completion, and native token-limit errors
are preserved. Unsupported provider-defined tools and multimodal tool results
produce explicit errors.

Validation includes native-client wire compatibility, normal and summarization
invocations, the installed native generic compactor on a synthetic long tool
chain, and a real configured provider with synthetic inputs. No native runtime
implementation or captured conversation is included in this repository. Full UI
acceptance, automatic compaction at a full context window, existing-conversation
migration, and network-backed Agent tools require separate verification.
