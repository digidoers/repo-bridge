import type { Request, Response, NextFunction } from "express";
export declare class AppError extends Error {
    readonly statusCode: number;
    readonly code: string;
    readonly details?: Record<string, string[]>;
    constructor(statusCode: number, code: string, message: string, details?: Record<string, string[]>);
    static badRequest(message: string, details?: Record<string, string[]>): AppError;
    static unauthorized(message?: string): AppError;
    static forbidden(message?: string): AppError;
    static notFound(message?: string): AppError;
    static conflict(message: string): AppError;
    static internal(message?: string): AppError;
}
export declare function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void;
//# sourceMappingURL=error-handler.d.ts.map