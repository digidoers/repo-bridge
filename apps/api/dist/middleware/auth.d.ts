import type { Request, Response, NextFunction } from "express";
export interface JwtPayload {
    userId: string;
    email: string;
}
declare global {
    namespace Express {
        interface Request {
            user?: {
                id: string;
                email: string;
                name: string | null;
                avatarUrl: string | null;
                githubLogin: string | null;
            };
        }
    }
}
/**
 * Extracts JWT from httpOnly cookie or Authorization header.
 * Attaches `req.user` with the authenticated user record.
 */
export declare function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void>;
/**
 * Generate a signed JWT for a user.
 */
export declare function generateToken(userId: string, email: string): string;
/**
 * Set the JWT as an httpOnly cookie on the response.
 */
export declare function setAuthCookie(res: Response, token: string): void;
/**
 * Clear the auth cookie.
 */
export declare function clearAuthCookie(res: Response): void;
//# sourceMappingURL=auth.d.ts.map