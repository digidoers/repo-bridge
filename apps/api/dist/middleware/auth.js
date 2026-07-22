import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { prisma } from "@repo-sync/db";
import { AppError } from "./error-handler.js";
/**
 * Extracts JWT from httpOnly cookie or Authorization header.
 * Attaches `req.user` with the authenticated user record.
 */
export async function authenticate(req, _res, next) {
    try {
        const token = req.cookies?.token ||
            extractBearerToken(req.headers.authorization);
        if (!token) {
            throw AppError.unauthorized("No authentication token provided");
        }
        let payload;
        try {
            payload = jwt.verify(token, config.jwt.secret);
        }
        catch {
            throw AppError.unauthorized("Invalid or expired token");
        }
        const user = await prisma.user.findUnique({
            where: { id: payload.userId },
            select: {
                id: true,
                email: true,
                name: true,
                avatarUrl: true,
                githubLogin: true,
            },
        });
        if (!user) {
            throw AppError.unauthorized("User account not found");
        }
        req.user = user;
        next();
    }
    catch (err) {
        next(err);
    }
}
function extractBearerToken(header) {
    if (!header?.startsWith("Bearer "))
        return null;
    return header.slice(7);
}
/**
 * Generate a signed JWT for a user.
 */
export function generateToken(userId, email) {
    const payload = { userId, email };
    return jwt.sign(payload, config.jwt.secret, {
        expiresIn: config.jwt.expiresIn,
    });
}
/**
 * Set the JWT as an httpOnly cookie on the response.
 */
export function setAuthCookie(res, token) {
    const maxAge = parseDuration(config.jwt.expiresIn);
    res.cookie("token", token, {
        httpOnly: true,
        secure: config.nodeEnv === "production",
        sameSite: config.nodeEnv === "production" ? "strict" : "lax",
        maxAge,
        path: "/",
    });
}
/**
 * Clear the auth cookie.
 */
export function clearAuthCookie(res) {
    res.clearCookie("token", {
        httpOnly: true,
        secure: config.nodeEnv === "production",
        sameSite: config.nodeEnv === "production" ? "strict" : "lax",
        path: "/",
    });
}
/**
 * Parse duration strings like "7d", "24h", "60m" to milliseconds.
 */
function parseDuration(duration) {
    const match = duration.match(/^(\d+)([dhms])$/);
    if (!match)
        return 7 * 24 * 60 * 60 * 1000; // default 7 days
    const value = parseInt(match[1], 10);
    const unit = match[2];
    switch (unit) {
        case "d":
            return value * 24 * 60 * 60 * 1000;
        case "h":
            return value * 60 * 60 * 1000;
        case "m":
            return value * 60 * 1000;
        case "s":
            return value * 1000;
        default:
            return 7 * 24 * 60 * 60 * 1000;
    }
}
//# sourceMappingURL=auth.js.map