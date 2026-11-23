/**
 * Oryn: names Core writes at the top of a session artifacts dir besides subagent outputs.
 *
 * Subagents write `<id>.jsonl` / `<id>.md` there and nest their children under `<id>/`, so a subagent
 * named after a sidecar shares its file or directory, and a transcript scan that walks every `.jsonl`
 * picks sidecar data up as agent transcripts. Owners (literals kept in their upstream files):
 * - `changes.jsonl`, `blobs/`: selective-commit change journal (`commit/selective/journal.ts`)
 * - `local/`: `local://` root (`internal-urls/local-root.ts`)
 * - `url-search/`: materialized URL reads (`tools/fetch.ts`)
 * - `btw-history/`: BTW history (`session/btw-history.ts`)
 * - `annotation-drafts/`: `/annotate` drafts (`extensibility/custom-commands/bundled/annotate/draft-store.ts`)
 */
import { readSessionHeaderId } from "./session-loader";

/** Change journal file name; also the path a subagent named `changes` used before it was reserved. */
const COMMIT_JOURNAL_FILE = "changes.jsonl";

const SIDECAR_NAMES = ["changes", "blobs", "local", "url-search", "btw-history", "annotation-drafts"];

/** Sidecar directories: any `.jsonl` inside is user or fetched data, never a transcript. */
const SIDECAR_DIRS: ReadonlySet<string> = new Set(SIDECAR_NAMES.filter(name => name !== "changes"));

/**
 * Stems a subagent id may not take (the advisor stem is reserved upstream), lower-cased: matched
 * case-insensitively because case-folding filesystems (macOS, Windows) treat `Changes.jsonl` and
 * `changes.jsonl` as one file.
 */
const RESERVED_STEMS: ReadonlySet<string> = new Set(SIDECAR_NAMES);

/** Whether `AgentOutputManager` must skip `id` because another writer owns `<id>.jsonl` or `<id>/`. */
export function isReservedArtifactStem(id: string): boolean {
	return RESERVED_STEMS.has(id.toLowerCase());
}

/** Whether a transcript scan should descend into the directory `name`. */
export function isSidecarDir(name: string): boolean {
	return SIDECAR_DIRS.has(name);
}

/**
 * Whether `file` (named `name`) is the change journal rather than a transcript. A subagent named
 * `changes` before the allocator reserved the stem shares the journal's path; its file opens with a
 * session header (after the optional title slot), the journal's with a change record.
 */
export async function isCommitJournal(name: string, file: string): Promise<boolean> {
	return name === COMMIT_JOURNAL_FILE && (await readSessionHeaderId(file)) === undefined;
}
