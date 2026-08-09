import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe } from "vite-plus/test";
import { DEFAULT_MODEL, ThreadId, TurnId } from "@toolport-studio/contracts";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";

import {
  buildCodexDeveloperInstructions,
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
} from "../CodexDeveloperInstructions.ts";
import { codexSessionAppServerArgs } from "./codexLaunchArgs.ts";
import {
  buildCodexTurnInput,
  buildTurnStartParams,
  canSteerCodexSendTurn,
  hasConfiguredMcpServer,
  isCodexTurnNotSteerable,
  isCodexTurnStalled,
  isolateCodexNotificationFailure,
  isRecoverableThreadResumeError,
  openCodexThread,
} from "./CodexSessionRuntime.ts";
const isCodexAppServerRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);

describe("CodexSessionRuntimeIdentifierGenerationError", () => {
  it("retains identifier purpose and the random source failure", () => {
    const cause = new Error("random source unavailable");
    const error = new CodexErrors.CodexAppServerIdentifierGenerationError({
      purpose: "provider-event",
      cause,
    });

    NodeAssert.equal(error.purpose, "provider-event");
    NodeAssert.strictEqual(error.cause, cause);
    NodeAssert.equal(
      error.message,
      "Failed to generate Codex App Server identifier for provider-event.",
    );
  });
});

function makeThreadOpenResponse(
  threadId: string,
): CodexRpc.ClientRequestResponsesByMethod["thread/start"] {
  return {
    cwd: "/tmp/project",
    model: "gpt-5.3-codex",
    modelProvider: "openai",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "danger-full-access" },
    thread: {
      id: threadId,
      createdAt: "2026-04-18T00:00:00.000Z",
      source: { session: "cli" },
      turns: [],
      status: {
        state: "idle",
        activeFlags: [],
      },
    },
  } as unknown as CodexRpc.ClientRequestResponsesByMethod["thread/start"];
}

describe("buildTurnStartParams", () => {
  it.effect("grants a workspace-write turn only its thread attachment directory", () =>
    Effect.gen(function* () {
      const attachmentDirectory = "C:\\state\\attachments\\thread-1";
      const params = yield* buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto",
        prompt: "Read the attachment",
        attachmentDirectory,
      });

      NodeAssert.deepStrictEqual(params.sandboxPolicy, {
        type: "workspaceWrite",
        writableRoots: [attachmentDirectory],
      });
    }),
  );

  it("keeps invalid turn values only in the schema cause", () => {
    const secret = "codex-turn-input-secret-sentinel";
    const error = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        attachments: [
          {
            type: "image",
            url: { secret } as unknown as string,
          },
        ],
      }).pipe(Effect.flip),
    );
    const { cause, ...directDiagnostics } = error;

    NodeAssert.equal(error.operation, "decode-request-payload");
    NodeAssert.equal(error.method, "turn/start");
    NodeAssert.ok((error.issueCount ?? 0) > 0);
    NodeAssert.ok(error.issueKinds?.includes("Pointer"));
    NodeAssert.ok((error.maximumPathDepth ?? 0) > 0);
    NodeAssert.ok(Schema.isSchemaError(cause));
    NodeAssert.doesNotMatch(error.message, new RegExp(secret));
    NodeAssert.doesNotMatch(JSON.stringify(directDiagnostics), new RegExp(secret));
  });

  it("includes default collaboration mode and image attachments", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto-accept-edits",
        prompt: "Implement it",
        model: "gpt-5.3-codex",
        attachments: [
          {
            type: "image",
            url: "data:image/png;base64,abc",
          },
        ],
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "workspaceWrite",
      },
      input: [
        {
          type: "text",
          text: "Implement it",
        },
        {
          type: "image",
          url: "data:image/png;base64,abc",
        },
      ],
      model: "gpt-5.3-codex",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: buildCodexDeveloperInstructions({
            model: "gpt-5.3-codex",
            reasoningEffort: "medium",
          }),
        },
      },
    });
  });

  it("reports the same fallback model and effort in settings and instructions", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Go",
      }),
    );

    const settings = params.collaborationMode?.settings;
    NodeAssert.equal(settings?.model, DEFAULT_MODEL);
    NodeAssert.equal(settings?.reasoning_effort, "medium");
    NodeAssert.ok(settings?.developer_instructions?.includes(`as ${DEFAULT_MODEL} with medium`));
  });

  it.effect("routes approvals to the auto reviewer in auto mode", () =>
    Effect.gen(function* () {
      const params = yield* buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto",
        prompt: "Ship it",
      });

      NodeAssert.deepStrictEqual(params, {
        threadId: "provider-thread-1",
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandboxPolicy: {
          type: "workspaceWrite",
        },
        input: [
          {
            type: "text",
            text: "Ship it",
          },
        ],
        collaborationMode: {
          mode: "default",
          settings: {
            model: DEFAULT_MODEL,
            reasoning_effort: "medium",
            developer_instructions: buildCodexDeveloperInstructions({
              model: DEFAULT_MODEL,
              reasoningEffort: "medium",
            }),
          },
        },
      });
    }),
  );

  it("always includes the default collaboration mode", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "approval-required",
        prompt: "Review",
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "readOnly",
      },
      input: [
        {
          type: "text",
          text: "Review",
        },
      ],
      collaborationMode: {
        mode: "default",
        settings: {
          model: DEFAULT_MODEL,
          reasoning_effort: "medium",
          developer_instructions: buildCodexDeveloperInstructions({
            model: DEFAULT_MODEL,
            reasoningEffort: "medium",
          }),
        },
      },
    });
  });
});

describe("buildCodexDeveloperInstructions", () => {
  it("appends runtime info after the mode instructions", () => {
    const instructions = buildCodexDeveloperInstructions({
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
    });

    NodeAssert.ok(instructions.startsWith(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS));
    NodeAssert.match(instructions, /Toolport Studio/);
    NodeAssert.match(instructions, /Codex harness/);
    NodeAssert.match(instructions, /as gpt-5\.3-codex with high reasoning effort/);
  });

  it("varies with the model and effort of each turn", () => {
    const first = buildCodexDeveloperInstructions({
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
    });
    const second = buildCodexDeveloperInstructions({
      model: "gpt-5.4",
      reasoningEffort: "high",
    });

    NodeAssert.notEqual(first, second);
  });

  it("flattens multiline metadata into single-line runtime info", () => {
    const instructions = buildCodexDeveloperInstructions({
      model: "gpt\n5.3\ncodex",
      reasoningEffort: " high\neffort ",
    });

    NodeAssert.match(instructions, /as gpt 5\.3 codex with high effort reasoning effort/);
    NodeAssert.doesNotMatch(instructions, /<runtime_info>[^<]*\n/);
  });
});

describe("T3 browser developer instructions", () => {
  it("prefers the product-native preview tools", () => {
    NodeAssert.match(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS, /t3-code/);
    NodeAssert.match(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS, /preview_status/);
    NodeAssert.match(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS, /preview_open/);
    NodeAssert.match(
      CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
      /Do not switch to global browser skills/,
    );
  });
});

describe("hasConfiguredMcpServer", () => {
  it("detects inline Codex MCP configuration arguments", () => {
    NodeAssert.equal(hasConfiguredMcpServer(undefined), false);
    NodeAssert.equal(hasConfiguredMcpServer(["--model", "gpt-5.4"]), false);
    NodeAssert.equal(
      hasConfiguredMcpServer(["-c", 'mcp_servers.t3-code.url="http://127.0.0.1/mcp"']),
      true,
    );
  });
});

describe("codexSessionAppServerArgs", () => {
  it("keeps the app-server subcommand when explicit args are provided", () => {
    NodeAssert.deepStrictEqual(codexSessionAppServerArgs(["-c", "model=gpt-5"], undefined), [
      "app-server",
      "-c",
      "model=gpt-5",
    ]);
  });

  it("keeps launch args when explicit app-server args are provided", () => {
    NodeAssert.deepStrictEqual(
      codexSessionAppServerArgs(
        ["-c", "mcp_servers.t3-code.url=http://127.0.0.1/mcp"],
        "--strict-config --enable foo",
      ),
      [
        "app-server",
        "--strict-config",
        "--enable",
        "foo",
        "-c",
        "mcp_servers.t3-code.url=http://127.0.0.1/mcp",
      ],
    );
  });
});

describe("isRecoverableThreadResumeError", () => {
  it("matches missing thread errors", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Thread does not exist",
        }),
      ),
      true,
    );
  });

  it("ignores non-recoverable resume errors", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Permission denied",
        }),
      ),
      false,
    );
  });

  it("ignores unrelated missing-resource errors that do not mention threads", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Config file not found",
        }),
      ),
      false,
    );
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Model does not exist",
        }),
      ),
      false,
    );
  });
});

describe("openCodexThread", () => {
  it.effect("falls back to thread/start when resume fails recoverably", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: "thread/start" | "thread/resume"; payload: unknown }> = [];
      const started = makeThreadOpenResponse("fresh-thread");
      const client = {
        request: <M extends "thread/start" | "thread/resume">(
          method: M,
          payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          calls.push({ method, payload });
          if (method === "thread/resume") {
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "thread not found",
              }),
            );
          }
          return Effect.succeed(started as CodexRpc.ClientRequestResponsesByMethod[M]);
        },
      };

      const opened = yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "stale-thread",
      });

      NodeAssert.equal(opened.response.thread.id, "fresh-thread");
      NodeAssert.equal(opened.resumedExistingThread, false);
      NodeAssert.deepStrictEqual(
        calls.map((call) => call.method),
        ["thread/resume", "thread/start"],
      );
    }),
  );

  it.effect("marks successful resume so Studio rehydration stays disarmed", () =>
    Effect.gen(function* () {
      const resumed = makeThreadOpenResponse("resumed-thread");
      const client = {
        request: <M extends "thread/start" | "thread/resume">(
          method: M,
          _payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          if (method === "thread/resume") {
            return Effect.succeed(resumed as CodexRpc.ClientRequestResponsesByMethod[M]);
          }
          return Effect.fail(
            new CodexErrors.CodexAppServerRequestError({
              code: -32603,
              errorMessage: "should not start fresh",
            }),
          );
        },
      };

      const opened = yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "resumed-thread",
      });

      NodeAssert.equal(opened.response.thread.id, "resumed-thread");
      NodeAssert.equal(opened.resumedExistingThread, true);
    }),
  );

  it.effect("propagates non-recoverable resume failures", () =>
    Effect.gen(function* () {
      const client = {
        request: <M extends "thread/start" | "thread/resume">(
          method: M,
          _payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          if (method === "thread/resume") {
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "timed out waiting for server",
              }),
            );
          }
          return Effect.succeed(
            makeThreadOpenResponse("fresh-thread") as CodexRpc.ClientRequestResponsesByMethod[M],
          );
        },
      };

      const error = yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "stale-thread",
      }).pipe(Effect.flip);

      NodeAssert.ok(isCodexAppServerRequestError(error));
      NodeAssert.equal(error.errorMessage, "timed out waiting for server");
    }),
  );
});

describe("canSteerCodexSendTurn", () => {
  it("steers into the live turn while one is running", () => {
    NodeAssert.equal(
      canSteerCodexSendTurn({ status: "running", activeTurnId: TurnId.make("turn-1") }),
      "turn-1",
    );
  });

  it("opens a new turn when the session is idle", () => {
    NodeAssert.equal(
      canSteerCodexSendTurn({ status: "ready", activeTurnId: TurnId.make("turn-1") }),
      undefined,
    );
  });

  it("opens a new turn when running without a tracked turn id", () => {
    NodeAssert.equal(
      canSteerCodexSendTurn({ status: "running", activeTurnId: undefined }),
      undefined,
    );
  });

  it("opens a new turn rather than steering into a stalled one", () => {
    // Steering into a turn the app-server has abandoned swallowed the message.
    NodeAssert.equal(
      canSteerCodexSendTurn({
        status: "running",
        activeTurnId: TurnId.make("turn-1"),
        turnStalled: true,
      }),
      undefined,
    );
  });
});

describe("isCodexTurnStalled", () => {
  const stallTimeoutMs = 90_000;

  it("is never stalled without a running turn", () => {
    NodeAssert.equal(
      isCodexTurnStalled({
        turnStartedAtMs: undefined,
        lastNotificationAtMs: 0,
        nowMs: 10 * stallTimeoutMs,
        stallTimeoutMs,
      }),
      false,
    );
  });

  it("is not stalled while the turn is still young", () => {
    NodeAssert.equal(
      isCodexTurnStalled({
        turnStartedAtMs: 1_000,
        lastNotificationAtMs: undefined,
        nowMs: 1_000 + stallTimeoutMs - 1,
        stallTimeoutMs,
      }),
      false,
    );
  });

  it("is stalled once a turn that never emitted ages out", () => {
    NodeAssert.equal(
      isCodexTurnStalled({
        turnStartedAtMs: 1_000,
        lastNotificationAtMs: undefined,
        nowMs: 1_000 + stallTimeoutMs,
        stallTimeoutMs,
      }),
      true,
    );
  });

  it("stays alive while the app-server keeps talking", () => {
    NodeAssert.equal(
      isCodexTurnStalled({
        turnStartedAtMs: 1_000,
        lastNotificationAtMs: 1_000 + stallTimeoutMs,
        nowMs: 1_000 + stallTimeoutMs + 1,
        stallTimeoutMs,
      }),
      false,
    );
  });

  it("ignores chatter that predates the turn", () => {
    NodeAssert.equal(
      isCodexTurnStalled({
        turnStartedAtMs: 500_000,
        lastNotificationAtMs: 1_000,
        nowMs: 500_000 + stallTimeoutMs,
        stallTimeoutMs,
      }),
      true,
    );
  });
});

describe("isCodexTurnNotSteerable", () => {
  it("recognizes the app-server same-turn steering rejection", () => {
    NodeAssert.equal(
      isCodexTurnNotSteerable(
        new Error("the current active turn cannot accept same-turn steering"),
      ),
      true,
    );
  });

  it("recognizes an expectedTurnId precondition failure", () => {
    NodeAssert.equal(isCodexTurnNotSteerable(new Error("expectedTurnId did not match")), true);
  });

  it("does not treat a transport failure as unsteerable", () => {
    NodeAssert.equal(isCodexTurnNotSteerable(new Error("socket hang up")), false);
  });
});

describe("buildCodexTurnInput", () => {
  it("puts prompt text first, then attachments", () => {
    NodeAssert.deepStrictEqual(
      buildCodexTurnInput({
        prompt: "hello",
        attachments: [{ type: "image", url: "data:image/png;base64,AAA" }],
      }),
      [
        { type: "text", text: "hello" },
        { type: "image", url: "data:image/png;base64,AAA" },
      ],
    );
  });

  it("omits empty prompt text", () => {
    NodeAssert.deepStrictEqual(buildCodexTurnInput({}), []);
  });
});

describe("isolateCodexNotificationFailure", () => {
  it.effect("keeps draining after one notification fails", () =>
    Effect.gen(function* () {
      // The consumer ran bare, so the first failure ended the fiber and every
      // later notification vanished. That is what a codex turn that accepts
      // work and then says nothing looks like from the outside.
      const handled: Array<string> = [];
      const failures: Array<string> = [];
      const isolated = isolateCodexNotificationFailure(
        (notification: { readonly method: string }) =>
          notification.method === "thread/settings/updated"
            ? Effect.fail({ _tag: "NotificationProjectionError" } as const)
            : Effect.sync(() => {
                handled.push(notification.method);
              }),
        (notification) =>
          Effect.sync(() => {
            failures.push(notification.method);
          }),
      );

      for (const method of [
        "thread/started",
        "thread/settings/updated",
        "turn/started",
        "item/agentMessage/delta",
        "turn/completed",
      ]) {
        yield* isolated({ method });
      }

      NodeAssert.deepStrictEqual(handled, [
        "thread/started",
        "turn/started",
        "item/agentMessage/delta",
        "turn/completed",
      ]);
      NodeAssert.deepStrictEqual(failures, ["thread/settings/updated"]);
    }),
  );

  it.effect("survives a defect, not just a typed failure", () =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const isolated = isolateCodexNotificationFailure(
        (notification: { readonly method: string }) =>
          notification.method === "bad"
            ? Effect.sync(() => {
                throw new TypeError("cannot read properties of undefined");
              })
            : Effect.sync(() => {
                handled.push(notification.method);
              }),
        () => Effect.void,
      );

      yield* isolated({ method: "bad" });
      yield* isolated({ method: "turn/completed" });

      NodeAssert.deepStrictEqual(handled, ["turn/completed"]);
    }),
  );
});
