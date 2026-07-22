import { Router } from "express";
import bcrypt from "bcrypt";
import { prisma } from "@repo-sync/db";
import { validate } from "../middleware/validate.js";
import { signupSchema, loginSchema } from "./auth.schemas.js";
import { authenticate, generateToken, setAuthCookie, clearAuthCookie, } from "../middleware/auth.js";
import { AppError } from "../middleware/error-handler.js";
import { config } from "../config.js";
import { encrypt } from "../lib/encryption.js";
import { rateLimit } from "express-rate-limit";
import { AppSettingsService } from "../lib/app-settings.js";
export const authRouter = Router();
const BCRYPT_ROUNDS = 12;
// Rate limit auth endpoints: 10 requests per minute per IP
const authLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        ok: false,
        error: {
            code: "RATE_LIMITED",
            message: "Too many requests, please try again later",
        },
    },
});
authRouter.use(authLimiter);
// ─────────────────────────────────────────────────────────
// POST /auth/signup
// ─────────────────────────────────────────────────────────
authRouter.post("/signup", validate(signupSchema), async (req, res, next) => {
    try {
        const { name, email, password } = req.body;
        // Check if email already exists
        const existing = await prisma.user.findUnique({ where: { email } });
        if (existing) {
            throw AppError.conflict("An account with this email already exists");
        }
        const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
        const user = await prisma.user.create({
            data: {
                name,
                email,
                passwordHash,
            },
        });
        const token = generateToken(user.id, user.email);
        setAuthCookie(res, token);
        const profile = toUserProfile(user);
        const body = { user: profile, token };
        res.status(201).json({ ok: true, data: body });
    }
    catch (err) {
        next(err);
    }
});
// ─────────────────────────────────────────────────────────
// POST /auth/login
// ─────────────────────────────────────────────────────────
authRouter.post("/login", validate(loginSchema), async (req, res, next) => {
    try {
        const { email, password } = req.body;
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user) {
            throw AppError.unauthorized("Invalid email or password");
        }
        const validPassword = await bcrypt.compare(password, user.passwordHash);
        if (!validPassword) {
            throw AppError.unauthorized("Invalid email or password");
        }
        const token = generateToken(user.id, user.email);
        setAuthCookie(res, token);
        const profile = toUserProfile(user);
        const body = { user: profile, token };
        res.json({ ok: true, data: body });
    }
    catch (err) {
        next(err);
    }
});
// ─────────────────────────────────────────────────────────
// GET /auth/me
// ─────────────────────────────────────────────────────────
authRouter.get("/me", authenticate, (req, res) => {
    res.json({
        ok: true,
        data: {
            id: req.user.id,
            email: req.user.email,
            name: req.user.name,
            avatarUrl: req.user.avatarUrl,
            githubLogin: req.user.githubLogin,
            createdAt: new Date().toISOString(), // the middleware already validated the user
        },
    });
});
// ─────────────────────────────────────────────────────────
// POST /auth/logout
// ─────────────────────────────────────────────────────────
authRouter.post("/logout", (_req, res) => {
    clearAuthCookie(res);
    res.json({ ok: true, data: { message: "Logged out successfully" } });
});
// ─────────────────────────────────────────────────────────
// GET /auth/github/start — redirect user to GitHub OAuth
// ─────────────────────────────────────────────────────────
authRouter.get("/github/start", async (req, res, next) => {
    try {
        const githubSettings = await AppSettingsService.getGithubSettings();
        if (!githubSettings.oauthClientId) {
            return res.redirect(`${config.webUrl}/login?github=not_configured`);
        }
        const params = new URLSearchParams({
            client_id: githubSettings.oauthClientId,
            redirect_uri: githubSettings.oauthCallbackUrl,
            scope: "read:user user:email repo read:org",
            state: generateOAuthState(req),
        });
        res.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
    }
    catch (err) {
        next(err);
    }
});
// ─────────────────────────────────────────────────────────
// GET /auth/github/callback — handle OAuth callback
// ─────────────────────────────────────────────────────────
authRouter.get("/github/callback", async (req, res, next) => {
    try {
        const { code } = req.query;
        const githubSettings = await AppSettingsService.getGithubSettings();
        if (!code || typeof code !== "string") {
            throw AppError.badRequest("Missing authorization code");
        }
        if (!githubSettings.oauthClientId || !githubSettings.oauthClientSecret) {
            throw AppError.internal("GitHub OAuth is not configured");
        }
        // Exchange code for access token
        const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            body: JSON.stringify({
                client_id: githubSettings.oauthClientId,
                client_secret: githubSettings.oauthClientSecret,
                code,
            }),
        });
        const tokenData = (await tokenResponse.json());
        if (!tokenData.access_token) {
            throw AppError.unauthorized(`GitHub OAuth failed: ${tokenData.error || "no access token"}`);
        }
        // Fetch GitHub user profile
        const ghUserResponse = await fetch("https://api.github.com/user", {
            headers: {
                Authorization: `Bearer ${tokenData.access_token}`,
                Accept: "application/vnd.github+json",
            },
        });
        if (!ghUserResponse.ok) {
            throw AppError.internal("Failed to fetch GitHub user profile");
        }
        const ghUser = (await ghUserResponse.json());
        // If GitHub doesn't expose email, fetch from emails endpoint
        let email = ghUser.email;
        if (!email) {
            const emailsResponse = await fetch("https://api.github.com/user/emails", {
                headers: {
                    Authorization: `Bearer ${tokenData.access_token}`,
                    Accept: "application/vnd.github+json",
                },
            });
            if (emailsResponse.ok) {
                const emails = (await emailsResponse.json());
                const primary = emails.find((e) => e.primary && e.verified);
                email = primary?.email || emails[0]?.email || null;
            }
        }
        if (!email) {
            throw AppError.badRequest("Could not retrieve email from GitHub. Please make your email public or use email/password signup.");
        }
        const encryptedToken = encrypt(tokenData.access_token);
        // Check if this GitHub login is already linked, or if the email matches
        let user = await prisma.user.findFirst({
            where: {
                OR: [
                    { githubLogin: ghUser.login },
                    { email: email.toLowerCase() },
                ],
            },
        });
        if (user) {
            // Update with latest GitHub info
            user = await prisma.user.update({
                where: { id: user.id },
                data: {
                    githubLogin: ghUser.login,
                    githubToken: encryptedToken,
                    avatarUrl: ghUser.avatar_url,
                    name: user.name || ghUser.name,
                },
            });
        }
        else {
            // Create new user via GitHub
            user = await prisma.user.create({
                data: {
                    email: email.toLowerCase(),
                    passwordHash: "", // GitHub-only users can't log in with password
                    name: ghUser.name || ghUser.login,
                    githubLogin: ghUser.login,
                    githubToken: encryptedToken,
                    avatarUrl: ghUser.avatar_url,
                },
            });
        }
        const jwtToken = generateToken(user.id, user.email);
        setAuthCookie(res, jwtToken);
        // Redirect to the frontend dashboard
        res.redirect(`${config.webUrl}/dashboard?auth=success`);
    }
    catch (err) {
        next(err);
    }
});
// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────
function toUserProfile(user) {
    return {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
        githubLogin: user.githubLogin,
        createdAt: user.createdAt.toISOString(),
    };
}
function generateOAuthState(_req) {
    // In production, store a CSRF token in session and validate on callback.
    // For now, we use a random nonce.
    return crypto.randomUUID();
}
// Ensure crypto is available
import crypto from "crypto";
//# sourceMappingURL=auth.routes.js.map