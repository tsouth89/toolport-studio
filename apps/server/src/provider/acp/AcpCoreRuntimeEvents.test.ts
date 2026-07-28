import { ProviderDriverKind, RuntimeRequestId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpTokenUsageUpdatedEvent,
  makeAcpToolCallEvent,
} from "./AcpCoreRuntimeEvents.ts";

describe("AcpCoreRuntimeEvents", () => {
  it("maps ACP permission requests to canonical runtime events", () => {
    const stamp = { eventId: "event-1" as never, createdAt: "2026-03-27T00:00:00.000Z" };
    const turnId = TurnId.make("turn-1");
    const permissionRequest = {
      kind: "execute" as const,
      detail: "cat package.json",
      toolCall: {
        toolCallId: "tool-1",
        kind: "execute",
        status: "pending" as const,
        command: "cat package.json",
        detail: "cat package.json",
        data: { toolCallId: "tool-1", kind: "execute" },
      },
    };

    expect(
      makeAcpRequestOpenedEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId,
        requestId: RuntimeRequestId.make("request-1"),
        permissionRequest,
        detail: "cat package.json",
        args: { command: ["cat", "package.json"] },
        source: "acp.jsonrpc",
        method: "session/request_permission",
        rawPayload: { sessionId: "session-1" },
      }),
    ).toMatchObject({
      type: "request.opened",
      payload: {
        requestType: "exec_command_approval",
        detail: "cat package.json",
      },
    });

    expect(
      makeAcpRequestResolvedEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId,
        requestId: RuntimeRequestId.make("request-1"),
        permissionRequest,
        decision: "accept",
      }),
    ).toMatchObject({
      type: "request.resolved",
      payload: {
        requestType: "exec_command_approval",
        decision: "accept",
      },
    });
  });

  it("maps ACP core plan, tool-call, and content updates", () => {
    const stamp = { eventId: "event-1" as never, createdAt: "2026-03-27T00:00:00.000Z" };
    const turnId = TurnId.make("turn-1");

    expect(
      makeAcpPlanUpdatedEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId,
        payload: {
          plan: [{ step: "Inspect state", status: "inProgress" }],
        },
        source: "acp.cursor.extension",
        method: "cursor/update_todos",
        rawPayload: { todos: [] },
      }),
    ).toMatchObject({
      type: "turn.plan.updated",
      raw: {
        method: "cursor/update_todos",
      },
    });

    expect(
      makeAcpToolCallEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId,
        toolCall: {
          toolCallId: "tool-1",
          kind: "execute",
          status: "completed",
          title: "Terminal",
          detail: "bun run test",
          data: { command: "bun run test" },
        },
        rawPayload: { sessionId: "session-1" },
      }),
    ).toMatchObject({
      type: "item.completed",
      payload: {
        itemType: "command_execution",
        status: "completed",
        title: "Terminal",
        data: {
          command: "bun run test",
          toolCallId: "tool-1",
          kind: "execute",
        },
      },
    });

    // Untitled ACP tools (common from Grok) must not land as bare "Tool call".
    expect(
      makeAcpToolCallEvent({
        stamp,
        provider: ProviderDriverKind.make("grok"),
        threadId: "thread-1" as never,
        turnId,
        toolCall: {
          toolCallId: "tool-untitled",
          kind: "read",
          status: "inProgress",
          data: {},
        },
        rawPayload: { sessionId: "session-1" },
      }),
    ).toMatchObject({
      type: "item.updated",
      payload: {
        title: "Reading files",
        data: {
          toolCallId: "tool-untitled",
          kind: "read",
        },
      },
    });

    expect(
      makeAcpContentDeltaEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId,
        itemId: "assistant:session-1:segment:0",
        text: "hello",
        rawPayload: { sessionId: "session-1" },
      }),
    ).toMatchObject({
      type: "content.delta",
      itemId: "assistant:session-1:segment:0",
      payload: {
        streamKind: "assistant_text",
        delta: "hello",
      },
    });

    expect(
      makeAcpContentDeltaEvent({
        stamp,
        provider: ProviderDriverKind.make("grok"),
        threadId: "thread-1" as never,
        turnId,
        text: "Considering next tool",
        streamKind: "reasoning_text",
        rawPayload: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "Considering next tool" },
        },
      }),
    ).toMatchObject({
      type: "content.delta",
      payload: {
        streamKind: "reasoning_text",
        delta: "Considering next tool",
      },
    });

    expect(
      makeAcpAssistantItemEvent({
        stamp,
        provider: ProviderDriverKind.make("cursor"),
        threadId: "thread-1" as never,
        turnId,
        itemId: "assistant:session-1:segment:0",
        lifecycle: "item.started",
      }),
    ).toMatchObject({
      type: "item.started",
      itemId: "assistant:session-1:segment:0",
      payload: {
        itemType: "assistant_message",
        status: "inProgress",
      },
    });

    expect(
      makeAcpTokenUsageUpdatedEvent({
        stamp,
        provider: ProviderDriverKind.make("grok"),
        threadId: "thread-1" as never,
        turnId,
        usedTokens: 31_251,
        maxTokens: 200_000,
        rawPayload: {
          sessionUpdate: "usage_update",
          size: 200_000,
          used: 31_251,
        },
      }),
    ).toMatchObject({
      type: "thread.token-usage.updated",
      payload: {
        usage: {
          usedTokens: 31_251,
          maxTokens: 200_000,
          lastUsedTokens: 31_251,
        },
      },
    });

    expect(
      makeAcpTokenUsageUpdatedEvent({
        stamp,
        provider: ProviderDriverKind.make("grok"),
        threadId: "thread-1" as never,
        turnId,
        usedTokens: 0,
        maxTokens: 200_000,
        rawPayload: { sessionUpdate: "usage_update", size: 200_000, used: 0 },
      }),
    ).toBeNull();
  });
});
