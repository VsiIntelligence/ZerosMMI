/** The reasoning level, saved with the signed-in account (so it follows them to every device and never leaks to another account). */
import type { ReasoningLevelName } from "@/lib/zeros";
import { readSettings, writeSettings } from "@/lib/settings-bridge";

export const REASONING_LEVELS: ReasoningLevelName[] = ["fast", "medium", "complex"];

export function getReasoningLevel(): ReasoningLevelName {
  return readSettings().reasoning;
}

export function setReasoningLevel(level: ReasoningLevelName): void {
  writeSettings({ reasoning: level });
}
