export declare function getWorkspaceRoot(): string;
/**
 * Check if target path is within root directory.
 * Uses realpathSync to resolve symlinks and prevent symlink-based traversal.
 */
export declare function isPathWithinRoot(root: string, target: string): boolean;
export declare function resolvePathWithinRoot(root: string, target: string): string | null;
//# sourceMappingURL=workspace-guard.d.ts.map