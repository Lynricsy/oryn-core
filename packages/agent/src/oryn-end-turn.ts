/**
 * Oryn: tool results that end the turn.
 *
 * A generative-UI view (`render_ui` / `render_html`) the model marked `endTurn`
 * comes back with `details.orynEndTurn: true`. Once the tool batch carrying such
 * a successful result has finished, the loop stops before the next model call,
 * exactly as if the model had ended its turn: the remaining calls of the batch
 * still run, the turn ends normally (no aborted assistant message), and queued
 * steering / follow-ups are handled as at any other stop.
 */
export function isOrynEndTurnToolResult(result: { isError?: boolean; details?: unknown }): boolean {
	if (result.isError) return false;
	const details = result.details;
	return typeof details === "object" && details !== null && "orynEndTurn" in details && details.orynEndTurn === true;
}
