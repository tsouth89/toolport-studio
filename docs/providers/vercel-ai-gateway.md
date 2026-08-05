# Vercel AI Gateway

Vercel AI Gateway is one API key that reaches models from Anthropic, OpenAI,
Google, DeepSeek, xAI and others, with spend controls and bring-your-own-key
routing managed on Vercel's side. In Toolport Studio it runs through the **API
Key Provider** driver, the same one DeepSeek and OpenRouter use.

If you are choosing between this and [OpenRouter](openrouter.md): they cover
much the same ground. Vercel is the better fit if you already run on Vercel and
want gateway spend in the same place as the rest of your bill. OpenRouter
exposes richer per-model metadata, which in this app shows up as more models
having a working reasoning-effort control.

## Setup

1. Create an API key in your Vercel dashboard under AI Gateway.
2. In Settings, go to Providers and click **Add provider instance**.
3. Choose **Vercel AI Gateway**, give it a label, and save.
4. On the new instance card, under **Environment variables**, add:

   ```text
   Name:      AI_GATEWAY_API_KEY
   Value:     your key
   Sensitive: on
   ```

Leave **Binary path** empty.

Sensitive values are kept in the server's secret store, not in `settings.json`,
and are never written into the generated provider config.

The instance is ready when its card reads **Authenticated · Vercel AI Gateway
API Key**.

## Models

The model list is fetched from the gateway rather than shipped with the app. A
fresh instance starts with a seed lineup covering the major vendors; use
**Browse models** on the instance card to search the full catalog and add what
you want. Models that cannot call tools are filtered out, because a coding
session is tool calls end to end.

Note that slugs are **not portable between gateways**. Vercel writes
`xai/grok-4.5` and `zai/glm-5.2` where OpenRouter writes `x-ai/grok-4.5` and
`z-ai/glm-5.2`. Copying a slug from one provider's docs into the other produces
a model that never appears.

## Reasoning effort

This is the one place the gateway is measurably poorer than OpenRouter today.

Vercel describes reasoning per model as a set of options, and most models offer
only an on/off `toggle` — no named levels. Only the minority that publish an
`effort` option (with values like `low`, `medium`, `high`) get a working effort
picker in Toolport Studio. Everything else shows no effort control at all,
which is deliberate: showing a picker that the gateway ignores is worse than
showing none.

Where a model does publish levels, Vercel does not say which is its default, so
Toolport Studio selects the middle one. An unasked-for default should not be
the most expensive level a model offers.

## Images

Vision follows the model, not the instance, exactly as on OpenRouter: one key
reaches models that read images and models that cannot, so the attachment
button refuses per model.

## What does not work

**apply_patch and server-side web search.** Both are OpenAI-shaped tools, and a
gateway routes one slug to whichever backend it chooses, so a tool that works on
one request can be absent on the next. Toolport Studio declares neither and
Codex falls back to its shell-based editing, which works everywhere.

**Subagents.** The Codex harness does not delegate to subagents the way Claude
does, so the Agents panel stays empty on this provider.

## A caveat worth knowing

Toolport Studio talks to this gateway over the **Responses API**, at
`https://ai-gateway.vercel.sh/v1/responses`. Vercel's published API reference
documents only Chat Completions and does not mention that route.

It is real — it answers a malformed request with a 400 exactly as the
documented endpoints do, where an unrouted path answers 404 — and it has to be,
because Codex removed support for the older `chat` wire format. But an
undocumented endpoint carries no compatibility promise. If turns start failing
against this provider after previously working, this is the first thing to
suspect, and [OpenRouter](openrouter.md) is the closest equivalent to fall back
to.

## Troubleshooting

**"Vercel AI Gateway needs an API key."** The `AI_GATEWAY_API_KEY` variable is
missing from this instance. Add it under Environment variables on the instance
card, not as a system environment variable.

**"Vercel AI Gateway rejected the API key."** The key reached Vercel and was
refused. Create a new one in the dashboard.

**Only the seed models appear.** The catalog fetch failed and the instance fell
back to its seeds. Usually a network or proxy problem; models you added return
on the next start that reaches the gateway.

## Where the configuration lives

Toolport Studio generates a private Codex home per instance, under the server
state directory in `byok/<instance-id>/`, containing a `config.toml`, a
`models.json` of the resolved models, and a `catalog-cache.json`. All are
regenerated when the instance starts, so edits do not survive. Change the
instance in Settings instead.
