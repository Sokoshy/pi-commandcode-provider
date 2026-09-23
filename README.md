# @commandcode/pi-commandcode-provider

The official [Command Code](https://commandcode.ai) provider for [pi](https://github.com/earendil-works/pi). One key, every model Command Code serves: Claude, GPT, Gemini, Grok and the open models.

## Quick start

### Prerequisites

- **A Command Code GOAT plan or higher is required.** API access is only included with GOAT and higher-tier plans. An active subscription to one of these plans is required to use this provider. See [pricing](https://commandcode.ai/pricing) for details.

  The **$1 Go plan is exclusively for use with the Command Code CLI**. Go plan credentials are not authorized for use with this provider or any external tool.

- **pi 0.86 or newer.** Check with `pi --version`.

```bash
pi install git:git@github.com:Sokoshy/pi-commandcode-provider
```

Start pi, then run these two at its prompt:

```bash
pi
```

```text
/login command-code     # paste your key, saved once to ~/.pi/agent/auth.json
/model                  # pick any Command Code model
```

Get your key from Studio, under [API keys](https://commandcode.ai/docs/studio#api-keys). The same key works for the Command Code CLI and API.

That is the whole setup. Models Command Code launches later appear in `/model` the next time you start pi, with nothing to update here.

## Start on a specific model

```bash
pi --list-models command-code                  # what is available
pi --model command-code/claude-sonnet-5        # start on one
pi --model command-code/claude-sonnet-5:high   # with a thinking level
```

## Links

| | |
|---|---|
| Models and prices | [commandcode.ai/models](https://commandcode.ai/models) |
| API keys | [commandcode.ai/docs/studio#api-keys](https://commandcode.ai/docs/studio#api-keys) |
| Provider API | [commandcode.ai/docs/provider](https://commandcode.ai/docs/provider) |
| Zero data retention | [commandcode.ai/docs/resources/zdr](https://commandcode.ai/docs/resources/zdr) |

## Environment

| Variable | Purpose |
|----------|---------|
| `CMD_API_KEY` | API key, if you would rather not store it with `/login`. `COMMAND_CODE_API_KEY` also works. |
| `CMD_ZDR` | `1` enforces zero-data-retention routing. |
| `CMD_MODELS_URL` | Overrides the models endpoint, for staging or a proxy. |
| `CMD_GENERATE_BASE_URL` | Overrides the `/alpha/generate` base, for tests or mocks. Defaults to `https://api.commandcode.ai`. |

## Zero data retention

```bash
CMD_ZDR=1 pi
```

Adds `x-cmd-zdr: 1` to every request, the same opt-in the Command Code CLI has. The gateway then routes only through zero-data-retention upstreams.

99% of Command Code models have one, and most run that way already without the flag. Coverage for a new model can lag, because provider agreements renew monthly. With the flag set and no zero-data-retention upstream available, the request fails with a 422 and `cmd_zdr_no_providers` instead of routing through a provider that retains data. Enforcing it can change which upstream serves a request, so it may cost more. See the [ZDR docs](https://commandcode.ai/docs/resources/zdr).

## Go plan fallback (private fork)

The official Provider API is tried first. On a 403 with `error.code` `upgrade_required`, the router switches to the CLI-style transport (`POST /alpha/generate`).

The chosen transport is remembered per key, and changing the key resets it. The catalog always comes from the official loader; there is no static catalog.

When a thinking level is selected on a reasoning model, `reasoning_effort` is sent verbatim.

Transport ported from `patlux/pi-commandcode-provider` v0.7.1 (commit `6fd0ac7`), for strictly private use.

## Private fork

Private fork. No npm publication, no upstream PR.

<details>
<summary>Other ways to install</summary>

`pi list` shows what is installed. `pi remove git:git@github.com:Sokoshy/pi-commandcode-provider` undoes it, and `pi update git:git@github.com:Sokoshy/pi-commandcode-provider` pulls a newer release. The source string has to match the one you installed.

The repo is private and not on npm, so install from git over SSH (your GitHub key must be on the account; HTTPS would prompt for credentials). The `git:` prefix tells pi the rest is a git URL, not a path.

From a local checkout, to develop or test an unreleased change:

```bash
git clone git@github.com:Sokoshy/pi-commandcode-provider.git
pi install ./pi-commandcode-provider
```

pi records that path without copying the files, so edits apply on the next `pi` launch with no reinstall. Moving or deleting the directory breaks the extension until you run `pi remove ./pi-commandcode-provider`. For a one-off session with no install at all, load the entry directly:

```bash
pi --extension ./pi-commandcode-provider/index.ts
```

</details>

<details>
<summary>Why cost shows $0</summary>

`/provider/v1/models` returns ids, names, context windows and routes, but no prices. Nothing here is hardcoded to fill that gap, so pi reports `$0` per model and session totals are not meaningful. Real prices are at [commandcode.ai/models](https://commandcode.ai/models).

The fix is additive and lives in the API. If the endpoint starts returning any of `pricing`, `max_output_tokens`, `modalities` or `reasoning` per model, this extension already prefers them:

```json
{
  "id": "claude-sonnet-5",
  "pricing": { "input": 2, "output": 10, "cache_read": 0.2, "cache_write": 2.5 },
  "max_output_tokens": 128000,
  "modalities": { "input": ["text", "image"] },
  "reasoning": true
}
```

Until then, `reasoning` and vision come from compatibility defaults. Models are assumed to support reasoning, preserving the provider's existing behavior. `claude-*`, `gpt-*` and `google/*` also take images; unknown families remain text-only. Context window comes from `context_length`, and max output defaults to 32K.

</details>

<details>
<summary>How routing works</summary>

Each model answers on exactly one route, and the wrong route returns a 400. `GET /provider/v1/models` reports `supported_endpoints` per model, and this extension pins each model to the API that serves it:

| Route | pi API | Models |
|-------|--------|--------|
| `/v1/messages` | `anthropic-messages` | Claude |
| `/v1/responses` | `openai-responses` | GPT |
| `/v1/chat/completions` | `openai-completions` | everything else |

Claude models use the base URL `https://api.commandcode.ai/provider`, because the Anthropic SDK appends `/v1/messages` itself. The OpenAI routes use `/provider/v1`.

On Chat Completions the system prompt goes out as a `system` message, not pi's default `developer` role. Several upstreams behind that route (Qwen, GLM-5.2, Kimi K2.7 Code) reject `developer`, and every upstream accepts `system`.

If the models endpoint is unreachable at startup, no models are registered and pi says so at session start.

</details>

<details>
<summary>Development</summary>

```bash
bun install
bun run check                                # typecheck
bun test.ts                                    # deterministic routing checks
bun run test:live                            # live catalog, no key needed
CMD_API_KEY=... bun run test:live             # one model per API
CMD_API_KEY=... bun run test:live -- --all     # the whole live catalog
CMD_API_KEY=... bun run test:live -- --reasoning high claude-sonnet-5
```

Nothing to regenerate. The catalog is whatever `/provider/v1/models` returns at startup.

</details>
