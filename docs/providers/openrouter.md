# OpenRouter

OpenRouter is one API key that reaches models from Anthropic, OpenAI, Google,
DeepSeek, xAI, and others. In Toolport Studio it runs through the **API Key
Provider** driver, the same one DeepSeek uses.

There are two different ways to reach OpenRouter from this app, and picking the
wrong one produces errors that look like a bad key:

- **This page** — OpenRouter as an API Key Provider instance, through the Codex
  harness. Pick a model per turn, get reasoning effort and interruption like any
  other provider. This is the one you want.
- **[The Claude route](claude.md#i-want-to-use-openrouter)** — pointing Claude
  Code at OpenRouter's Anthropic-compatible endpoint with environment
  variables. Use it only if you specifically want the Claude harness.

## Setup

1. Create an API key at [openrouter.ai/keys](https://openrouter.ai/keys).
2. In Settings, go to Providers and click **Add provider instance**.
3. Choose the **API Key Provider** driver.
4. Set **Provider** to OpenRouter, give it a label, and save.
5. On the new instance card, under **Environment variables**, add:

   ```text
   Name:      OPENROUTER_API_KEY
   Value:     sk-or-...
   Sensitive: on
   ```

Leave **Binary path** empty.

Sensitive values are kept in the server's secret store, not in `settings.json`,
and are never written into the generated provider config.

The instance is ready when its card reads **Authenticated · OpenRouter API Key**.

## Models

Unlike a single-vendor provider, the model list is not shipped with the app. On
instance start Toolport Studio fetches your account's catalog from OpenRouter
and reads each model's real context window, reasoning levels, and vision
support from it. Nothing here goes stale between releases.

A fresh instance starts with a small seed lineup, including one free model so
you can complete a turn before adding credits. Treat that one as a way to
confirm the setup works, not as a daily driver: every `:free` slug is pinned to
a single donated backend with no failover, and free models share a 50-request
daily cap per account that an agent burns through fast.

To use anything else, add its slug under **Models** on the instance card,
exactly as OpenRouter writes it:

```text
anthropic/claude-opus-5
openai/gpt-5.6-terra
z-ai/glm-5.2
```

Browse slugs at [openrouter.ai/models](https://openrouter.ai/models). A slug you
add is resolved against the catalog like any seed, so it arrives with correct
metadata rather than as an unknown model.

Aside from the free seed, everything here is paid, including DeepSeek. If
DeepSeek is the only model you want, the [direct DeepSeek
provider](deepseek.md) reaches it without going through a router.

Two things are filtered out on purpose:

- **Models that cannot call tools** never appear, even if you add the slug.
  Coding sessions are tool calls end to end, so such a model would greet you and
  then fail on the first command.
- **Slugs OpenRouter does not serve** are skipped rather than failing the
  instance. If a model you added never shows up, check it for typos.

The catalog is read once per instance start. A model released this morning
appears after you restart the instance.

## Images

Vision follows the model, not the instance. One OpenRouter key reaches models
that read images and models that cannot, so the attachment button refuses per
model: `google/gemini-3.6-flash` accepts a screenshot, `deepseek/deepseek-v4-flash`
tells you to switch models.

This is deliberate. Providers on this path generally replace image input with
placeholder text rather than rejecting it, which means a pasted screenshot would
otherwise produce a confident answer about an image the model never saw.

## What does not work

**apply_patch and server-side web search.** Both are OpenAI-shaped tools, and
OpenRouter routes one slug to whichever backend has capacity, so a tool that
works on one request can be absent on the next. Toolport Studio declares neither
and Codex falls back to its shell-based editing, which works everywhere.

**Subagents.** The Codex harness does not delegate to subagents the way Claude
does, so the Agents panel stays empty on this provider.

## Troubleshooting

**"OpenRouter needs an API key."** The `OPENROUTER_API_KEY` variable is missing
from this instance. Add it under Environment variables on the instance card, not
as a system environment variable.

**"OpenRouter rejected the API key."** The key reached OpenRouter and was
refused. Create a new one at [openrouter.ai/keys](https://openrouter.ai/keys).

**Turns fail with a credits error.** OpenRouter caps `max_tokens` by your
remaining balance, and Codex does not ask for a small budget, so it asks for the
model's full output window. On a nearly empty account every paid model fails
with a 402 naming the shortfall even though the key is valid. Add credits at
[openrouter.ai/settings/credits](https://openrouter.ai/settings/credits); the
free seed model works meanwhile.

**A model answers once, then the turn dies with "stream disconnected before
completion".** The first request succeeded and the follow-up carrying the tool
output did not. Switch models before changing anything else, and prefer a slug
with several backends.

A slug on OpenRouter is a route, not a server. Most paid models are served by
many interchangeable backends — `deepseek/deepseek-v4-flash` has 20,
`anthropic/claude-sonnet-5` has 8 — and OpenRouter fails over between them
without telling you. Every `:free` slug is pinned to exactly one donated
backend. When that single machine drops a stream there is nothing to fail over
to, so the harness's reconnect attempts all land on the box that just failed.

You can check a model's backends before trusting it:

```bash
curl -s https://openrouter.ai/api/v1/models/<vendor>/<model>/endpoints
```

**"Rate limit exceeded: free-models-per-day."** Free models share a per-account
daily cap (50 requests without credits). Agent turns spend several requests
each, so this arrives quickly. It resets at midnight UTC.

**Only the seed models appear.** The catalog fetch failed and the instance fell
back to its seeds. Usually a network or proxy problem; the models you added
return on the next start that reaches OpenRouter.

## A note on the Responses API

OpenRouter's Responses API, which this integration uses, is a **beta** and
stateless: it rejects any request carrying server-side conversation state.
Toolport Studio's generated config keeps Codex on the stateless path, so this is
handled, but the endpoint's behavior can change under you in a way a stable API
would not. If turns start failing for a model that used to work, it is worth
checking whether the model is the problem before assuming the setup is.

## Where the configuration lives

Toolport Studio generates a private Codex home per instance, under the server
state directory in `byok/<instance-id>/`. It contains a `config.toml` pointing at
OpenRouter, a `models.json` describing the resolved models, and a
`catalog-cache.json` holding the last catalog fetch.

All of these are regenerated when the instance starts, so edits to them do not
survive. Change the instance in Settings instead.
