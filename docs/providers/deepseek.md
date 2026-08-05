# DeepSeek (and other API-key providers)

This guide is for people who want to use a third-party model provider with their
own API key, instead of a subscription-backed CLI.

DeepSeek is the first one supported. It runs through the **API Key Provider**
driver, which configures the Codex harness to talk to a provider other than
OpenAI. You do not need a DeepSeek app, and you do not need to edit any config
files.

## Setup

1. Create an API key at [platform.deepseek.com](https://platform.deepseek.com/api_keys).
2. In Settings, go to Providers and click **Add provider instance**.
3. Choose the **API Key Provider** driver.
4. Give it a label (for example `DeepSeek`) and save.
5. On the new instance card, under **Environment variables**, add:

   ```text
   Name:      DEEPSEEK_API_KEY
   Value:     your key
   Sensitive: on
   ```

Leave **Provider** set to DeepSeek and **Binary path** empty.

Sensitive values are kept in the server's secret store, not in `settings.json`,
and are never written into the generated provider config.

The instance is ready when its card reads **Authenticated · DeepSeek API Key**.

## Models

| Model             | Reasoning levels | Context |
| ----------------- | ---------------- | ------- |
| DeepSeek-V4-Flash | Low, High, Max   | 1M      |

V4-Pro is not listed yet. DeepSeek's Codex integration does not support it on
the Responses API, and an unrecognized model name is silently answered by Flash
rather than rejected, so offering Pro would mean paying attention to a choice
that quietly does nothing. It returns when DeepSeek ships it.

Reasoning effort is a per-turn choice next to the model name, the same as any
other provider.

## What does not work

**Images.** DeepSeek V4 has no vision through the API, so Toolport Studio
refuses image attachments on this provider. This is deliberate: DeepSeek's
endpoint replaces image input with placeholder text rather than rejecting it,
which means a pasted screenshot would produce a confident answer about an image
the model never received. A clear refusal beats a wrong answer.

**Subagents.** The Codex harness does not delegate to subagents the way Claude
does, so the Agents panel stays empty on this provider.

## Troubleshooting

**"DeepSeek needs an API key."** The `DEEPSEEK_API_KEY` variable is missing from
this instance. Add it under Environment variables on the instance card, not as a
system environment variable.

**"DeepSeek rejected the API key."** The key reached DeepSeek and was refused.
It is usually revoked, mistyped, or from a different account. Create a new one.

**"Could not reach DeepSeek to verify the API key."** A network or proxy
problem, not a key problem. Turns may still work.

## Checking what you are actually being charged for

The model cannot reliably tell you which model it is; it only repeats what the
harness told it, and DeepSeek silently falls back to Flash for a model name it
does not recognize. Two reliable checks:

- The usage dashboard at platform.deepseek.com shows which model was billed.
- Every provider instance keeps a Codex log database under its generated home.
  Its `response.completed` events record the exact request parameters and token
  usage, including reasoning tokens, which is the only way to confirm a
  reasoning-effort setting is doing anything.

## Where the configuration lives

Toolport Studio generates a private Codex home per instance, under the server
state directory in `byok/<instance-id>/`. It contains a `config.toml` pointing
at the provider and a `models.json` describing its models.

Both files are regenerated every time the instance starts, so edits to them do
not survive. Change the instance in Settings instead.

## Other providers

The driver is built around presets, so adding a provider is a data change
rather than new code. [OpenRouter](openrouter.md) and [Vercel AI
Gateway](vercel-ai-gateway.md) are the others supported today, and each reaches
most of these vendors through a single key.

Providers that publish an Anthropic-compatible endpoint (Z.ai, Moonshot,
MiniMax, Qwen) need the Claude harness instead of the Codex one, which is not
wired up yet.
