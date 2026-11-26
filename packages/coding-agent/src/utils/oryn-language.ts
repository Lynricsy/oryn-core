/**
 * Oryn: user-configured global language for generated titles and tool call intents.
 *
 * Oryn's control plane passes the owner's global language to thread and coordinator
 * agents via `ORYN_LANGUAGE` (e.g. `zh-CN`, `en`). When unset or blank, all helpers
 * are strict no-ops so upstream TUI/RPC behavior stays byte-for-byte unchanged.
 */
import { $env } from "@oh-my-pi/pi-utils/env";

/** Environment variable carrying the user's configured language (BCP 47 tag or name). */
export const ORYN_LANGUAGE_ENV = "ORYN_LANGUAGE";

const DEFAULT_INTENT_GUIDANCE =
	'capitalized 2–6-word present-participle intent (e.g. "Reading model role settings").';
const DEFAULT_INTENT_DESCRIPTION = "concise intent";
const TITLE_REQUEST_CLOSE = "</title-request>";

/**
 * Resolve `ORYN_LANGUAGE` to a clear English language name for LLM prompts,
 * or `undefined` when unset / blank / unsafe (contains control characters).
 */
export function orynUserLanguage(raw: string | undefined = $env[ORYN_LANGUAGE_ENV]): string | undefined {
	if (!raw) return undefined;
	const trimmed = raw.trim();
	if (!trimmed || /[\r\n\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
	const lower = trimmed.toLowerCase();
	if (lower === "zh" || lower === "zh-cn" || lower === "zh-sg" || lower.startsWith("zh-hans")) {
		return "Simplified Chinese";
	}
	if (lower === "zh-tw" || lower === "zh-hk" || lower === "zh-mo" || lower.startsWith("zh-hant")) {
		return "Traditional Chinese";
	}
	if (lower === "en" || lower.startsWith("en-")) {
		return "English";
	}
	return trimmed;
}

/** Append the user-language rule to a session title generation system prompt. */
export function withOrynTitleLanguage(basePrompt: string, raw?: string): string {
	const lang = orynUserLanguage(raw);
	if (!lang) return basePrompt;
	return `${basePrompt.trimEnd()}\n- Write the title in ${lang}.`;
}

/** Append the user-language rule to a subagent task-label generation system prompt. */
export function withOrynTaskLabelLanguage(basePrompt: string, raw?: string): string {
	const lang = orynUserLanguage(raw);
	if (!lang) return basePrompt;
	return `${basePrompt.trimEnd()}\n- Write the label in ${lang}.`;
}

/**
 * Inject the user-language rule into a rendered `title-fork.md` prompt.
 * Keeps `nf`, `emoji`, and `code` attributes in English/ASCII so card parsing stays intact.
 */
export function withOrynTitleForkLanguage(rendered: string, raw?: string): string {
	const lang = orynUserLanguage(raw);
	if (!lang) return rendered;
	const line = `- Write the title in ${lang} (keep nf, emoji, and code in English/ASCII as specified above).`;
	const closeIdx = rendered.lastIndexOf(TITLE_REQUEST_CLOSE);
	if (closeIdx >= 0) {
		const before = rendered.slice(0, closeIdx).trimEnd();
		const after = rendered.slice(closeIdx);
		return `${before}\n${line}\n${after}`;
	}
	return `${rendered.trimEnd()}\n${line}`;
}

/**
 * Append the user-language requirement to the tool-call intent guidance line
 * in `system-prompt.md`. Returns `baseGuidance` unchanged when `ORYN_LANGUAGE` is unset.
 */
export function orynIntentGuidance(baseGuidance: string, raw?: string): string {
	const lang = orynUserLanguage(raw);
	if (!lang) return baseGuidance;
	const base = baseGuidance.trim() || DEFAULT_INTENT_GUIDANCE;
	return `${base} Write the intent in ${lang}.`;
}

/**
 * Render an intent-language instruction for custom `--system-prompt` sessions
 * (such as Oryn's coordinator/assistant host) when intent tracing and `ORYN_LANGUAGE`
 * are both active; returns `""` otherwise so upstream custom prompts are untouched.
 */
export function orynCustomPromptIntentGuidance(intentField: string | undefined, raw?: string): string {
	if (!intentField) return "";
	const lang = orynUserLanguage(raw);
	if (!lang) return "";
	return `- Most tools take \`${intentField}\` (concise 2–6-word intent for this call). Write the intent in ${lang}.`;
}

/**
 * Annotate the wire tool-schema description of `INTENT_FIELD` (`i`) with the user's language.
 * Returns `baseDescription` unchanged when `ORYN_LANGUAGE` is unset.
 */
export function orynIntentDescription(baseDescription?: string, raw?: string): string | undefined {
	const lang = orynUserLanguage(raw);
	if (!lang) return baseDescription;
	const base = baseDescription?.trim() || DEFAULT_INTENT_DESCRIPTION;
	return `${base} (in ${lang})`;
}
