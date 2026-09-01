/**
 * Spawning a headless Claude Code run for work queued on the board.
 *
 * Shared by the mention watcher and the sync watcher because the risky part is
 * identical in both and should only be got right once: what MCP servers the run
 * can see, what tools it may use, and making sure a run that dies is noticed
 * rather than leaving a request stuck.
 *
 * The generated MCP config is the security boundary that matters. The repo's own
 * `.mcp.json` is deliberately NOT used: it carries servers an unattended run
 * triggered by a web form has no business reaching. Each watcher declares the
 * servers it needs and gets nothing else, enforced with `--strict-mcp-config`.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const REPO_ROOT = new URL("../..", import.meta.url).pathname;

/**
 * Which Claude account a spawned run signs in as, or undefined for the CLI default.
 *
 * `CLAUDE_CONFIG_DIR` picks the `.claude.json` the CLI reads, and that file is what
 * carries the account — and therefore which claude.ai connectors exist. Inheriting
 * whatever the launching shell happened to export silently decides whose Outlook a
 * sync reads, which is not a thing a shell profile should get a vote on: a
 * `CLAUDE_CONFIG_DIR` pointing at a second account is indistinguishable from a
 * connector outage, because the run just reports it has no Microsoft 365 tools.
 * So it is pinned here, for the same reason `boardServer()` pins `AUTOMATION_DB_PATH`
 * rather than inheriting it.
 *
 * Undefined means *unset the variable in the child*, which is not the same as setting
 * it to `~`: with it exported the CLI also looks for credentials beside the config
 * file, so pinning the default path by value gets "Not logged in · Please run /login"
 * from an account that is in fact signed in. Only genuine absence restores the default.
 *
 * Set `WATCH_CLAUDE_CONFIG_DIR` to deliberately choose a non-default account.
 */
export const CLAUDE_CONFIG_DIR = process.env.WATCH_CLAUDE_CONFIG_DIR?.trim() || undefined;

/** The config dir a run will actually read, for messages a human reads. */
export const effectiveConfigDir = (): string => CLAUDE_CONFIG_DIR ?? homedir();

/** Child env with the account pinned — the inherited value removed unless one was chosen. */
function runEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = CLAUDE_CONFIG_DIR;
  else delete env.CLAUDE_CONFIG_DIR;
  return env;
}

export interface McpServerSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** The board server, pointed at whatever database this process is reading. */
export function boardServer(): McpServerSpec {
  // Pinned rather than inherited: a spawned server that opens a different file
  // would answer requests against a different board than the one they came from.
  const env: Record<string, string> = { LOG_LEVEL: process.env.LOG_LEVEL ?? "info" };
  if (process.env.AUTOMATION_DB_PATH) env.AUTOMATION_DB_PATH = process.env.AUTOMATION_DB_PATH;
  if (process.env.AUTOMATION_LOG_DIR) env.AUTOMATION_LOG_DIR = process.env.AUTOMATION_LOG_DIR;
  return { command: "bun", args: ["run", join(REPO_ROOT, "packages/mcp/src/index.ts")], env };
}

/** Writes a config holding exactly `servers` and returns its path. */
export function writeMcpConfig(fileName: string, servers: Record<string, McpServerSpec>): string {
  const path = join(REPO_ROOT, "data", fileName);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
  return path;
}

export interface RunOptions {
  prompt: string;
  mcpConfig: string;
  allowedTools: string;
  timeoutMs: number;
  bin?: string;
  model?: string;
  extraArgs?: string[];
  /**
   * Directory the run starts in. Defaults to this repository.
   *
   * This is what makes delegating into a project work at all: Claude Code reads
   * the CLAUDE.md and the files of wherever it was started, so pointing it at the
   * checkout a card is about gives the run that codebase's context — and only
   * that codebase's. The generated MCP config is passed as an absolute path and
   * the board server is pinned to an absolute entrypoint, so neither follows the
   * working directory anywhere.
   */
  cwd?: string;
  /**
   * Whether the run may see *only* `mcpConfig` (`--strict-mcp-config`).
   *
   * Defaults to true, which is the right answer whenever the generated config is
   * self-sufficient. Pass false when the run needs a server this script cannot
   * declare — notably an account-level claude.ai connector, whose credentials
   * live with the user's session and cannot be written into a config file. The
   * generated config is still merged in, so a pinned board server keeps pointing
   * at the right database; the tool allowlist becomes the real boundary.
   */
  strictMcpConfig?: boolean;
}

export interface RunResult {
  ok: boolean;
  /** Claude's final message, or the reason there is not one. */
  summary: string;
  seconds: number;
}

/**
 * Kill functions for runs currently in flight.
 *
 * Needed because `detached: true` puts each run in its own process group, so it
 * no longer receives the terminal's Ctrl-C along with the watcher. Without this,
 * stopping a watcher would leave a Claude run — and its MCP servers — reading the
 * user's mail with nobody watching.
 */
const active = new Set<() => void>();

/** Call from a watcher's signal handler before it exits. */
export function killActiveRuns(): void {
  for (const kill of active) kill();
  active.clear();
}

export function runClaude(options: RunOptions): Promise<RunResult> {
  const bin = options.bin?.trim() || "claude";
  const args = [
    "-p",
    options.prompt,
    "--output-format",
    "json",
    "--mcp-config",
    options.mcpConfig,
    ...(options.strictMcpConfig === false ? [] : ["--strict-mcp-config"]),
    "--allowedTools",
    options.allowedTools,
    ...(options.model ? ["--model", options.model] : []),
    ...(options.extraArgs ?? []),
  ];

  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: options.cwd ?? REPO_ROOT,
      // stdin closed: an unattended run must never block waiting on input.
      stdio: ["ignore", "pipe", "pipe"],
      // Pinned, not inherited — see CLAUDE_CONFIG_DIR above.
      env: runEnv(),
      // Its own process group. A Claude run starts MCP servers as grandchildren,
      // and signalling only the run leaves those alive holding its stdout pipe —
      // which is how a 300s timeout took 534s to come back and left orphaned
      // servers behind. The group is what has to be killed.
      detached: true,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

    /** SIGKILL the whole group, falling back to the child if it has no group. */
    const killTree = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };

    active.add(killTree);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, options.timeoutMs);
    timer.unref();

    let settled = false;
    const finish = (result: Omit<RunResult, "seconds">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      active.delete(killTree);
      resolve({ ...result, seconds: Math.round((Date.now() - started) / 1000) });
    };

    child.on("error", (error) => finish({ ok: false, summary: `could not start ${bin}: ${error.message}` }));

    // `exit` fires when the process itself dies; `close` waits for every writer on
    // its stdio, which a surviving grandchild can hold open indefinitely. Report
    // on `exit` and give the pipes a brief grace period to flush.
    child.on("exit", (code, signal) => {
      const report = () => {
        let summary = "";
        try {
          const payload = JSON.parse(stdout) as { result?: unknown };
          if (typeof payload.result === "string") summary = payload.result.trim();
        } catch {
          // Not JSON — a crash or a usage error. The tail of stderr says more.
          summary = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 500);
        }
        const ok = code === 0 && signal === null;
        finish({
          ok,
          summary:
            summary ||
            (timedOut
              ? `no output before the ${Math.round(options.timeoutMs / 1000)}s timeout`
              : ok
                ? "(the run produced no final message)"
                : signal
                  ? `killed by ${signal}`
                  : `exited ${code}`),
        });
      };
      // Make sure nothing outlives the run, then flush.
      killTree();
      setTimeout(report, 250).unref();
    });
  });
}

/** Reads a whitespace-separated env var into CLI args. */
export const argsFromEnv = (value: string | undefined): string[] => (value?.trim() || "").split(/\s+/).filter(Boolean);
