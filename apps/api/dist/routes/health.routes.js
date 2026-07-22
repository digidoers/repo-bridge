import { Router } from "express";
export const healthRouter = Router();
healthRouter.get("/", (_req, res) => {
    res.json({
        ok: true,
        data: {
            status: "healthy",
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
        },
    });
});
//# sourceMappingURL=health.routes.js.map