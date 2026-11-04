# Cursor++

Cursor++ BYOK Extension — Bring Your Own Key for Cursor IDE.

## Development

```bash
pnpm install
pnpm run check-types
pnpm run lint
pnpm run test:server
pnpm run package
```

## Vision Model Routing

`~/.ccursor/providers.json` supports a top-level `visionModelId`. The sidebar exposes the same setting under **Vision Routing**.

When the selected main model has `supportsImages: false`, a user attachment, an image read through the `Read` tool, or image content returned by an MCP/browser screenshot tool routes only the next image-bearing Agent round to the configured vision model. The vision model must support both Images and Agent mode. Text-only rounds return to the main model automatically.

Before a text-only model is called again, historical image bytes are replaced with a text placeholder. The vision model's textual analysis remains available, so the main model can continue without receiving unsupported image blocks.

If no valid vision model is configured, the Agent run stops with a non-retryable configuration banner instead of silently dropping the image.

## Implementation Notes and Follow-ups

- Models with no explicit `supportsImages` value retain the existing compatibility behavior and are treated as image-capable. Set `supportsImages: false` for known text-only models.
- The current tool-result bridge forwards the first valid image returned by one MCP tool call. This covers normal screenshot tools; a future enhancement may preserve multiple images from a single result.
- On Windows, a few existing SQLite integration tests can fail during temporary-directory cleanup with `EBUSY` even after their assertions complete. The vision routing tests do not depend on SQLite.
