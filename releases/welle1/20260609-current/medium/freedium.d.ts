export interface FreediumArticle {
    title: string;
    author: string;
    markdown: string;
    url: string;
}
/**
 * Check whether a URL points to a Medium article.
 */
export declare function isMediumUrl(url: string): boolean;
/**
 * Convert a Medium URL to its Freedium mirror equivalent.
 */
export declare function toFreediumUrl(url: string): string;
/**
 * Fetch a Medium article via Freedium and convert to Markdown.
 */
export declare function fetchMediumArticle(url: string): Promise<FreediumArticle>;
//# sourceMappingURL=freedium.d.ts.map