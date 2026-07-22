export class AppError extends Error {
    statusCode;
    code;
    details;
    constructor(statusCode, code, message, details) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
        this.details = details;
        Object.setPrototypeOf(this, AppError.prototype);
    }
    static badRequest(message, details) {
        return new AppError(400, "BAD_REQUEST", message, details);
    }
    static unauthorized(message = "Authentication required") {
        return new AppError(401, "UNAUTHORIZED", message);
    }
    static forbidden(message = "Insufficient permissions") {
        return new AppError(403, "FORBIDDEN", message);
    }
    static notFound(message = "Resource not found") {
        return new AppError(404, "NOT_FOUND", message);
    }
    static conflict(message) {
        return new AppError(409, "CONFLICT", message);
    }
    static internal(message = "Internal server error") {
        return new AppError(500, "INTERNAL_ERROR", message);
    }
}
export function errorHandler(err, _req, res, _next) {
    if (err instanceof AppError) {
        res.status(err.statusCode).json({
            ok: false,
            error: {
                code: err.code,
                message: err.message,
                ...(err.details && { details: err.details }),
            },
        });
        return;
    }
    // Unexpected errors
    console.error("Unhandled error:", err);
    res.status(500).json({
        ok: false,
        error: {
            code: "INTERNAL_ERROR",
            message: process.env.NODE_ENV === "production"
                ? "An unexpected error occurred"
                : err.message,
        },
    });
}
//# sourceMappingURL=error-handler.js.map