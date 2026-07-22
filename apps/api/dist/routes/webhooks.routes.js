import { Router } from "express";
import crypto from "crypto";
import { prisma } from "@repo-sync/db";
import { GithubAppService } from "../lib/github-app.js";
import { AppSettingsService } from "../lib/app-settings.js";
export const webhooksRouter = Router();
/**
 * POST /webhooks/github
 * Handles incoming webhooks from GitHub App.
 * Verifies HMAC signature, confirms tracking branch, retrieves file diffs,
 * and records PushEvent + PushFiles in the database.
 */
webhooksRouter.post("/github", async (req, res, next) => {
    try {
        const githubEvent = req.headers["x-github-event"];
        const deliveryId = req.headers["x-github-delivery"];
        const signature = req.headers["x-hub-signature-256"];
        console.log(`[Webhook Received] Event: ${githubEvent}, Delivery: ${deliveryId}`);
        // 1. Verify HMAC signature if GITHUB_WEBHOOK_SECRET is configured
        const webhookSecret = (await AppSettingsService.getGithubSettings()).webhookSecret;
        if (webhookSecret) {
            if (!signature) {
                return res.status(401).json({ ok: false, error: "Missing signature header" });
            }
            const rawBody = req.rawBody;
            if (!rawBody) {
                return res.status(400).json({ ok: false, error: "Missing raw body for verification" });
            }
            const hmac = crypto.createHmac("sha256", webhookSecret);
            const digest = "sha256=" + hmac.update(rawBody).digest("hex");
            if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest))) {
                return res.status(401).json({ ok: false, error: "Invalid signature" });
            }
        }
        // 2. Only handle "push" events
        if (githubEvent !== "push") {
            return res.json({ ok: true, message: `Ignored non-push event: ${githubEvent}` });
        }
        const payload = req.body;
        const ref = payload.ref; // e.g. "refs/heads/main"
        const repoFullName = payload.repository?.full_name; // e.g. "owner/name"
        const beforeSha = payload.before;
        const afterSha = payload.after; // Head commit
        if (!repoFullName || !ref) {
            return res.status(400).json({ ok: false, error: "Malformed payload: missing repository or ref" });
        }
        // 3. Find registered MAIN repositories. Multiple RepoSync users can track
        // the same GitHub repo, so each owned repository record gets its own event.
        const mainRepos = await prisma.repository.findMany({
            where: {
                fullName: { equals: repoFullName, mode: "insensitive" },
                role: "MAIN",
                isActive: true,
                userId: { not: null },
            },
        });
        if (mainRepos.length === 0) {
            console.log(`[Webhook Ignored] Repository ${repoFullName} is not a registered, active MAIN repository.`);
            return res.json({ ok: true, message: "Ignored: Repository not registered as MAIN" });
        }
        const matchingRepos = mainRepos.filter((mainRepo) => ref === `refs/heads/${mainRepo.branch}`);
        if (matchingRepos.length === 0) {
            console.log(`[Webhook Ignored] Push to ref ${ref} does not match any tracked branch for ${repoFullName}`);
            return res.json({ ok: true, message: `Ignored: Push was on branch ${ref}` });
        }
        // 6. Gather head commit info from the payload's commits list or head_commit
        const headCommit = payload.head_commit || (payload.commits && payload.commits[0]);
        if (!headCommit) {
            return res.status(400).json({ ok: false, error: "Missing head commit information in push payload" });
        }
        // 7. Get file changes and patches using GitHub Compare API
        // If beforeSha is zero, we compare against headCommit.id^ (or headCommit.id~1).
        const isBaseZero = !beforeSha || beforeSha.match(/^0+$/);
        const baseCommit = isBaseZero ? `${afterSha}~1` : beforeSha;
        const createdPushEvents = [];
        for (const mainRepo of matchingRepos) {
            const existingPush = await prisma.pushEvent.findFirst({
                where: {
                    repositoryId: mainRepo.id,
                    commitSha: afterSha,
                },
            });
            if (existingPush) {
                console.log(`[Webhook Ignored] Commit ${afterSha} already processed for repository record ${mainRepo.id}.`);
                continue;
            }
            let comparisonFiles = [];
            try {
                const comparison = await GithubAppService.compareCommits(mainRepo.installationId, mainRepo.fullName, baseCommit, afterSha);
                comparisonFiles = comparison.files;
            }
            catch (compareError) {
                console.error(`Failed to retrieve git compare diff:`, compareError);
                throw compareError;
            }
            const pushEvent = await prisma.$transaction(async (tx) => {
                let pushedAtDate = new Date();
                if (payload.repository?.pushed_at) {
                    const pushedVal = payload.repository.pushed_at;
                    pushedAtDate = typeof pushedVal === "number" ? new Date(pushedVal * 1000) : new Date(pushedVal);
                }
                else if (headCommit.timestamp) {
                    pushedAtDate = new Date(headCommit.timestamp);
                }
                const event = await tx.pushEvent.create({
                    data: {
                        repositoryId: mainRepo.id,
                        commitSha: afterSha,
                        baseSha: beforeSha,
                        branch: ref.replace("refs/heads/", ""),
                        authorName: headCommit.author?.name || headCommit.committer?.name || "Unknown Author",
                        authorEmail: headCommit.author?.email || headCommit.committer?.email || "unknown@example.com",
                        message: headCommit.message || "No commit message",
                        pushedAt: pushedAtDate,
                        status: "NEW",
                    },
                });
                if (comparisonFiles.length > 0) {
                    await tx.pushFile.createMany({
                        data: comparisonFiles.map((file) => ({
                            pushEventId: event.id,
                            filePath: file.filename,
                            changeType: file.status,
                            patch: file.patch || null,
                            additions: file.additions,
                            deletions: file.deletions,
                        })),
                    });
                }
                return event;
            });
            createdPushEvents.push(pushEvent);
            console.log(`[Webhook Processed] Created PushEvent ID: ${pushEvent.id} for commit: ${afterSha}`);
        }
        if (createdPushEvents.length === 0) {
            return res.json({ ok: true, message: "Ignored: Commit already processed for matching repositories" });
        }
        return res.status(201).json({
            ok: true,
            message: "Webhook processed and push event recorded",
            data: {
                pushEventIds: createdPushEvents.map((event) => event.id),
                commitSha: afterSha,
            },
        });
    }
    catch (error) {
        next(error);
    }
});
//# sourceMappingURL=webhooks.routes.js.map