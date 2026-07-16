/**
 * Terminal-style rendering for Telegram messages.
 * Provides emoji icons, spinners, and progress indicators for a terminal-like experience.
 */
// Tool icons (emoji-based for mobile friendliness)
export const TOOL_ICONS = {
    // File operations
    Read: '📖',
    Write: '✏️',
    Edit: '🔧',
    // Search and navigation
    Grep: '🔍',
    Glob: '📁',
    // Execution
    Bash: '💻',
    Task: '📋',
    // Web
    WebFetch: '🌐',
    WebSearch: '🔎',
    // Notebook
    NotebookEdit: '📓',
    // Status indicators
    thinking: '💭',
    complete: '✅',
    error: '❌',
    warning: '⚠️',
    info: 'ℹ️',
};
// Spinner frames for animation (Braille pattern spinner)
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
// Alternative spinner (dots)
export const DOTS_SPINNER = ['⠁', '⠂', '⠄', '⡀', '⢀', '⠠', '⠐', '⠈'];
// Animation Variants (configurable via .env ANIMATION_VARIANT)
export const ANIMATION_VARIANTS = {
    lightning: {
        spinner: ['←', '↖', '↑', '↗', '→', '↘', '↓', '↙'],
        emoji: '⚡',
        defaultText: 'Denke nach...',
        speed: 150,
    },
    brain: {
        spinner: ['◐', '◓', '◑', '◒'],
        emoji: '🧠',
        defaultText: 'Prozessiere...',
        speed: 200,
    },
    reload: {
        spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
        emoji: '🔄',
        defaultText: 'Arbeite...',
        speed: 100,
    },
    robot: {
        spinner: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█', '▇', '▆', '▅', '▄', '▃', '▂'],
        emoji: '🤖',
        defaultText: 'Berechne...',
        speed: 120,
    },
    stars: {
        spinner: ['✶', '✸', '✹', '✺', '✹', '✸'],
        emoji: '💫',
        defaultText: 'Moment...',
        speed: 180,
    },
    // Original/default
    default: {
        spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
        emoji: '💭',
        defaultText: 'Processing...',
        speed: 200,
    },
};
// Get current animation config from env
function getAnimationConfig() {
    const variant = process.env.ANIMATION_VARIANT || 'default';
    const config = ANIMATION_VARIANTS[variant] || ANIMATION_VARIANTS.default;
    return {
        ...config,
        text: process.env.ANIMATION_TEXT || config.defaultText,
        speed: parseInt(process.env.ANIMATION_SPEED || String(config.speed)),
    };
}
export const CURRENT_ANIMATION = getAnimationConfig();
// Progress bar characters
export const PROGRESS = {
    empty: '░',
    filled: '█',
    partial: '▓',
};
/**
 * Get icon for a tool name
 */
export function getToolIcon(toolName) {
    return TOOL_ICONS[toolName] || '🔹';
}
/**
 * Get current spinner frame based on index
 */
export function getSpinnerFrame(index) {
    const frames = CURRENT_ANIMATION.spinner;
    return frames[index % frames.length];
}
/**
 * Get animation emoji
 */
export function getAnimationEmoji() {
    return CURRENT_ANIMATION.emoji;
}
/**
 * Get animation text
 */
export function getAnimationText() {
    return CURRENT_ANIMATION.text;
}
/**
 * Get animation speed in ms
 */
export function getAnimationSpeed() {
    return CURRENT_ANIMATION.speed;
}
/**
 * Render a status line showing current operation
 * Example: "⠹ 📖 Reading src/config.ts..."
 */
export function renderStatusLine(spinnerIndex, icon, operation, detail) {
    const spinner = getSpinnerFrame(spinnerIndex);
    const detailStr = detail ? ` ${detail}` : '';
    return `${spinner} ${icon} ${operation}${detailStr}`;
}
/**
 * Render a progress bar
 * Example: "[████████░░░░] 67%"
 */
export function renderProgressBar(percent, width = 12) {
    const clampedPercent = Math.max(0, Math.min(100, percent));
    const filledCount = Math.round((clampedPercent / 100) * width);
    const emptyCount = width - filledCount;
    const filled = PROGRESS.filled.repeat(filledCount);
    const empty = PROGRESS.empty.repeat(emptyCount);
    return `[${filled}${empty}] ${Math.round(clampedPercent)}%`;
}
/**
 * Render a tool operation status
 * Example: "📖 Read → src/config.ts"
 */
export function renderToolOperation(toolName, detail) {
    const icon = getToolIcon(toolName);
    const action = getToolAction(toolName);
    const detailStr = detail ? ` → ${detail}` : '';
    return `${icon} ${action}${detailStr}`;
}
/**
 * Get human-readable action name for a tool
 */
function getToolAction(toolName) {
    const actions = {
        Read: 'Reading',
        Write: 'Writing',
        Edit: 'Editing',
        Bash: 'Running',
        Grep: 'Searching',
        Glob: 'Finding',
        Task: 'Task',
        WebFetch: 'Fetching',
        WebSearch: 'Searching',
        NotebookEdit: 'Editing notebook',
    };
    return actions[toolName] || toolName;
}
/**
 * Extract a meaningful detail from tool input for display
 */
export function extractToolDetail(toolName, input) {
    const str = (key) => {
        const val = input[key];
        return typeof val === 'string' ? val : undefined;
    };
    switch (toolName) {
        case 'Read':
        case 'Write':
        case 'Edit':
        case 'NotebookEdit':
            return truncatePath(str('file_path'));
        case 'Bash':
            return truncateCommand(str('command'));
        case 'Grep':
            return str('pattern');
        case 'Glob':
            return str('pattern');
        case 'WebFetch':
        case 'WebSearch':
            return truncateUrl(str('url') || str('query'));
        case 'Task':
            return str('description');
        default:
            return undefined;
    }
}
/**
 * Truncate a file path for display
 */
function truncatePath(filePath, maxLen = 40) {
    if (!filePath)
        return undefined;
    if (filePath.length <= maxLen)
        return filePath;
    // Keep the last part of the path
    const parts = filePath.split('/');
    let result = parts[parts.length - 1];
    // Truncate filename itself if it exceeds maxLen
    if (result.length > maxLen) {
        return result.substring(0, maxLen - 3) + '...';
    }
    // Add parent dirs if space allows
    for (let i = parts.length - 2; i >= 0; i--) {
        const candidate = `.../${parts.slice(i).join('/')}`;
        if (candidate.length <= maxLen) {
            result = candidate;
        }
        else {
            break;
        }
    }
    return result;
}
/**
 * Truncate a command for display
 */
function truncateCommand(command, maxLen = 50) {
    if (!command)
        return undefined;
    const firstLine = command.split('\n')[0].trim();
    if (firstLine.length <= maxLen)
        return firstLine;
    return firstLine.substring(0, maxLen - 3) + '...';
}
/**
 * Truncate a URL for display
 */
function truncateUrl(url, maxLen = 40) {
    if (!url)
        return undefined;
    if (url.length <= maxLen)
        return url;
    return url.substring(0, maxLen - 3) + '...';
}
/**
 * Render a background task status line
 * Example: "📋 Background: Installing dependencies ✅"
 */
export function renderBackgroundTask(name, status, spinnerIndex = 0) {
    const statusIcon = status === 'complete'
        ? TOOL_ICONS.complete
        : status === 'error'
            ? TOOL_ICONS.error
            : getSpinnerFrame(spinnerIndex);
    return `📋 Background: ${name} ${statusIcon}`;
}
/**
 * Format a terminal-style message with optional status and background tasks
 */
export function formatTerminalMessage(content, options = {}) {
    const { spinnerIndex = 0, currentOperation, backgroundTasks = [], isComplete = false } = options;
    const parts = [];
    // Add status line if there's a current operation and not complete
    if (currentOperation && !isComplete) {
        parts.push(renderStatusLine(spinnerIndex, currentOperation.icon, currentOperation.name, currentOperation.detail));
        parts.push('');
    }
    // Add main content
    if (content) {
        parts.push(content);
    }
    // Add background tasks if any
    if (backgroundTasks.length > 0) {
        if (content)
            parts.push('');
        for (const task of backgroundTasks) {
            parts.push(renderBackgroundTask(task.name, task.status, spinnerIndex));
        }
    }
    return parts.join('\n');
}
//# sourceMappingURL=terminal-renderer.js.map