// NEXUS Mail — read-only "ask the bot about my mail" MCP tool (P6 / C-E).
//
// Lets the OPERATOR (Master, self_private scope) get a REDACTED overview of the mail
// pipeline DB (the P0.7 metadata monitor at MAIL_DB) from chat. Three fail-closed gates:
//   1. boot scope-gate: only self_private (Master) gets the real tool + description;
//      family/test/public bots get a "not available" description so the LLM never calls
//      it, and the handler returns nothing.
//   2. per-turn /private gate: while /private is on, the tool returns "unavailable".
//   3. column gate (the real PII defense): redaction is enforced at the SQL SELECT —
//      ONLY count/date_utc/from_domain/importance_hint/privacy_tier/status columns are
//      ever selected; subject/snippet/body_text/from_addr/from_name/to_addrs are NEVER
//      in any query, so they cannot leak even via a bug. blocked-tier rows are COUNTED
//      only, never detailed.
//
// The DB is opened READ-ONLY + query_only=ON; it is WAL (the python monitor writes it
// live), so busy_timeout is mandatory and readers never block the writer. MAIL_DB is a
// hardcoded module-literal — NO user-supplied path is ever accepted.
//
// Mirrors the nexus_memory_recent / omi_task_search pattern (nexus-memory.ts +
// mcp-tools.ts) verbatim for the gating + tool() wrapper.
import Database from 'better-sqlite3';
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { readMemoryPolicyFromEnv } from './nexus-memory.js';
import { isPrivate } from './privacy-state.js';
// Hardcoded — the canonical mail DB shared with the P0.7 monitor/dispatcher. Never a path arg.
const MAIL_DB = '/Volumes/AstronOne/shared-memory/nexus/mail/mail.sqlite';
// The digest "anchor" pseudo-message (digest.py) must never count as real mail.
const ANCHOR_DOMAIN = 'digest.nexus.local';
const TOP_DOMAINS = 8;
/**
 * Read-only, column-allowlisted aggregation over the mail DB. Returns a redacted
 * MailOverview, or null on any error (fail-closed — caller shows a generic message,
 * never a schema/path leak). `recent` clamped to [0, 20]; 0 = no per-message list.
 */
export function mailOverviewReadOnly(recent = 0) {
    const recentN = Math.max(0, Math.min(20, Math.floor(recent)));
    let conn = null;
    try {
        conn = new Database(MAIL_DB, { readonly: true, fileMustExist: true });
        conn.pragma('busy_timeout = 5000');
        conn.pragma('query_only = ON');
        const totals = conn
            .prepare(`SELECT COUNT(*) AS c, MIN(date_utc) AS mn, MAX(date_utc) AS mx
         FROM messages WHERE from_domain <> ?`)
            .get(ANCHOR_DOMAIN);
        const impRows = conn
            .prepare(`SELECT importance_hint AS k, COUNT(*) AS c FROM messages
         WHERE from_domain <> ? GROUP BY importance_hint`)
            .all(ANCHOR_DOMAIN);
        const tierRows = conn
            .prepare(`SELECT privacy_tier AS k, COUNT(*) AS c FROM messages
         WHERE from_domain <> ? GROUP BY privacy_tier`)
            .all(ANCHOR_DOMAIN);
        const domainRows = conn
            .prepare(
        // blocked-tier rows are COUNTED (in total/tier) but NEVER detailed (Codex P1):
        // exclude them from per-domain disclosure.
        `SELECT from_domain AS d, COUNT(*) AS c FROM messages
         WHERE from_domain <> ? AND privacy_tier <> 'blocked'
         GROUP BY from_domain ORDER BY c DESC, d ASC LIMIT ?`)
            .all(ANCHOR_DOMAIN, TOP_DOMAINS);
        let outboxRows = [];
        try {
            outboxRows = conn
                .prepare(`SELECT status AS k, COUNT(*) AS c FROM push_outbox GROUP BY status`)
                .all();
        }
        catch { /* push_outbox optional pre-003 */ }
        let newslettersActive = 0;
        try {
            newslettersActive = conn
                .prepare(`SELECT COUNT(*) AS c FROM newsletter_senders WHERE status='active'`)
                .get().c;
        }
        catch { /* table optional */ }
        let recentList = [];
        if (recentN > 0) {
            const rawRecent = conn
                .prepare(
            // blocked-tier rows are never detailed (Codex P1) — exclude from the per-message list.
            `SELECT date_utc, from_domain, importance_hint, privacy_tier FROM messages
           WHERE from_domain <> ? AND privacy_tier <> 'blocked' ORDER BY date_utc DESC LIMIT ?`)
                .all(ANCHOR_DOMAIN, recentN);
            recentList = rawRecent.map(r => ({
                date_utc: r.date_utc,
                from_domain: r.from_domain,
                importance: r.importance_hint ?? 'n/a',
                tier: r.privacy_tier,
            }));
        }
        const toMap = (rows) => {
            const m = {};
            for (const r of rows)
                m[r.k ?? 'n/a'] = r.c;
            return m;
        };
        return {
            total: totals.c,
            date_min: totals.mn,
            date_max: totals.mx,
            importance: toMap(impRows),
            tier: toMap(tierRows),
            top_domains: domainRows.map(r => ({ domain: r.d, count: r.c })),
            outbox: toMap(outboxRows.map(r => ({ k: r.k, c: r.c }))),
            newsletters_active: newslettersActive,
            recent: recentList,
        };
    }
    catch (err) {
        console.error('[NexusMail/MCP] mailOverviewReadOnly error:', err);
        return null;
    }
    finally {
        try {
            conn?.close();
        }
        catch { /* swallow */ }
    }
}
function formatOverview(o) {
    const range = o.date_min && o.date_max
        ? `${o.date_min.slice(0, 10)} → ${o.date_max.slice(0, 10)}`
        : 'n/a';
    const imp = ['high', 'normal', 'low', 'n/a']
        .filter(k => o.importance[k])
        .map(k => `${k}:${o.importance[k]}`)
        .join(' · ') || '—';
    const tier = Object.entries(o.tier).map(([k, v]) => `${k}:${v}`).join(' · ') || '—';
    const domains = o.top_domains.length
        ? o.top_domains.map(d => `${d.domain} (${d.count})`).join(', ')
        : '—';
    const outbox = Object.entries(o.outbox).map(([k, v]) => `${k}:${v}`).join(' · ') || 'leer';
    const lines = [
        `📬 Mail-Überblick — ${o.total} Nachrichten (${range})`,
        `Wichtigkeit: ${imp}`,
        `Privacy-Tier: ${tier}`,
        `Top-Absender-Domains: ${domains}`,
        `Push-Outbox: ${outbox} · aktive Newsletter: ${o.newsletters_active}`,
    ];
    if (o.recent.length) {
        lines.push('', 'Letzte:');
        for (const r of o.recent) {
            lines.push(`• ${r.date_utc.slice(0, 16).replace('T', ' ')} ${r.from_domain} [${r.importance}/${r.tier}]`);
        }
    }
    return lines.join('\n');
}
/**
 * The MCP tool wrapper. Operator (self_private) only; degraded for other scopes;
 * /private downgrades to unavailable. Returns ONLY redacted aggregates.
 */
export function mailOverviewTool(toolsCtx) {
    const bootPolicy = readMemoryPolicyFromEnv();
    const safePolicy = bootPolicy.scope === 'operator_all'
        ? { ...bootPolicy, scope: 'public' }
        : bootPolicy;
    // Executable operator gate (Codex P1): scope alone is NOT enough — a misconfigured
    // family/test bot set to self_private would otherwise surface mail counts. Require an
    // explicit opt-in env flag too (default OFF). Master + the test bot set
    // NEXUS_MAIL_OVERVIEW=1; this is in ADDITION to the per-bot BOT_TOOLS allowlist.
    const mailOverviewEnabled = process.env.NEXUS_MAIL_OVERVIEW === '1'
        || process.env.NEXUS_MAIL_OVERVIEW === 'true';
    const isOperator = safePolicy.scope === 'self_private' && mailOverviewEnabled;
    const description = isOperator
        ? 'Read-only overview of Arash\'s mail pipeline (counts only — NEVER subjects/senders\' addresses/bodies). USE when the user asks "wie viele Mails", "Überblick über meine Mails", "wie viele wichtige", "welche Absender-Domains", "neue Newsletter", "Mail-Status". Returns: total + date range, importance breakdown (high/normal/low), privacy-tier breakdown, top sender DOMAINS by count, push-outbox status, active newsletter count, and an optional recent list (date + domain + importance only, NO subject). Pass recent=N (max 20) for the latest N. Operator-private + read-only; unavailable in family/test scope or while /private is on. This does NOT read mail content — for the body of a specific mail there is no tool (privacy by design).'
        : 'Operator-private mail overview. Not available in this bot context (returns nothing).';
    return tool('nexusgram_mail_overview', description, {
        recent: z.number().int().min(0).max(20).optional()
            .describe('Also list the latest N messages (date + domain + importance only, no subject). 0/omit = summary only.'),
    }, async ({ recent }) => {
        try {
            if (!isOperator) {
                return { content: [{ type: 'text', text: 'Mail overview is not available in this bot context.' }] };
            }
            if (isPrivate(toolsCtx.sessionKey)) {
                return { content: [{ type: 'text', text: 'Mail overview is unavailable while /private is on — turn /private off to query mail counts.' }] };
            }
            const o = mailOverviewReadOnly(recent ?? 0);
            if (o === null) {
                return { content: [{ type: 'text', text: 'Mail overview unavailable.' }], isError: true };
            }
            return { content: [{ type: 'text', text: formatOverview(o) }] };
        }
        catch (error) {
            // Generic to the user (Codex P2 — no error/schema leak); detail to server log only.
            console.error('[NexusMail/MCP] mailOverviewTool error:', error);
            return {
                content: [{ type: 'text', text: 'Mail overview unavailable.' }],
                isError: true,
            };
        }
    });
}
//# sourceMappingURL=mail-readonly.js.map