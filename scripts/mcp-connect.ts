/**
 * Prints how to give a Claude Code session in another project this ONE board.
 *
 *   bun run mcp:connect "Lyfpath bugs"            # print the command and the .mcp.json entry
 *   bun run mcp:connect brd_6kryny3r --name lyfpath
 *   bun run mcp:connect "Lyfpath bugs" --add      # run `claude mcp add` in the board's project
 *   bun run mcp:connect "Lyfpath bugs" --json     # the config as JSON, for ~/.zsh/board.zsh
 *
 * The server it registers is this repo's own MCP server started with
 * AUTOMATION_BOARD set, which confines every tool to that board (see
 * packages/mcp/src/scope.ts). `--add` registers it at `local` scope — stored in
 * your ~/.claude.json against that directory, nothing written into the repo — and
 * only in the directory of the project the board is pointed at, so it cannot land
 * in the wrong checkout. Without a project on the board, run the printed command
 * yourself from wherever the work happens.
 */
// Relative, not "@automation/core": scripts/ sits outside the bun workspace.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { boardMcpConfig, getDb, resolveBoardRef } from "../packages/core/src/index.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const ref = args.find((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--name");
const say = (line = "") => process.stdout.write(`${line}\n`);

if (!ref) {
  process.stderr.write('usage: bun run mcp:connect <board id or name> [--name <server>] [--add]\n');
  process.exit(2);
}

getDb();
let config;
try {
  config = boardMcpConfig(resolveBoardRef(ref).id, { serverName: flag("--name") });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

// Machine-readable, so a shell helper resolves the board the same way the app does
// instead of carrying its own copy of the name matching.
if (args.includes("--json")) {
  say(JSON.stringify(config));
  process.exit(0);
}

say();
say(`  Board   : ${config.boardName} (${config.boardId})`);
say(`  Project : ${config.projectPath ?? "(none set on the board — run the command from the project you mean)"}`);
say(`  Server  : ${config.serverName}  →  tools appear as mcp__${config.serverName}__…, confined to this board`);
say();
say("  From inside the project:");
say();
say(`    ${config.command}`);
say();
say("  Or commit it in the project's .mcp.json (the paths are absolute to this machine):");
say();
say(JSON.stringify(config.mcpJson, null, 2).replace(/^/gm, "    "));
say();

if (args.includes("--add")) {
  if (!config.projectPath) {
    process.stderr.write("--add needs the board to point at a project (set one in the board's ⋯ menu); run the command above yourself instead.\n");
    process.exit(1);
  }
  if (!existsSync(config.projectPath)) {
    process.stderr.write(`the board's project directory ${config.projectPath} no longer exists.\n`);
    process.exit(1);
  }
  const env = Object.entries(config.mcpJson.mcpServers[config.serverName]!.env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  const entry = config.mcpJson.mcpServers[config.serverName]!;
  const result = spawnSync("claude", ["mcp", "add", config.serverName, ...env, "--", entry.command, ...entry.args], {
    cwd: config.projectPath,
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}
