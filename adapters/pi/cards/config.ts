/**
 * The settings cards: one for picking a setting, one for changing it.
 *
 * `/pear-config` used to be built out of `ctx.ui.select` directly, which is
 * where the padding went wrong: pi's selector renders each option as a single
 * `Text`, so a label carrying the whole `allowedReadOnlyCommands` list wraps
 * and every continuation line loses the selection marker's indent. Here the
 * long value lives in the card *body*, which already wraps and windows, and
 * every option label stays one line.
 *
 * Both cards are data, like every other card, so the dialog fallback shows the
 * same thing and the content is testable without a terminal.
 */

import {
  CONFIG_KEYS,
  CONFIG_SPECS,
  DEFAULTS,
  MODES,
  formatConfigValue,
  isListKey,
  summariseConfigValue,
  type ConfigKey,
  type PearConfig,
} from "../../../core/config.ts";
import { body, type CardOption, type CardSpec } from "./card.ts";

export type SettingsAnswer = { key: ConfigKey };

/**
 * What one answer on the setting card means.
 *
 * - `value` — already final: a pick, a removal, or a reset. Nothing to parse.
 * - `edit`  — free text, read by `parseConfigEdit` exactly as a typed argument.
 * - `add`   — free text to append to a list, however the human punctuated it.
 */
export type SettingAnswer =
  | { kind: "value"; value: unknown }
  | { kind: "edit"; text: string }
  | { kind: "add"; text: string };

/** The picker: every setting, its current value in one line, and what it does. */
export function settingsCard(config: Required<PearConfig>): CardSpec<SettingsAnswer> {
  const b = body();
  b.muted("Saved in .pear/config.json. Esc closes without changing anything.");

  return {
    title: "pear · settings",
    lines: b.lines,
    options: CONFIG_KEYS.map((key) => ({
      label: `${key} = ${summariseConfigValue(config[key])}`,
      hint: CONFIG_SPECS[key].summary,
      answer: { key },
    })),
    footer: "↑↓ move · Enter choose · Esc close",
  };
}

/**
 * One setting, with its full current value and the ways to change it.
 *
 * A list gets add/remove/replace rather than only replace, because typing the
 * whole list out to drop one entry is how a list gets wiped by accident. Every
 * key gets "reset to default", because until now nothing could write the
 * shipped value back.
 */
export function settingCard(key: ConfigKey, current: unknown): CardSpec<SettingAnswer> {
  const spec = CONFIG_SPECS[key];
  const b = body();
  b.text(spec.summary);
  b.blank();

  const entries = isListKey(key) && Array.isArray(current) ? current.map(String) : null;

  if (entries === null) {
    b.muted(`currently ${formatConfigValue(current)}`);
  } else if (entries.length === 0) {
    b.warn("The list is empty: no command counts as inspection.");
  } else {
    b.muted(`${entries.length} ${entries.length === 1 ? "command" : "commands"}:`);
    for (const entry of entries) b.item(entry);
  }

  b.blank();
  b.dim(`accepts ${spec.describe}`);

  const options: CardOption<SettingAnswer>[] = [];

  if (entries !== null) {
    options.push({
      label: "Add a command",
      hint: "kept alongside everything already on the list",
      editor: {
        prompt: "Command to add (comma-separated for several):",
        answer: (text) => ({ kind: "add", text }),
      },
    });
    options.push({
      label: "Remove a command",
      hint: entries.length === 0 ? "nothing to remove" : "pick one to drop",
      pick: {
        prompt: "Remove which?",
        items: entries,
        // Computed here rather than sent back as `-entry`: an entry containing
        // a comma would not survive the round trip through the parser.
        answer: (item) => ({ kind: "value", value: entries.filter((e) => e !== item) }),
      },
    });
    options.push({
      label: "Replace the whole list",
      hint: "comma-separated; this is the old behaviour",
      editor: {
        prompt: "The complete list:",
        answer: (text) => ({ kind: "edit", text }),
      },
    });
  } else if (key === "mode") {
    for (const mode of MODES) {
      options.push({ label: mode, answer: { kind: "value", value: mode } });
    }
  } else if (typeof DEFAULTS[key] === "boolean") {
    options.push({ label: "true", answer: { kind: "value", value: true } });
    options.push({ label: "false", answer: { kind: "value", value: false } });
  } else {
    options.push({
      label: "Set a value",
      hint: spec.describe,
      editor: {
        prompt: `${key} (${spec.describe}):`,
        answer: (text) => ({ kind: "edit", text }),
      },
    });
  }

  options.push({
    label: "Reset to default",
    hint: summariseConfigValue(DEFAULTS[key]),
    answer: { kind: "value", value: DEFAULTS[key] },
  });

  return {
    title: `pear · ${key}`,
    lines: b.lines,
    options,
    footer: "↑↓ move · Enter choose · Esc back",
  };
}
