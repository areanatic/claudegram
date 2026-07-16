/**
 * Terminal-style rendering for Telegram messages.
 * Provides emoji icons, spinners, and progress indicators for a terminal-like experience.
 */
export declare const TOOL_ICONS: Record<string, string>;
export declare const SPINNER_FRAMES: string[];
export declare const DOTS_SPINNER: string[];
export declare const ANIMATION_VARIANTS: {
    lightning: {
        spinner: string[];
        emoji: string;
        defaultText: string;
        speed: number;
    };
    brain: {
        spinner: string[];
        emoji: string;
        defaultText: string;
        speed: number;
    };
    reload: {
        spinner: string[];
        emoji: string;
        defaultText: string;
        speed: number;
    };
    robot: {
        spinner: string[];
        emoji: string;
        defaultText: string;
        speed: number;
    };
    stars: {
        spinner: string[];
        emoji: string;
        defaultText: string;
        speed: number;
    };
    default: {
        spinner: string[];
        emoji: string;
        defaultText: string;
        speed: number;
    };
};
export declare const CURRENT_ANIMATION: {
    text: string;
    speed: number;
    spinner: string[];
    emoji: string;
    defaultText: string;
} | {
    text: string;
    speed: number;
    spinner: string[];
    emoji: string;
    defaultText: string;
} | {
    text: string;
    speed: number;
    spinner: string[];
    emoji: string;
    defaultText: string;
} | {
    text: string;
    speed: number;
    spinner: string[];
    emoji: string;
    defaultText: string;
} | {
    text: string;
    speed: number;
    spinner: string[];
    emoji: string;
    defaultText: string;
} | {
    text: string;
    speed: number;
    spinner: string[];
    emoji: string;
    defaultText: string;
};
export declare const PROGRESS: {
    empty: string;
    filled: string;
    partial: string;
};
/**
 * Get icon for a tool name
 */
export declare function getToolIcon(toolName: string): string;
/**
 * Get current spinner frame based on index
 */
export declare function getSpinnerFrame(index: number): string;
/**
 * Get animation emoji
 */
export declare function getAnimationEmoji(): string;
/**
 * Get animation text
 */
export declare function getAnimationText(): string;
/**
 * Get animation speed in ms
 */
export declare function getAnimationSpeed(): number;
/**
 * Render a status line showing current operation
 * Example: "⠹ 📖 Reading src/config.ts..."
 */
export declare function renderStatusLine(spinnerIndex: number, icon: string, operation: string, detail?: string): string;
/**
 * Render a progress bar
 * Example: "[████████░░░░] 67%"
 */
export declare function renderProgressBar(percent: number, width?: number): string;
/**
 * Render a tool operation status
 * Example: "📖 Read → src/config.ts"
 */
export declare function renderToolOperation(toolName: string, detail?: string): string;
/**
 * Extract a meaningful detail from tool input for display
 */
export declare function extractToolDetail(toolName: string, input: Record<string, unknown>): string | undefined;
/**
 * Render a background task status line
 * Example: "📋 Background: Installing dependencies ✅"
 */
export declare function renderBackgroundTask(name: string, status: 'running' | 'complete' | 'error', spinnerIndex?: number): string;
/**
 * Format a terminal-style message with optional status and background tasks
 */
export declare function formatTerminalMessage(content: string, options?: {
    spinnerIndex?: number;
    currentOperation?: {
        icon: string;
        name: string;
        detail?: string;
    };
    backgroundTasks?: Array<{
        name: string;
        status: 'running' | 'complete' | 'error';
    }>;
    isComplete?: boolean;
}): string;
//# sourceMappingURL=terminal-renderer.d.ts.map