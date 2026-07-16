import { Context } from 'grammy';
export { fmtTokens, getProgressBar } from './post-agent.js';
export declare function handleMessage(ctx: Context): Promise<void>;
/**
 * Handle reply to /plan, /explore, /loop ForceReply prompts AND direct
 * command-argument invocations (Stage 2b Action 4: command.handler.ts
 * `handlePlan`/`handleExplore`/`handleLoop` now delegate here so the
 * RequestContext state-machine is the single agent-call entry-point for
 * /plan, /explore, /loop. DRY-er than maintaining 4 near-identical bodies.
 */
export declare function handleAgentReply(ctx: Context, sessionKey: string, input: string, mode: 'plan' | 'explore' | 'loop'): Promise<void>;
//# sourceMappingURL=message.handler.d.ts.map