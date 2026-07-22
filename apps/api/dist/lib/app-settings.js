import { prisma } from "@repo-sync/db";
import { config } from "../config.js";
import { decrypt, encrypt } from "./encryption.js";
const SECRET_KEYS = new Set([
    "github.oauthClientSecret",
    "github.privateKey",
    "github.webhookSecret",
]);
const SETTING_KEYS = {
    oauthClientId: "github.oauthClientId",
    oauthClientSecret: "github.oauthClientSecret",
    oauthCallbackUrl: "github.oauthCallbackUrl",
    appId: "github.appId",
    appSlug: "github.appSlug",
    privateKey: "github.privateKey",
    webhookSecret: "github.webhookSecret",
};
export class AppSettingsService {
    static async getGithubSettings() {
        const rows = await prisma.appSetting.findMany({
            where: {
                key: {
                    in: Object.values(SETTING_KEYS),
                },
            },
        });
        const saved = new Map(rows.map((row) => [
            row.key,
            row.encrypted && row.value ? decrypt(row.value) : row.value,
        ]));
        return {
            oauthClientId: saved.get(SETTING_KEYS.oauthClientId) || config.github.oauthClientId,
            oauthClientSecret: saved.get(SETTING_KEYS.oauthClientSecret) || config.github.oauthClientSecret,
            oauthCallbackUrl: saved.get(SETTING_KEYS.oauthCallbackUrl) || config.github.oauthCallbackUrl,
            appId: saved.get(SETTING_KEYS.appId) || config.github.appId,
            appSlug: saved.get(SETTING_KEYS.appSlug) || config.github.appSlug,
            privateKey: saved.get(SETTING_KEYS.privateKey) || config.github.privateKey,
            webhookSecret: saved.get(SETTING_KEYS.webhookSecret) || config.github.webhookSecret,
        };
    }
    static async getPublicGithubSettings() {
        const settings = await this.getGithubSettings();
        return {
            oauthClientId: settings.oauthClientId,
            oauthCallbackUrl: settings.oauthCallbackUrl,
            appId: settings.appId,
            appSlug: settings.appSlug,
            hasOauthClientSecret: !!settings.oauthClientSecret,
            hasPrivateKey: !!settings.privateKey,
            hasWebhookSecret: !!settings.webhookSecret,
        };
    }
    static async updateGithubSettings(input) {
        const entries = Object.entries({
            [SETTING_KEYS.oauthClientId]: input.oauthClientId,
            [SETTING_KEYS.oauthClientSecret]: input.oauthClientSecret,
            [SETTING_KEYS.oauthCallbackUrl]: input.oauthCallbackUrl,
            [SETTING_KEYS.appId]: input.appId,
            [SETTING_KEYS.appSlug]: input.appSlug,
            [SETTING_KEYS.privateKey]: input.privateKey,
            [SETTING_KEYS.webhookSecret]: input.webhookSecret,
        }).filter(([, value]) => typeof value === "string");
        await prisma.$transaction(entries.map(([key, value]) => {
            const trimmed = (value || "").trim();
            const encrypted = SECRET_KEYS.has(key);
            return prisma.appSetting.upsert({
                where: { key },
                update: {
                    value: encrypted && trimmed ? encrypt(trimmed) : trimmed,
                    encrypted,
                },
                create: {
                    key,
                    value: encrypted && trimmed ? encrypt(trimmed) : trimmed,
                    encrypted,
                },
            });
        }));
        return this.getPublicGithubSettings();
    }
}
//# sourceMappingURL=app-settings.js.map