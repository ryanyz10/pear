export async function readStdinJson<T extends Record<string, unknown>>(): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return {} as T; // fail open on malformed stdin — treat as an empty/unknown event
  }
}

export function writeJson(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj));
}

export function resolveCwd(body: Record<string, unknown>): string {
  if (typeof body.cwd === "string") return body.cwd;
  if (Array.isArray(body.workspace_roots) && typeof body.workspace_roots[0] === "string") {
    return body.workspace_roots[0];
  }
  if (typeof body.directory === "string") return body.directory;
  return process.cwd();
}

export function resolveCallId(body: Record<string, unknown>): string {
  return String(body.tool_use_id ?? body.tool_call_id ?? body.callId ?? Date.now());
}

export function resolveToolName(body: Record<string, unknown>): string {
  return String(body.tool_name ?? body.toolName ?? "");
}

export function resolveToolInput(body: Record<string, unknown>): Record<string, unknown> {
  const raw = body.tool_input ?? body.toolInput ?? body.input ?? {};
  return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
}

export function isMutatingTool(name: string): boolean {
  const n = name.toLowerCase();
  return n === "write" || n === "edit" || n === "bash" || n === "shell";
}
