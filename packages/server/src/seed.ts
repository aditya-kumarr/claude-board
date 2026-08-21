/**
 * Creates a small, realistic board so the UI has something to show on a fresh
 * database. Safe to re-run: it skips when a board of the same name exists.
 */
import { createBoard, createLogger, createTask, getDb, listBoards, moveTask, addComment, type ActorContext } from "@automation/core";

const log = createLogger("seed");
const me: ActorContext = { actorId: "me", source: "system" };
const claude: ActorContext = { actorId: "claude", source: "system" };

const NAME = "This week";
getDb();

if (listBoards({ includeArchived: true }).some((b) => b.board.name === NAME)) {
  log.info("seed skipped, board already present", { name: NAME });
  process.exit(0);
}

const { board } = createBoard(
  { name: NAME, durationKind: "week", description: "Everything here has to land before the week closes." },
  me,
);

const design = createTask(board.id, {
  title: "Sketch the board layout",
  description: "Columns, card density, what the header shows about the deadline.",
  assignee: "me",
  priority: "high",
}, me);

createTask(board.id, {
  title: "Write the MCP tool descriptions",
  description: "Each tool needs a description precise enough to pick correctly without a second call.",
  assignee: "claude",
  priority: "urgent",
}, me);

const logging = createTask(board.id, {
  title: "Weekly log rotation",
  description: "One file per ISO week under logs/.",
  assignee: "claude",
  priority: "medium",
}, claude);

createTask(board.id, { title: "Decide on drag-and-drop library", assignee: "me", priority: "low" }, me);

moveTask(design.id, { column: "doing" }, me);
moveTask(logging.id, { column: "done" }, claude);
addComment(logging.id, "Rotates on the ISO week boundary, verified across a year-end roll.", claude);

log.info("seed complete", { boardId: board.id });
