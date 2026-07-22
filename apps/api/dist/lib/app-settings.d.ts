export interface GithubRuntimeSettings {
    oauthClientId: string;
    oauthClientSecret: string;
    oauthCallbackUrl: string;
    appId: string;
    appSlug: string;
    privateKey: string;
    webhookSecret: string;
}
export interface PublicGithubSettings {
    oauthClientId: string;
    oauthCallbackUrl: string;
    appId: string;
    appSlug: string;
    hasOauthClientSecret: boolean;
    hasPrivateKey: boolean;
    hasWebhookSecret: boolean;
}
export declare class AppSettingsService {
    static getGithubSettings(): Promise<GithubRuntimeSettings>;
    static getPublicGithubSettings(): Promise<PublicGithubSettings>;
    static updateGithubSettings(input: Partial<GithubRuntimeSettings>): Promise<PublicGithubSettings>;
}
//# sourceMappingURL=app-settings.d.ts.map