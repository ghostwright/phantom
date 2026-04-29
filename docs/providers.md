# Provider Configuration

Phantom routes every LLM query (the main agent and every evolution judge) through the Claude Agent SDK as a subprocess. By setting environment variables that the bundled `cli.js` already honors, you can point that subprocess at any Anthropic Messages API compatible endpoint without changing a line of code.

The `provider:` block in `phantom.yaml` is a small config surface that translates into those environment variables for you.

## Supported Providers

| Type | Base URL | API Key Env | Notes |
|------|----------|-------------|-------|
| `anthropic` (default) | `https://api.anthropic.com` | `ANTHROPIC_API_KEY` | Claude Opus, Sonnet, Haiku |
| `zai` | `https://api.z.ai/api/anthropic` | `ZAI_API_KEY` | GLM-5.1 and GLM-4.5-Air, roughly 15x cheaper than Opus |
| `openrouter` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | 100+ models through a single key |
| `vllm` | `http://localhost:8000` | none | Self-hosted OpenAI-compatible inference |
| `ollama` | `http://localhost:11434` | none | Local GGUF models, zero API cost |
| `litellm` | `http://localhost:4000` | `LITELLM_KEY` | Local proxy bridging OpenAI, Gemini, and others |
| `custom` | (you set it) | (you set it) | Any Anthropic Messages API compatible endpoint |

## Quick Reference

### Anthropic (default)

No configuration needed. Existing deployments continue to work unchanged.

```yaml
# phantom.yaml
model: claude-opus-4-7
# No provider block = defaults to anthropic
```

```bash
# .env
ANTHROPIC_API_KEY=sk-ant-...
```

### Z.AI / GLM-5.1

Z.AI provides an Anthropic Messages API compatible endpoint at `https://api.z.ai/api/anthropic`. Phantom ships with a `zai` preset that points there automatically. Get a key at [docs.z.ai](https://docs.z.ai/guides/llm/glm-5).

```yaml
# phantom.yaml
model: claude-sonnet-4-6
provider:
  type: zai
  api_key_env: ZAI_API_KEY
  model_mappings:
    opus: glm-5.1
    sonnet: glm-5.1
    haiku: glm-4.5-air
```

```bash
# .env
ZAI_API_KEY=<your-zai-key>
```

Both the main agent and every evolution judge route through Z.AI. The `claude-sonnet-4-6` model name is translated to `glm-5.1` on the wire by the `model_mappings` block.

### Ollama (local, free)

Run any GGUF model on your own GPU. No API key needed.

```yaml
# phantom.yaml
model: claude-sonnet-4-6
provider:
  type: ollama
  model_mappings:
    opus: qwen3-coder:32b
    sonnet: qwen3-coder:32b
    haiku: qwen3-coder:14b
```

Ollama must be running at `http://localhost:11434` (the preset default). The model must support function calling to work with Phantom's agent loop.

### vLLM (self-hosted)

For organizations running their own inference clusters.

```yaml
# phantom.yaml
model: claude-sonnet-4-6
provider:
  type: vllm
  base_url: http://your-vllm-server:8000
  model_mappings:
    sonnet: your-model-name
  timeout_ms: 300000  # local models can be slow on first call
```

Start vLLM with `--tool-call-parser` matching your model for tool use to work.

### OpenRouter

Access 100+ models through a single OpenRouter key.

```yaml
# phantom.yaml
model: claude-sonnet-4-6
provider:
  type: openrouter
  api_key_env: OPENROUTER_API_KEY
  model_mappings:
    sonnet: anthropic/claude-sonnet-4.5
```

### LiteLLM (proxy)

Run a local LiteLLM proxy to bridge OpenAI, Gemini, and other formats.

```yaml
# phantom.yaml
model: claude-sonnet-4-6
provider:
  type: litellm
  api_key_env: LITELLM_KEY
  # base_url defaults to http://localhost:4000
```

### Custom endpoint

For any Anthropic Messages API compatible proxy (LM Studio, custom internal gateways, etc.).

```yaml
# phantom.yaml
model: claude-sonnet-4-6
provider:
  type: custom
  base_url: https://your-proxy.internal/anthropic
  api_key_env: YOUR_CUSTOM_KEY_ENV
```

## Configuration Fields

| Field | Type | Default | Purpose |
|-------|------|---------|---------|
| `type` | enum | `anthropic` | One of the supported provider types |
| `base_url` | URL | preset default | Override the endpoint URL |
| `api_key_env` | string | preset default | Name of the env var holding the credential |
| `model_mappings.opus` | string | none | Concrete model ID for the opus tier |
| `model_mappings.sonnet` | string | none | Concrete model ID for the sonnet tier |
| `model_mappings.haiku` | string | none | Concrete model ID for the haiku tier |
| `disable_betas` | boolean | preset default | Sets `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`. Defaulted true for every non-anthropic preset. |
| `timeout_ms` | number | none | Sets `API_TIMEOUT_MS` for slow local inference |

## Environment Variable Overrides

For operators who prefer env variables over YAML edits:

| Variable | Effect |
|----------|--------|
| `PHANTOM_PROVIDER_TYPE` | Override `provider.type` (validated against the supported values) |
| `PHANTOM_PROVIDER_BASE_URL` | Override `provider.base_url` (validated as a URL) |
| `PHANTOM_MODEL` | Override `config.model` |

These are applied on top of the YAML-loaded config during startup.

## How It Works

The Claude Agent SDK runs as a subprocess. The SDK's bundled `cli.js` reads `ANTHROPIC_BASE_URL` and the `ANTHROPIC_DEFAULT_*_MODEL` aliases at call time. When `ANTHROPIC_BASE_URL` points at a non-Anthropic host, all Messages API requests go there instead.

The `provider:` block is translated into those environment variables by `buildProviderEnv()` in [`src/config/providers.ts`](../src/config/providers.ts). The resulting map is merged into both the main agent query and the evolution judge query, so changing providers flips both tiers in lockstep.

## Why keep a Claude model name in `model:`?

The bundled `cli.js` has hardcoded model-name arrays for capability detection (thinking tokens, effort levels, compaction, etc.). Passing a literal `glm-5.1` as the model can break those checks. The recommended pattern is:

1. Set `model: claude-sonnet-4-6` (or Opus) in `phantom.yaml` so `cli.js` treats the call as a known Claude model
2. Set `model_mappings.sonnet: glm-5.1` in the provider block so the wire call goes to GLM-5.1

This is the same pattern Z.AI's own documentation recommends.

## Troubleshooting

**Phantom responds but the logs show Claude-shaped costs.**
The bundled `cli.js` calculates `total_cost_usd` from its local Claude pricing table based on the model name string. Cost reporting is not provider-aware, so the logged cost will look like Claude pricing even when the request went to Z.AI or another provider. The actual charge on your provider's bill will differ.

**Auto mode judges fall back to heuristic mode.**
`resolveJudgeMode` in auto mode enables LLM judges when any of these are true: (a) a non-anthropic provider is configured, (b) `provider.base_url` is set, (c) `ANTHROPIC_API_KEY` is present, or (d) `~/.claude/.credentials.json` exists. If none hold, judges run in heuristic mode. Set `judges.enabled: always` in `config/evolution.yaml` to force LLM judges on.

**Third-party proxy rejects a beta header.**
`disable_betas: true` is already the default for every non-anthropic preset, which sets `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`. If you still see beta header errors, explicitly set `disable_betas: true` on your provider block to make sure it overrides any custom `disable_betas: false`.

**Tool calls fail with small local models.**
Phantom's tool system assumes strong function-calling capability. Models like Qwen3-Coder and GLM-5.1 handle it well; smaller models often fail on complex multi-step tool chains. Test with a strong model first, then drop down.

**Subprocess fails with a missing-credential error.**
Phantom does not validate credentials at load time. The subprocess only sees the provider env vars when a query runs. If `api_key_env` names a variable that is not set in the process environment, the subprocess will fail at call time with the provider's own error message.
