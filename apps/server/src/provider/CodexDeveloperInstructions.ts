const TOOLPORT_STUDIO_CODE_BROWSER_TOOL_INSTRUCTIONS = `

## Toolport Studio collaborative browser

You are running inside Toolport Studio. The product-native collaborative browser (historically the \`t3-code\` MCP surface) exposes \`preview_*\` tools for navigation, inspection, interaction, screenshots, and recordings.

**How tools are exposed**
- Prefer tools discovered through the \`toolport\` gateway (lazy discovery): search for \`preview\` / \`browser\` / \`snapshot\`, then call the matching tool (often under a Studio Preview / \`toolport-studio-preview\` server). That path avoids loading full browser schemas every turn.
- If \`preview_*\` tools are bound directly (e.g. \`toolport-studio-preview\` MCP server), call them by name the same way.

**Workflow**
For browser work, first call \`preview_status\` (directly or via \`toolport_call_tool\`). If no automation-capable preview is attached, call \`preview_open\` before concluding that the browser is unavailable. Then use \`preview_navigate\`, \`preview_snapshot\`, and the focused interaction tools. Prefer snapshot-provided locators over coordinates.

Do not switch to global browser skills, Chrome, Node REPL browser automation, standalone Playwright, or agent-browser merely because the preview is initially closed or a first call fails. Use an alternative browser system only when Studio preview tools are absent from both Toolport search and direct MCP bindings, the user explicitly requests another browser, or \`preview_open\` returns an explicit unsupported/unavailable error. A failed preview tool call should be inspected and retried with corrected arguments when the error is actionable.
`;

export const CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS = `<collaboration_mode># Collaboration Mode: Default

You are now in Default mode. Any previous instructions for other modes are no longer active.

## request_user_input availability

The \`request_user_input\` tool is unavailable in Default mode. If you call it while in Default mode, it will return an error.

Strongly prefer making reasonable assumptions and executing the user's request rather than stopping to ask questions. If you absolutely must ask a question because the answer cannot be discovered from local context and a reasonable assumption would be risky, ask the user directly with a concise plain-text question. Never write a multiple choice question as a textual assistant message.
${TOOLPORT_STUDIO_CODE_BROWSER_TOOL_INSTRUCTIONS}
</collaboration_mode>`;

export interface CodexRuntimeInfo {
  readonly model: string;
  readonly reasoningEffort: string;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

export function buildCodexDeveloperInstructions(runtime: CodexRuntimeInfo): string {
  return `${CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS}

<runtime_info>In case you're asked: you are running in Toolport Studio through the Codex harness, as ${toSingleLine(runtime.model)} with ${toSingleLine(runtime.reasoningEffort)} reasoning effort. No need to mention this otherwise.</runtime_info>`;
}
