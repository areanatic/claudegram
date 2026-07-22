export const STANDARD_DEFAULT_BOT_TOOLS = [
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Task',
] as const;

/**
 * Built-ins that this SDK version exposes and NexusGram already knows how to
 * render. Interactive CLI-only controls (AskUserQuestion, plan-mode toggles)
 * stay out because Telegram has no SDK permission/question bridge for them.
 */
export const MASTER_DEFAULT_BOT_TOOLS = [
  ...STANDARD_DEFAULT_BOT_TOOLS,
  'WebFetch',
  'WebSearch',
  'NotebookEdit',
  'TodoWrite',
  'Skill',
] as const;

export function resolveBotTools(input: {
  configuredTools: readonly string[];
  explicitlyConfigured: boolean;
  botRole?: 'master' | 'person';
  botName: string;
}): string[] {
  const isMaster = input.botRole === 'master' ||
    (input.botRole === undefined && input.botName === 'Nexusgram');
  const selected = isMaster && !input.explicitlyConfigured
    ? MASTER_DEFAULT_BOT_TOOLS
    : input.configuredTools;
  return [...new Set(selected)];
}
