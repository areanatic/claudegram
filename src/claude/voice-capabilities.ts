/**
 * Build an honesty guard from the tools that are actually offered to a voice
 * turn. Voice mode narrows some generic tools for latency/safety, but it does
 * not remove every tool and it does not remove connected MCP domain tools.
 */
export function buildVoiceCapabilityPrompt(allowedGenericTools: readonly string[]): string {
  const tools = [...new Set(allowedGenericTools)].sort();
  const genericToolTruth = tools.length > 0
    ? tools.join(', ')
    : 'none';

  return `

Voice capability truth for THIS turn:
- Generic tools currently available: ${genericToolTruth}.
- Connected MCP domain tools shown in your tool context remain available in voice mode.
- Voice mode changes response style and narrows selected generic tools; it does NOT mean "no tools".
- Never claim that voice mode cannot read/search files when Read, Glob, or Grep appears in the available list. Use the available tool.
- If a required tool is genuinely absent, name that exact missing capability. Do not generalize the limitation to all tools or all file access.`;
}

const PERSON_VOICE_DROP = new Set(['Task', 'Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * The Master is Arash's CLI-equivalent lane: a voice turn must receive the
 * same generic tool set as a text turn. Person bots intentionally retain the
 * narrower policy that prevents open-ended shell/write escalation by voice.
 */
export function effectiveToolsForVoice(
  configuredTools: readonly string[],
  disallowedTools: readonly string[],
  masterLane: boolean,
): string[] {
  return configuredTools.filter((tool) =>
    !disallowedTools.includes(tool) && (masterLane || !PERSON_VOICE_DROP.has(tool)),
  );
}

/** Full Master parity includes the same generic tool budget as text turns. */
export function toolBudgetForVoice(masterLane: boolean, voiceBudget: number, textBudget: number): number {
  return masterLane ? textBudget : voiceBudget;
}
