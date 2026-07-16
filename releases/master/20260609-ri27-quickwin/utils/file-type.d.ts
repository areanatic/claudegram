export interface FileTypeResult {
    extension: string;
    mimeType: string;
}
/**
 * Detect file type from magic bytes.
 * Returns null if the file type is not recognized as an image.
 */
export declare function detectImageType(buffer: Buffer): FileTypeResult | null;
/**
 * Validate that a file is actually an image by checking magic bytes.
 * @param filePath Path to the file to validate
 * @returns true if the file is a valid image, false otherwise
 */
export declare function isValidImageFile(filePath: string): boolean;
/**
 * Get the actual file type from magic bytes.
 * @param filePath Path to the file
 * @returns FileTypeResult or null if not recognized
 */
export declare function getFileType(filePath: string): FileTypeResult | null;
//# sourceMappingURL=file-type.d.ts.map