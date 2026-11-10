# @sokoshy/pi-commandcode-provider

An unofficial fork of the [Command Code](https://commandcode.ai) provider for [pi](https://github.com/earendil-works/pi). One key, every model Command Code serves: Claude, GPT, Gemini, Grok and the open models. Adds a Go-plan fallback transport so the $1 Go plan works too.

## Quick start

### Prerequisites

- **Any Command Code plan with credits works, including the $1 Go plan.** Plans with Provider API access (GOAT and higher) use the native Provider API. Go keys are served through the CLI-style fallback transport instead (see [Go plan fallback](#go-plan-fallback)). See [pricing](https://commandcode.ai/pricing) for details.

- **pi 0.86 or newer.** Check with `pi --version`.

```bash
pi install git:git@github.com/Sokoshy/pi-commandcode-provider
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
| `CMD_CLIENT_MODELS_URL` | Overrides the capability-view endpoint; `0` disables it. |
| `CMD_GENERATE_BASE_URL` | Overrides the `/alpha/generate` base, for tests or mocks. Defaults to `https://api.commandcode.ai`. |

## Zero data retention

```bash
CMD_ZDR=1 pi
```

Adds `x-cmd-zdr: 1` to every request, the same opt-in the Command Code CLI has. The gateway then routes only through zero-data-retention upstreams.

99% of Command Code models have one, and most run that way already without the flag. Coverage for a new model can lag, because provider agreements renew monthly. With the flag set and no zero-data-retention upstream available, the request fails with a 422 and `cmd_zdr_no_providers` instead of routing through a provider that retains data. Enforcing it can change which upstream serves a request, so it may cost more. See the [ZDR docs](https://commandcode.ai/docs/resources/zdr).

## Go plan fallback

The Command Code Provider API is tried first. On a 403 with `error.code` `upgrade_required`, the router switches to the CLI-style transport (`POST /alpha/generate`).

The chosen transport is remembered per key, and changing the key resets it. The catalog always comes from the upstream models endpoint; there is no static catalog.

When a thinking level is selected on a reasoning model, `reasoning_effort` is sent verbatim.

Transport ported from [`patlux/pi-commandcode-provider`](https://github.com/patlux/pi-commandcode-provider) v0.7.1 (commit `6fd0ac7`), Copyright (c) 2025 Pat Woz, MIT License. The full permission notice is in [`NOTICE`](NOTICE).

## Thinking levels

pi exposes the levels `off`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max` per model, controlled by the model's `thinkingLevelMap`. `xhigh` and `max` are hidden unless that map defines them, and any level mapped to `null` is hidden.

This extension builds each model's map from the Command Code capability view (`reasoningEfforts` per model): the efforts Command Code lists become the same-named pi levels, and every pi level not in the list becomes `null` (hidden), including `minimal`, which no Command Code model exposes. A model whose `reasoningEfforts` is `null` (Kimi K2.x, Qwen 3.6/3.7, GLM-5.2-Fast, …) gets no map, so pi's default map applies unchanged.

- Muse Ember → `low`, `medium`, `high`, `xhigh`, `max`
- Claude (Opus/Sonnet/Fable/Haiku 4.6 and later) → `low` through `max`
- DeepSeek → `off` plus family-specific levels — the only Command Code models exposing `off`
- GLM → family-dependent; GLM-5.2 is `high` and `max` only

If the capability view fails, pi's default map applies and pi shows a warning at session start (see [Where prices, modalities and thinking levels come from](#where-prices-modalities-and-thinking-levels-come-from)). To widen or pin a model's levels yourself, use `modelOverrides` for this provider in `~/.pi/agent/models.json` with a `thinkingLevelMap` — user overrides are applied last, so they win.

## License and attribution

Unofficial fork of [`CommandCodeAI/pi-commandcode-provider`](https://github.com/CommandCodeAI/pi-commandcode-provider), Copyright 2026 Command Code, [Apache License 2.0](LICENSE). It is not affiliated with, endorsed by, or supported by Command Code: the name is used only to describe the origin of the work and the service it connects to.

Files changed by this fork carry a change notice as Apache 2.0 section 4(b) requires. [`NOTICE`](NOTICE) lists them and holds the third-party attributions. `src/go-*.ts` are ported from [`patlux/pi-commandcode-provider`](https://github.com/patlux/pi-commandcode-provider) v0.7.1, Copyright (c) 2025 Pat Woz, MIT License.

Not published to npm.

<details>
<summary>Other ways to install</summary>

`pi list` shows what is installed. `pi remove git:git@github.com:Sokoshy/pi-commandcode-provider` undoes it, and `pi update git:git@github.com:Sokoshy/pi-commandcode-provider` pulls a newer release. The source string has to match the one you installed.

The package is not published to npm, so install it from git. The `git:` prefix tells pi the rest is a git URL, not a path. SSH needs your GitHub key on the account; HTTPS would prompt for credentials on a private repo.

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
<summary>Where prices, modalities and thinking levels come from</summary>

pi would report `$0` per model from the public `GET /provider/v1/models` catalog alone, because that endpoint returns ids, names, context windows and routes but no prices or capability flags. At startup this extension also fetches the capability view the Command Code CLI reads (`GET /provider/v1/models?view=client`) and merges it by model id:

| Capability view field | Used for |
|-----------------------|----------|
| `reasoningEfforts` | the model's `thinkingLevelMap` |
| `pricing` (incl. `contextTiers`) | the model's `cost` (USD per million tokens) |
| `inputModalities` | `text`/`image` input |
| `maxOutputTokens` | the model's `maxTokens` |

Nothing is hardcoded. If the capability view is unreachable or changes shape, the provider still loads from the public catalog — routing and context windows work, thinking levels use pi's defaults, and pi reports `$0` prices — and a warning is shown at session start. Set `CMD_CLIENT_MODELS_URL=0` to disable the capability view explicitly, or point it at a mirror with `CMD_CLIENT_MODELS_URL=https://…`.
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
