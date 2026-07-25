# Product foundation

## The idea

Toolport Studio is a provider-neutral desktop for working with AI. It should feel
as approachable as Claude Desktop for a new conversation and as capable as a
coding workspace once a task touches a repository.

The defining promise is continuity: the user should not have to decide whether
something is “chat” or “coding” before they know what the conversation will
become.

## One surface, progressive context

Chat and coding are states of the same conversation, not separate sections.

| State              | Context                                                      | Interface                                      |
| ------------------ | ------------------------------------------------------------ | ---------------------------------------------- |
| Conversation       | Provider, model, messages, attachments, Toolport tools       | Composer and conversation                      |
| Workspace attached | Folder or repository plus conversation context               | Files, search, source control                  |
| Build session      | Active terminal, preview, diff, approvals, or task execution | Coding controls appear around the conversation |

A projectless conversation can attach a workspace later. A workspace conversation
can detach from coding chrome when the user only wants to ask a question. History
and provider state stay with the conversation.

## Navigation principles

- **New conversation is the primary action.** It must be obvious and available
  without creating a project first.
- **Projects organize context, not access.** A folder is optional until a task
  needs filesystem or source-control access.
- **Provider and model are explicit.** The current provider, recommended model,
  authentication health, and remaining usage should be easy to understand.
- **Advanced surfaces are contextual.** Terminals, diffs, previews, and git
  controls appear when they are useful instead of defining a separate product
  area.
- **Attachments are first-class.** Screenshots, files, pasted text, and captured
  UI context should work consistently across providers.

## Ecosystem boundaries

- **Toolport Studio** owns conversations, provider sessions, projects, and the
  desktop experience.
- **Toolport** owns MCP server discovery, configuration, policy, and shared tool
  access.
- **Ceiling** owns usage collection, quota intelligence, reset windows, and cost
  visibility.

Studio should consume those products through stable interfaces rather than copy
their internal implementations.

## Roadmap

### Foundation

- Projectless conversation start
- Clear new-conversation action
- Provider health and authentication recovery
- Recommended models and complete model catalog
- Consistent image and file attachments
- Toolport MCP session injection

### Daily-driver desktop

- Attach or change a workspace from an existing conversation
- Conversation templates and recent prompts
- Provider-aware capabilities and graceful fallbacks
- Unified usage panel powered by Ceiling
- Search across conversations and projects
- Reliable auto-update and signed installers

### Provider-neutral workspace

- Move or branch a conversation between compatible providers
- Shared Toolport tool permissions and audit trail
- Multiple workspaces and remote environments
- Portable session exports
- Optional team policy and collaboration surfaces

## Decisions to avoid too early

- Separate top-level Chat and Coding products
- A universal abstraction that hides meaningful provider differences
- Reimplementing Toolport's MCP control plane inside Studio
- Reimplementing Ceiling's collectors inside the desktop
- Renaming every inherited internal identifier before a migration boundary exists
