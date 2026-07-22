interface Config {
    port: number;
    nodeEnv: string;
    jwt: {
        secret: string;
        expiresIn: string;
    };
    github: {
        oauthClientId: string;
        oauthClientSecret: string;
        oauthCallbackUrl: string;
        appId: string;
        appSlug: string;
        privateKey: string;
        webhookSecret: string;
    };
    webUrl: string;
    apiUrl: string;
    encryptionKey: string;
}
export declare const config: Config;
export {};
//# sourceMappingURL=config.d.ts.map