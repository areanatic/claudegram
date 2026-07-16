/**
 * redditfetch — Native TypeScript module for fetching Reddit posts, comments,
 * subreddits, and user profiles as markdown or JSON.
 *
 * Replaces the external Python subprocess (redditfetch.py) to eliminate
 * Python runtime overhead and improve latency.
 */
export interface ParsedTarget {
    type: 'post' | 'subreddit' | 'user' | 'share_link';
    subreddit?: string;
    post_id?: string;
    username?: string;
    url?: string;
}
export interface RedditComment {
    type: 'comment' | 'more';
    depth: number;
    author?: string;
    score?: number;
    body?: string;
    created_utc?: number;
    id?: string;
    count?: number;
}
export interface PostResult {
    post: Record<string, unknown>;
    comments: RedditComment[];
}
export interface SubredditResult {
    subreddit: string;
    sort: string;
    posts: Record<string, unknown>[];
}
export interface UserResult {
    username: string;
    items: Record<string, unknown>[];
}
export interface RedditFetchOptions {
    format?: 'markdown' | 'json';
    sort?: string;
    limit?: number;
    depth?: number;
    timeFilter?: string;
}
export declare function clearTokenCache(): void;
export declare function parseRedditUrl(raw: string): ParsedTarget | null;
export declare function redditFetch(targets: string[], options?: RedditFetchOptions): Promise<string>;
/**
 * Fetch once, return both markdown and JSON strings.
 * Avoids a second API call for the large-thread JSON fallback.
 */
export declare function redditFetchBoth(targets: string[], options?: RedditFetchOptions): Promise<{
    markdown: string;
    json: string;
}>;
//# sourceMappingURL=redditfetch.d.ts.map