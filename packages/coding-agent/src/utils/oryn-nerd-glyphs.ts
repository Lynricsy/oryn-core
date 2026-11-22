/**
 * Oryn: an RPC host declaring that it draws session titles with a Nerd Font.
 *
 * Card titles under `title.icons: nf+emoji` only use the Nerd Fonts glyph in
 * the TUI with the nerd symbol preset; any other host gets the emoji, because
 * omp cannot see which font the host draws the title in. Oryn's web client
 * ships Symbols Nerd Font, so orbd starts its thread agents with
 * `ORYN_NERD_GLYPHS=1` to keep the glyph. The TUI ignores the flag and keeps
 * following its symbol preset.
 */
import { $flag } from "@oh-my-pi/pi-utils/env";

/** The environment flag an RPC host sets when it renders Nerd Fonts glyphs. */
export const ORYN_NERD_GLYPHS_ENV = "ORYN_NERD_GLYPHS";

/** Whether the (non-interactive) host declared that it renders Nerd Fonts glyphs. */
export function orynHostRendersNerdGlyphs(): boolean {
	return $flag(ORYN_NERD_GLYPHS_ENV);
}
