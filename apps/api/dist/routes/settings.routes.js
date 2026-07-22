import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import { AppSettingsService } from "../lib/app-settings.js";
export const settingsRouter = Router();
settingsRouter.use(authenticate);
settingsRouter.get("/github", async (_req, res, next) => {
    try {
        const settings = await AppSettingsService.getPublicGithubSettings();
        res.json({ ok: true, data: settings });
    }
    catch (err) {
        next(err);
    }
});
settingsRouter.patch("/github", async (req, res, next) => {
    try {
        const body = req.body;
        const allowedKeys = [
            "oauthClientId",
            "oauthClientSecret",
            "oauthCallbackUrl",
            "appId",
            "appSlug",
            "privateKey",
            "webhookSecret",
        ];
        const data = {};
        for (const key of allowedKeys) {
            const value = body[key];
            if (typeof value === "string") {
                data[key] = value;
            }
        }
        const settings = await AppSettingsService.updateGithubSettings(data);
        res.json({ ok: true, data: settings });
    }
    catch (err) {
        next(err);
    }
});
//# sourceMappingURL=settings.routes.js.map