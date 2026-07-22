import { app } from "./app.js";
import { config } from "./config.js";
import { prisma } from "@repo-sync/db";
async function main() {
    // Verify database connection
    try {
        await prisma.$connect();
        console.log("✓ Database connected");
    }
    catch (err) {
        console.error("✗ Database connection failed:", err);
        process.exit(1);
    }
    app.listen(config.port, () => {
        console.log(`
┌─────────────────────────────────────────────┐
│  Repo Sync API                              │
│  Environment: ${config.nodeEnv.padEnd(30)}│
│  Port:        ${String(config.port).padEnd(30)}│
│  URL:         ${config.apiUrl.padEnd(30)}│
└─────────────────────────────────────────────┘
    `);
    });
}
// Graceful shutdown
const signals = ["SIGINT", "SIGTERM"];
signals.forEach((signal) => {
    process.on(signal, async () => {
        console.log(`\n${signal} received. Shutting down gracefully...`);
        await prisma.$disconnect();
        process.exit(0);
    });
});
main().catch((err) => {
    console.error("Fatal startup error:", err);
    process.exit(1);
});
//# sourceMappingURL=server.js.map