import crypto from "crypto";
import { config } from "../config.js";
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
/**
 * Encrypt a string using AES-256-GCM.
 * Returns base64-encoded `iv:authTag:ciphertext`.
 */
export function encrypt(plaintext) {
    const key = normalizeKey(config.encryptionKey);
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(plaintext, "utf8", "base64");
    encrypted += cipher.final("base64");
    const authTag = cipher.getAuthTag();
    return `${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted}`;
}
/**
 * Decrypt a string encrypted by `encrypt`.
 */
export function decrypt(ciphertext) {
    const key = normalizeKey(config.encryptionKey);
    const [ivB64, authTagB64, encryptedB64] = ciphertext.split(":");
    if (!ivB64 || !authTagB64 || !encryptedB64) {
        throw new Error("Invalid ciphertext format");
    }
    const iv = Buffer.from(ivB64, "base64");
    const authTag = Buffer.from(authTagB64, "base64");
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encryptedB64, "base64", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
}
/**
 * Ensure the key is exactly 32 bytes for AES-256.
 */
function normalizeKey(key) {
    return crypto.createHash("sha256").update(key).digest();
}
//# sourceMappingURL=encryption.js.map