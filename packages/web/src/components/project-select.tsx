import { FolderGit2 } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Hint } from "@/components/ui/tooltip";
import type { Project } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * A card's project is an *override* of its board's, not an independent field, so
 * the picker has to be able to say three different things: this card follows the
 * board, this card is somewhere else, or nothing is set anywhere. Radix cannot
 * carry `null` as a value, hence the two sentinels.
 */
export const INHERIT_PROJECT = "__inherit__";
export const NO_PROJECT = "__none__";

/** Shortest name for a directory that still says which one it is. */
export const shortPath = (path: string): string => path.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");

export function ProjectSelect({
  projects,
  value,
  onChange,
  /** The board's project, when this picker is for a card that can inherit it. */
  inheritFrom,
  ariaLabel = "Project",
}: {
  projects: Project[];
  /** `null` means "inherit" when `inheritFrom` is given, and "none" when it is not. */
  value: string | null;
  onChange: (projectId: string | null) => void;
  inheritFrom?: Project | null;
  ariaLabel?: string;
}) {
  const inheritable = inheritFrom !== undefined;
  const fallback = inheritable ? INHERIT_PROJECT : NO_PROJECT;
  // Every registered project is offered: there is no hidden state a project can be
  // in, and a card can only point at one that exists — deleting a project deletes
  // the cards that named it rather than leaving them holding a stale id.
  const options = projects;

  return (
    <Select value={value ?? fallback} onValueChange={(next) => onChange(next === fallback ? null : next)}>
      <SelectTrigger aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={fallback}>
          <span className="inline-flex items-center gap-2 text-muted-foreground">
            <FolderGit2 className="size-3.5" />
            {inheritable
              ? inheritFrom
                ? `Board default — ${inheritFrom.name}`
                : "Board default — none set"
              : "No project"}
          </span>
        </SelectItem>
        {options.map((project) => (
          <SelectItem key={project.id} value={project.id}>
            <span className="inline-flex items-center gap-2">
              <FolderGit2 className="size-3.5 text-primary" />
              {project.name}
              <span className="font-mono text-[10px] text-muted-foreground">{shortPath(project.path)}</span>
            </span>
          </SelectItem>
        ))}
        {options.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            No projects registered yet — add one from the sidebar.
          </p>
        ) : null}
      </SelectContent>
    </Select>
  );
}

/**
 * The project as a chip. Carries the path in a tooltip rather than on the face of
 * it: which directory matters when you are checking, and the name is enough when
 * you are scanning.
 */
export function ProjectChip({
  project,
  via,
  className,
}: {
  project: Pick<Project, "name" | "path">;
  /** Marks a card that has been pointed somewhere other than its board. */
  via?: "task" | "board";
  className?: string;
}) {
  return (
    <Hint
      label={`${project.path}${via === "task" ? " — set on this card, overriding the board" : via === "board" ? " — the board's default" : ""}`}
    >
      <span
        className={cn(
          "inline-flex max-w-40 items-center gap-1 truncate rounded-full px-1.5 py-px ring-1 ring-inset",
          className,
        )}
        style={{
          color: "var(--kind-review)",
          backgroundColor: "color-mix(in oklab, var(--kind-review) 12%, transparent)",
          // @ts-expect-error CSS custom property for the ring color
          "--tw-ring-color": "color-mix(in oklab, var(--kind-review) 30%, transparent)",
        }}
      >
        <FolderGit2 className="size-2.5 shrink-0" />
        <span className="truncate">{project.name}</span>
      </span>
    </Hint>
  );
}
