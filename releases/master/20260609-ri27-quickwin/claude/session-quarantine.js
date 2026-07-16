import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { config } from '../config.js';
function todayStr() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
}
function timestampStr() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}
export function findClaudeSessionJsonl(sessionId) {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(projectsDir))
        return null;
    try {
        for (const dir of fs.readdirSync(projectsDir)) {
            const candidate = path.join(projectsDir, dir, `${sessionId}.jsonl`);
            if (fs.existsSync(candidate))
                return candidate;
        }
    }
    catch {
        return null;
    }
    return null;
}
export function getClaudeSessionJsonlSize(sessionId) {
    const filePath = findClaudeSessionJsonl(sessionId);
    if (!filePath)
        return null;
    try {
        return fs.statSync(filePath).size;
    }
    catch {
        return null;
    }
}
export function quarantineClaudeSession(request) {
    const quarantineDir = path.join(config.DATA_DIR, 'quarantine', todayStr());
    fs.mkdirSync(quarantineDir, { recursive: true, mode: 0o700 });
    const stamp = timestampStr();
    const sourcePath = findClaudeSessionJsonl(request.sessionId) ?? undefined;
    const manifestPath = path.join(quarantineDir, `${stamp}-${request.sessionId}.manifest.json`);
    let backupPath;
    let quarantinedPath;
    let sizeBytes;
    let quarantined = false;
    if (sourcePath) {
        try {
            sizeBytes = fs.statSync(sourcePath).size;
            backupPath = path.join(quarantineDir, `${request.sessionId}.jsonl.bak`);
            if (!fs.existsSync(backupPath)) {
                fs.copyFileSync(sourcePath, backupPath);
            }
            quarantinedPath = `${sourcePath}.quarantined-${stamp}`;
            fs.renameSync(sourcePath, quarantinedPath);
            quarantined = true;
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            request = { ...request, detail: request.detail ? `${request.detail}; ${detail}` : detail };
        }
    }
    const manifest = {
        ...request,
        sourcePath,
        backupPath,
        quarantinedPath,
        sizeBytes,
        quarantined,
        createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    return {
        quarantined,
        sourcePath,
        backupPath,
        quarantinedPath,
        manifestPath,
        sizeBytes,
        reason: request.reason,
    };
}
//# sourceMappingURL=session-quarantine.js.map