import { useEffect, useState } from "react";
import { Check, Copy, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, ApiError, type BoardMcpConfig } from "@/lib/api";
import type { BoardDetail } from "@/lib/types";

/**
 * How to give a Claude Code session in another project this board — and only
 * this board.
 *
 * The dialog only shows the command, it does not run it: registering an MCP
 * server is a change to the user's Claude Code config for some other directory,
 * which is theirs to make. `bun run mcp:connect <board> --add` exists for doing
 * it from a terminal.
 */
export function ConnectClaudeDialog({
  board,
  open,
  onOpenChange,
}: {
  board: BoardDetail | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [config, setConfig] = useState<BoardMcpConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const boardId = board?.board.id ?? null;

  useEffect(() => {
    if (!open || !boardId) return;
    setConfig(null);
    setError(null);
    api
      .boardMcp(boardId)
      .then(setConfig)
      .catch((reason) => setError(reason instanceof ApiError ? reason.message : "Could not build the config"));
  }, [open, boardId]);

  return (
    <Dialog open={open && board !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Terminal className="size-4" /> Connect Claude Code to this board
          </DialogTitle>
          <DialogDescription>
            A session in your project gets <span className="font-medium text-foreground">{board?.board.name}</span> as
            an MCP server. It can read and work its cards, and nothing on any other board: other boards are refused,
            and creating boards or registering projects is not available to it.
          </DialogDescription>
        </DialogHeader>

        {error ? <p className="text-xs text-destructive">{error}</p> : null}

        {config ? (
          <div className="space-y-4 text-[12.5px]">
            <Block
              label={
                config.projectPath ? (
                  <>
                    Run inside <span className="font-mono text-foreground">{config.projectPath}</span>
                  </>
                ) : (
                  "Run inside the project the work happens in"
                )
              }
              hint="Stored in your own Claude Code config for that directory — nothing is written into the repo."
              text={config.projectPath ? `cd ${config.projectPath} && ${config.command}` : config.command}
            />
            <Block
              label="Or commit it in the project's .mcp.json"
              hint="The paths are absolute to this machine, so this suits a repo only you work in."
              text={JSON.stringify(config.mcpJson, null, 2)}
            />
            <p className="text-[11.5px] text-muted-foreground">
              Tools show up as <span className="font-mono">mcp__{config.serverName}__…</span>. Start a new session in the
              project (or run <span className="font-mono">/mcp</span>) to pick it up.
            </p>
          </div>
        ) : error ? null : (
          <p className="text-xs text-muted-foreground">Building the config…</p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Block({ label, hint, text }: { label: React.ReactNode; hint: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="space-y-1.5">
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-medium">{label}</p>
          <p className="text-[11.5px] text-muted-foreground">{hint}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border/60 bg-surface/60 p-2.5 font-mono text-[11px] leading-relaxed scrollbar-slim">
        {text}
      </pre>
    </section>
  );
}
