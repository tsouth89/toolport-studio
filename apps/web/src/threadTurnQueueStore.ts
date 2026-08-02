export function resolveComposerSubmitIntent(input: {
  readonly phase: "disconnected" | "connecting" | "ready" | "running";
  readonly ctrlOrMetaKey: boolean;
  readonly explicitIntent?: "auto" | "queue" | "steer" | "force";
}): "queue" | "steer" | "send" {
  if (input.explicitIntent === "force") {
    return "send";
  }
  if (input.explicitIntent === "steer") {
    return "steer";
  }
  if (input.explicitIntent === "queue") {
    return "queue";
  }
  if (input.phase === "running") {
    return input.ctrlOrMetaKey ? "steer" : "queue";
  }
  return "send";
}
