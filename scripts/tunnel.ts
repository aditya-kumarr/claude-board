/**
 * Runs the board behind a named Cloudflare Tunnel.
 *
 * A named tunnel is the whole point: the hostname is a stable CNAME into Cloudflare, so the
 * iPad and the Android tablet keep working when DHCP moves this machine's LAN address or the
 * ISP rotates the public one. Nothing here opens a port — `cloudflared` dials out.
 *
 * The tunnel is NOT the security boundary. It terminates on a public hostname, and the only
 * thing keeping the internet out is the Cloudflare Access policy in front of it. This script
 * refuses to start until it can confirm that policy exists (see --skip-access-check).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const CONFIG_DIR = join(REPO_ROOT, "cloudflared");
const CONFIG_PATH = join(CONFIG_DIR, "config.generated.yml");

const HOSTNAME = process.env.TUNNEL_HOSTNAME?.trim();
const TUNNEL_NAME = process.env.TUNNEL_NAME?.trim() || "board-local";
const PORT = Number(process.env.PORT ?? 4000);
const SKIP_ACCESS_CHECK = process.argv.includes("--skip-access-check");

/** stderr only — stdout stays clean for anything that pipes this script. */
const say = (message: string) => process.stderr.write(`${message}\n`);

function die(message: string): never {
  say(`\n✗ ${message}\n`);
  process.exit(1);
}

function cf(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("cloudflared", args, { encoding: "utf8" });
  if (result.error) die(`could not run cloudflared: ${result.error.message}`);
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

if (!HOSTNAME) {
  die(
    "TUNNEL_HOSTNAME is not set.\n" +
      "  Add it to .env, using a subdomain of a zone already in your Cloudflare account:\n\n" +
      "      TUNNEL_HOSTNAME=board.yourdomain.com\n",
  );
}
if (!existsSync(join(homedir(), ".cloudflared", "cert.pem"))) {
  die("cloudflared is not logged in. Run `cloudflared tunnel login` first.");
}

// --- resolve or create the tunnel -------------------------------------------------------

type TunnelRecord = { id: string; name: string };

const listed = cf(["tunnel", "list", "--output", "json"]);
if (!listed.ok) die(`\`cloudflared tunnel list\` failed:\n${listed.stderr.trim()}`);

let tunnels: TunnelRecord[] = [];
try {
  tunnels = JSON.parse(listed.stdout) as TunnelRecord[];
} catch {
  die(`could not parse the tunnel list as JSON:\n${listed.stdout.slice(0, 400)}`);
}

let tunnel = tunnels.find((candidate) => candidate.name === TUNNEL_NAME);
if (!tunnel) {
  say(`· creating tunnel "${TUNNEL_NAME}"`);
  const created = cf(["tunnel", "create", TUNNEL_NAME]);
  if (!created.ok) die(`could not create the tunnel:\n${created.stderr.trim()}`);
  const refreshed = cf(["tunnel", "list", "--output", "json"]);
  tunnel = (JSON.parse(refreshed.stdout) as TunnelRecord[]).find((c) => c.name === TUNNEL_NAME);
  if (!tunnel) die(`created "${TUNNEL_NAME}" but it is not in the tunnel list`);
}

const credentialsFile = join(homedir(), ".cloudflared", `${tunnel.id}.json`);
if (!existsSync(credentialsFile)) {
  die(
    `tunnel "${TUNNEL_NAME}" (${tunnel.id}) exists in Cloudflare but its credentials file is\n` +
      `  missing locally at ${credentialsFile}.\n` +
      "  It was probably created on another machine. Either copy that file here, or set\n" +
      "  TUNNEL_NAME to a new name so this script creates a fresh tunnel.",
  );
}

// --- point the hostname at it -----------------------------------------------------------

// Idempotent in practice: a matching CNAME makes this a no-op, and a conflicting record is
// reported rather than clobbered, because silently repointing someone's DNS is not our call.
const routed = cf(["tunnel", "route", "dns", TUNNEL_NAME, HOSTNAME]);
if (!routed.ok) {
  const detail = routed.stderr.trim();
  if (/already exists|record with that host/i.test(detail)) {
    say(`· DNS record for ${HOSTNAME} already exists — leaving it as is`);
    say(`  (if it points somewhere else, run: cloudflared tunnel route dns --overwrite-dns ${TUNNEL_NAME} ${HOSTNAME})`);
  } else {
    die(`could not route ${HOSTNAME} to the tunnel:\n${detail}`);
  }
} else {
  say(`· ${HOSTNAME} → ${TUNNEL_NAME}`);
}

// --- the Access gate --------------------------------------------------------------------

if (!SKIP_ACCESS_CHECK) {
  const guarded = spawnSync(
    "curl",
    ["-sS", "-o", "/dev/null", "-w", "%{http_code} %{redirect_url}", "-m", "10", `https://${HOSTNAME}/api/health`],
    { encoding: "utf8" },
  );
  const response = (guarded.stdout ?? "").trim();
  const behindAccess = /cloudflareaccess\.com/.test(response) || response.startsWith("302");

  if (!behindAccess) {
    die(
      `${HOSTNAME} does not look like it is behind Cloudflare Access.\n` +
        `  Probe returned: ${response || "(no response)"}\n\n` +
        "  Without an Access policy this hostname is reachable by anyone on the internet.\n" +
        "  In the Zero Trust dashboard → Access → Applications, add a self-hosted app:\n\n" +
        `      domain : ${HOSTNAME}\n` +
        "      policy : Allow · Include · Emails · <your email>\n\n" +
        "  Then re-run. To start anyway (only if you have gated it another way):\n\n" +
        "      bun run tunnel --skip-access-check\n",
    );
  }
  say("· Cloudflare Access is in front of the hostname");
}

// --- run --------------------------------------------------------------------------------

mkdirSync(CONFIG_DIR, { recursive: true });
writeFileSync(
  CONFIG_PATH,
  [
    "# Generated by scripts/tunnel.ts — edit .env, not this file.",
    `tunnel: ${TUNNEL_NAME}`,
    `credentials-file: ${credentialsFile}`,
    "",
    "ingress:",
    `  - hostname: ${HOSTNAME}`,
    // One origin: Express serves the API and the built SPA, so there is nothing else to route.
    `    service: http://127.0.0.1:${PORT}`,
    "  - service: http_status:404",
    "",
  ].join("\n"),
);

say(`· config ${CONFIG_PATH}`);
say(`\n  https://${HOSTNAME}  →  127.0.0.1:${PORT}\n`);

const child = spawn("cloudflared", ["tunnel", "--config", CONFIG_PATH, "run", TUNNEL_NAME], {
  stdio: ["ignore", "inherit", "inherit"],
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code) => process.exit(code ?? 0));
