/**
 * Encrypt a string using AES-256-GCM.
 * Returns base64-encoded `iv:authTag:ciphertext`.
 */
export declare function encrypt(plaintext: string): string;
/**
 * Decrypt a string encrypted by `encrypt`.
 */
export declare function decrypt(ciphertext: string): string;
//# sourceMappingURL=encryption.d.ts.map