import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { config } from "./config.js";
import { authRouter } from "./routes/auth.routes.js";
import { healthRouter } from "./routes/health.routes.js";
import { reposRouter } from "./routes/repos.routes.js";
import { pushEventsRouter } from "./routes/push-events.routes.js";
import { webhooksRouter } from "./routes/webhooks.routes.js";
import { syncJobsRouter } from "./routes/sync-jobs.routes.js";
import { settingsRouter } from "./routes/settings.routes.js";
import { errorHandler } from "./middleware/error-handler.js";
import { requestLogger } from "./middleware/request-logger.js";
const app = express();
// ─── Security ────────────────────────────────────────────
app.use(helmet({
    contentSecurityPolicy: false, // we serve API only, CSP is frontend concern
}));
app.use(cors({
    origin: config.webUrl,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(express.json({
    limit: "10mb",
    verify: (req, _res, buf) => {
        req.rawBody = buf;
    },
}));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
// ─── Logging ─────────────────────────────────────────────
app.use(requestLogger);
// ─── Routes ──────────────────────────────────────────────
app.use("/health", healthRouter);
app.use("/auth", authRouter);
app.use("/repos", reposRouter);
app.use("/push-events", pushEventsRouter);
app.use("/webhooks", webhooksRouter);
app.use("/settings", settingsRouter);
app.use("/", syncJobsRouter);
// ─── Error Handling ──────────────────────────────────────
app.use(errorHandler);
export { app };
//# sourceMappingURL=app.js.map