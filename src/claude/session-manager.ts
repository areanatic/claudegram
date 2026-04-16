import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sessionHistory, SessionHistoryEntry } from './session-history.js';
import { config } from '../config.js';

/**
 * Resolve a stored working directory to a valid path on this system.
 * Handles cross-OS portability (e.g. /Users/x saved on macOS, running on Linux).
 */
function resolveWorkingDirectory(storedPath: string): string {
  // If it exists, use as-is
  if (fs.existsSync(storedPath)) return storedPath;

  // Try remapping: replace the stored home prefix with the current $HOME
  // e.g. /Users/player3vsgpt/foo → /home/player3vsgpt/foo
  const home = os.homedir();
  const homePrefixes = ['/Users/', '/home/'];
  for (const prefix of homePrefixes) {
    if (storedPath.startsWith(prefix)) {
      // Extract everything after the username segment
      const rest = storedPath.slice(prefix.length);
      const slashIdx = rest.indexOf('/');
      const remapped = slashIdx === -1 ? home : `${home}${rest.slice(slashIdx)}`;
      if (fs.existsSync(remapped)) return remapped;
    }
  }

  // Last resort: fall back to $HOME
  return home;
}

interface Session {
  conversationId: string;
  claudeSessionId?: string;
  workingDirectory: string;
  createdAt: Date;
  lastActivity: Date;
}

class SessionManager {
  private sessions: Map<string, Session> = new Map();

  getSession(sessionKey: string): Session | undefined {
    return this.sessions.get(sessionKey);
  }

  /**
   * Check if the Claude session JSONL exceeds 20 MB (115MB incident prevention).
   * Searches ~/.claude/projects/ for the session file by claudeSessionId.
   */
  private isOversized(session: Session): boolean {
    if (!session.claudeSessionId) return false;
    const MB20 = 20 * 1024 * 1024;
    const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(claudeProjectsDir)) return false;
    try {
      const projectDirs = fs.readdirSync(claudeProjectsDir);
      for (const dir of projectDirs) {
        const sessionFile = path.join(claudeProjectsDir, dir, `${session.claudeSessionId}.jsonl`);
        if (fs.existsSync(sessionFile)) {
          const { size } = fs.statSync(sessionFile);
          if (size > MB20) {
            console.log(`[SessionRotation] JSONL oversized: ${Math.round(size / 1024 / 1024)}MB`);
            return true;
          }
          return false;
        }
      }
    } catch { /* ignore */ }
    return false;
  }

  /**
   * Check if a session belongs to a previous day (German time).
   */
  private isNewDay(session: Session): boolean {
    const todayDE = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
    const lastDE = session.lastActivity.toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
    return todayDE !== lastDE;
  }

  /**
   * Get session from memory, or auto-resume the last session from disk if none exists.
   * This prevents "No project set" errors after bot restarts.
   * The session data is always persisted in <DATA_DIR>/sessions.json,
   * so this simply restores what was already there.
   *
   * Auto-rotates sessions on day change (German timezone).
   */
  getOrResumeSession(sessionKey: string): Session | undefined {
    const existing = this.sessions.get(sessionKey);
    if (existing) {
      if (this.isNewDay(existing)) {
        console.log(`[SessionRotation] New day detected for ${sessionKey}, starting fresh session`);
        const workDir = existing.workingDirectory;
        this.sessions.delete(sessionKey);
        return this.createSession(sessionKey, workDir);
      }
      if (this.isOversized(existing)) {
        console.log(`[SessionRotation] Session oversized for ${sessionKey}, starting fresh session`);
        const workDir = existing.workingDirectory;
        this.sessions.delete(sessionKey);
        return this.createSession(sessionKey, workDir);
      }
      return existing;
    }

    const resumed = this.resumeLastSession(sessionKey);
    if (resumed) {
      if (this.isNewDay(resumed)) {
        console.log(`[SessionRotation] Resumed session from previous day for ${sessionKey}, starting fresh`);
        const workDir = resumed.workingDirectory;
        this.sessions.delete(sessionKey);
        return this.createSession(sessionKey, workDir);
      }
      console.log(`[AutoResume] Restored session for ${sessionKey}: ${resumed.workingDirectory}`);
      return resumed;
    }

    // Auto-create session from WORKSPACE_DIR if configured (Space-Bots)
    if (config.WORKSPACE_DIR && config.WORKSPACE_DIR !== (process.env.HOME || '.')) {
      console.log(`[AutoProject] Creating session from WORKSPACE_DIR: ${config.WORKSPACE_DIR}`);
      return this.createSession(sessionKey, config.WORKSPACE_DIR);
    }

    return undefined;
  }

  createSession(sessionKey: string, workingDirectory: string, conversationId?: string): Session {
    const resolved = resolveWorkingDirectory(workingDirectory);
    const session: Session = {
      conversationId: conversationId || this.generateConversationId(),
      claudeSessionId: undefined,
      workingDirectory: resolved,
      createdAt: new Date(),
      lastActivity: new Date(),
    };
    this.sessions.set(sessionKey, session);

    // Persist to history
    sessionHistory.saveSession(sessionKey, session.conversationId, resolved, '', session.claudeSessionId);

    return session;
  }

  updateActivity(sessionKey: string, messagePreview?: string): void {
    const session = this.sessions.get(sessionKey);
    if (session) {
      session.lastActivity = new Date();

      // Update history with last message preview
      if (messagePreview) {
        sessionHistory.updateLastMessage(sessionKey, session.conversationId, messagePreview);
      }
    }
  }

  setWorkingDirectory(sessionKey: string, directory: string): Session {
    const existing = this.sessions.get(sessionKey);
    if (existing) {
      existing.workingDirectory = directory;
      existing.lastActivity = new Date();
      // Clear claudeSessionId on project switch — old session ID must not carry over to new project context
      existing.claudeSessionId = undefined;
      // Save updated session (claudeSessionId intentionally undefined)
      sessionHistory.saveSession(sessionKey, existing.conversationId, directory, '', undefined);
      return existing;
    }
    return this.createSession(sessionKey, directory);
  }

  clearSession(sessionKey: string): void {
    this.sessions.delete(sessionKey);
    // Note: We don't clear history here - history is for resuming past sessions
  }

  resumeSession(sessionKey: string, conversationId: string): Session | undefined {
    const historyEntry = sessionHistory.getSessionByConversationId(sessionKey, conversationId);
    if (!historyEntry) {
      return undefined;
    }

    const resolvedPath = resolveWorkingDirectory(historyEntry.projectPath);
    const session: Session = {
      conversationId: historyEntry.conversationId,
      claudeSessionId: historyEntry.claudeSessionId,
      workingDirectory: resolvedPath,
      createdAt: new Date(historyEntry.createdAt),
      lastActivity: new Date(),
    };
    this.sessions.set(sessionKey, session);

    // Update history activity (with resolved path)
    sessionHistory.saveSession(sessionKey, conversationId, resolvedPath, historyEntry.lastMessagePreview, historyEntry.claudeSessionId);

    return session;
  }

  resumeLastSession(sessionKey: string): Session | undefined {
    const lastEntry = sessionHistory.getLastSession(sessionKey);
    if (!lastEntry) {
      return undefined;
    }

    return this.resumeSession(sessionKey, lastEntry.conversationId);
  }

  getSessionHistory(sessionKey: string, limit: number = 5): SessionHistoryEntry[] {
    return sessionHistory.getHistory(sessionKey, limit);
  }

  setClaudeSessionId(sessionKey: string, claudeSessionId: string): void {
    const session = this.sessions.get(sessionKey);
    if (!session) return;
    session.claudeSessionId = claudeSessionId;
    session.lastActivity = new Date();
    sessionHistory.updateClaudeSessionId(sessionKey, session.conversationId, claudeSessionId);
  }

  private generateConversationId(): string {
    return `conv_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
}

export const sessionManager = new SessionManager();
