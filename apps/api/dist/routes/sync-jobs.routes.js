import { Router } from "express";
import { prisma } from "@repo-sync/db";
import { authenticate } from "../middleware/auth.js";
import { AppError } from "../middleware/error-handler.js";
import { syncQueue } from "../lib/sync-queue.js";
import { GithubAppService } from "../lib/github-app.js";
export const syncJobsRouter = Router();
// Protect all routes
syncJobsRouter.use(authenticate);
/**
 * POST /manual-sync
 * Creates a PushEvent from a selected main-repo commit and starts dry-run jobs
 * for selected child repositories/files.
 */
syncJobsRouter.post("/manual-sync", async (req, res, next) => {
    try {
        const { mainRepoId, targetRepoIds, commitSha, commitShas, filePaths, syncMode, baseBranch, compareBranch, } = req.body;
        const isBranchSync = syncMode === "branch";
        if (!mainRepoId) {
            return next(AppError.badRequest("mainRepoId is required"));
        }
        if (isBranchSync) {
            if (!compareBranch) {
                return next(AppError.badRequest("compareBranch is required for branch sync"));
            }
        }
        else {
            const selectedCommitShas = Array.from(new Set(commitShas?.length ? commitShas : commitSha ? [commitSha] : []));
            if (selectedCommitShas.length === 0) {
                return next(AppError.badRequest("At least one commit is required"));
            }
        }
        if (!Array.isArray(targetRepoIds) || targetRepoIds.length === 0) {
            return next(AppError.badRequest("Select at least one child repository"));
        }
        if (!Array.isArray(filePaths) || filePaths.length === 0) {
            return next(AppError.badRequest("Select at least one file"));
        }
        const mainRepo = await prisma.repository.findFirst({
            where: {
                id: mainRepoId,
                userId: req.user.id,
            },
        });
        if (!mainRepo || mainRepo.role !== "MAIN" || !mainRepo.isActive) {
            return next(AppError.badRequest("Main repository must be an active MAIN repository"));
        }
        const targetRepos = await prisma.repository.findMany({
            where: {
                id: { in: targetRepoIds },
                userId: req.user.id,
                role: "CLIENT",
                isActive: true,
            },
        });
        if (targetRepos.length !== targetRepoIds.length) {
            return next(AppError.badRequest("Every selected child repository must be active and registered"));
        }
        let baseSha;
        let headSha;
        let authorName;
        let authorEmail;
        let date;
        let newestCommitMessage;
        let message;
        const filesByPath = new Map();
        if (isBranchSync) {
            const branchTip = await GithubAppService.getCommit(mainRepo.installationId, mainRepo.fullName, compareBranch);
            baseSha = "HEAD";
            headSha = branchTip.sha;
            authorName = branchTip.authorName;
            authorEmail = branchTip.authorEmail;
            date = branchTip.date;
            newestCommitMessage = branchTip.message;
            message = `Branch sync: ${compareBranch} - ${newestCommitMessage.split("\n")[0]}`;
        }
        else {
            const selectedCommitShas = Array.from(new Set(commitShas?.length ? commitShas : commitSha ? [commitSha] : []));
            const branchCommits = [];
            let commitsPage = 1;
            let hasNextCommitPage = true;
            while (hasNextCommitPage && commitsPage <= 20) {
                const pageResult = await GithubAppService.listCommits(mainRepo.installationId, mainRepo.fullName, mainRepo.branch, { page: commitsPage, pageSize: 50 });
                branchCommits.push(...pageResult.items);
                hasNextCommitPage = pageResult.hasNextPage;
                commitsPage += 1;
                if (selectedCommitShas.every((sha) => branchCommits.some((commit) => commit.sha === sha))) {
                    break;
                }
            }
            // Filter out commits that do not exist in the branch
            const validCommitShas = selectedCommitShas.filter((sha) => branchCommits.some((commit) => commit.sha === sha));
            if (validCommitShas.length === 0) {
                return next(AppError.badRequest("None of the selected commits exist in the configured main branch commit list"));
            }
            const selectedIndexes = validCommitShas.map((sha) => branchCommits.findIndex((commit) => commit.sha === sha));
            const newestIndex = Math.min(...selectedIndexes);
            const oldestIndex = Math.max(...selectedIndexes);
            const rangeCommits = branchCommits.slice(newestIndex, oldestIndex + 1);
            const rangeCommitShas = rangeCommits.map((commit) => commit.sha);
            if (rangeCommitShas.length !== validCommitShas.length || !rangeCommitShas.every((sha) => validCommitShas.includes(sha))) {
                return next(AppError.badRequest("Selected commits must be contiguous. Select every commit between the oldest and newest commit."));
            }
            const newestCommit = await GithubAppService.getCommit(mainRepo.installationId, mainRepo.fullName, rangeCommits[0].sha);
            const oldestCommit = await GithubAppService.getCommit(mainRepo.installationId, mainRepo.fullName, rangeCommits[rangeCommits.length - 1].sha);
            baseSha = oldestCommit.parentSha;
            headSha = newestCommit.sha;
            authorName = newestCommit.authorName;
            authorEmail = newestCommit.authorEmail;
            date = newestCommit.date;
            newestCommitMessage = newestCommit.message;
            message = rangeCommits.length === 1
                ? newestCommitMessage
                : `Manual sync range: ${rangeCommits.length} commits from ${oldestCommit.sha.substring(0, 7)} to ${newestCommit.sha.substring(0, 7)}`;
            for (const summary of rangeCommits) {
                const commit = await GithubAppService.getCommit(mainRepo.installationId, mainRepo.fullName, summary.sha);
                for (const file of commit.files) {
                    const existing = filesByPath.get(file.filename);
                    filesByPath.set(file.filename, {
                        filename: file.filename,
                        status: existing?.status || file.status,
                        patch: existing?.patch || file.patch,
                        additions: (existing?.additions || 0) + file.additions,
                        deletions: (existing?.deletions || 0) + file.deletions,
                    });
                }
            }
        }
        let selectedFiles = [];
        let selectedCommitFiles = [];
        if (isBranchSync) {
            selectedFiles = ["*"];
            selectedCommitFiles = [{
                    filename: "*",
                    status: "modified",
                    patch: "",
                    additions: 0,
                    deletions: 0,
                }];
        }
        else {
            selectedFiles = Array.from(new Set(filePaths));
            const validFilePaths = new Set(filesByPath.keys());
            const invalidFiles = selectedFiles.filter((filePath) => !validFilePaths.has(filePath));
            if (invalidFiles.length > 0) {
                return next(AppError.badRequest(`Selected files are not part of the selected commit range: ${invalidFiles.join(", ")}`));
            }
            selectedCommitFiles = selectedFiles
                .map((filePath) => filesByPath.get(filePath))
                .filter((file) => Boolean(file));
        }
        const pushEvent = await prisma.$transaction(async (tx) => {
            const existing = await tx.pushEvent.findFirst({
                where: {
                    repositoryId: mainRepo.id,
                    commitSha: headSha,
                },
            });
            const event = existing
                ? await tx.pushEvent.update({
                    where: { id: existing.id },
                    data: {
                        repositoryId: mainRepo.id,
                        baseSha,
                        branch: isBranchSync ? compareBranch : mainRepo.branch,
                        authorName,
                        authorEmail,
                        message,
                        pushedAt: new Date(date),
                        status: "TRIAGED",
                    },
                })
                : await tx.pushEvent.create({
                    data: {
                        repositoryId: mainRepo.id,
                        commitSha: headSha,
                        baseSha,
                        branch: isBranchSync ? compareBranch : mainRepo.branch,
                        authorName,
                        authorEmail,
                        message,
                        pushedAt: new Date(date),
                        status: "TRIAGED",
                    },
                });
            await tx.pushFile.deleteMany({
                where: { pushEventId: event.id },
            });
            await tx.pushFile.createMany({
                data: selectedCommitFiles.map((file) => ({
                    pushEventId: event.id,
                    filePath: file.filename,
                    changeType: file.status,
                    patch: file.patch || null,
                    additions: file.additions,
                    deletions: file.deletions,
                })),
            });
            return tx.pushEvent.findUniqueOrThrow({
                where: { id: event.id },
                include: { files: true },
            });
        });
        await prisma.$transaction(async (tx) => {
            await tx.syncJobFile.deleteMany({
                where: {
                    syncJob: {
                        pushEventId: pushEvent.id,
                        status: { not: "APPLIED" },
                    },
                },
            });
            await tx.syncJob.deleteMany({
                where: {
                    pushEventId: pushEvent.id,
                    status: { not: "APPLIED" },
                },
            });
        });
        const createdJobs = [];
        for (const targetRepo of targetRepos) {
            const syncJob = await prisma.syncJob.create({
                data: {
                    pushEventId: pushEvent.id,
                    targetRepoId: targetRepo.id,
                    status: "PENDING",
                    files: {
                        create: selectedFiles.map((filePath) => ({
                            filePath,
                            mergeResult: "PENDING",
                        })),
                    },
                },
                include: {
                    targetRepo: true,
                    files: true,
                },
            });
            createdJobs.push(syncJob);
            syncQueue.enqueueDryRun(syncJob.id);
        }
        res.status(201).json({
            ok: true,
            data: {
                pushEvent,
                syncJobs: createdJobs,
            },
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * POST /push-events/:id/sync-jobs
 * Creates one SyncJob (and corresponding SyncJobFiles) per target repository.
 * Enqueues dry-run analysis for each job in the background worker queue.
 */
syncJobsRouter.post("/push-events/:id/sync-jobs", async (req, res, next) => {
    try {
        const pushEventId = req.params.id;
        const { targetRepoIds, filesByRepo } = req.body;
        if (!targetRepoIds || !Array.isArray(targetRepoIds) || targetRepoIds.length === 0) {
            return next(AppError.badRequest("targetRepoIds must be a non-empty array"));
        }
        if (!filesByRepo || typeof filesByRepo !== "object") {
            return next(AppError.badRequest("filesByRepo must be an object specifying files per repository"));
        }
        // Verify push event exists
        const pushEvent = await prisma.pushEvent.findFirst({
            where: {
                id: pushEventId,
                repository: {
                    userId: req.user.id,
                },
            },
        });
        if (!pushEvent) {
            return next(AppError.notFound("Push event not found"));
        }
        const pushFiles = await prisma.pushFile.findMany({
            where: { pushEventId },
            select: { filePath: true },
        });
        const validFilePaths = new Set(pushFiles.map((file) => file.filePath));
        const createdJobs = [];
        // Create jobs in a database transaction to ensure transactional consistency
        for (const targetRepoId of targetRepoIds) {
            const selectedFiles = Array.from(new Set(filesByRepo[targetRepoId] || []));
            if (!selectedFiles || !Array.isArray(selectedFiles) || selectedFiles.length === 0) {
                return next(AppError.badRequest(`No files selected for repository ${targetRepoId}`));
            }
            const invalidFiles = selectedFiles.filter((filePath) => !validFilePaths.has(filePath));
            if (invalidFiles.length > 0) {
                return next(AppError.badRequest(`Repository ${targetRepoId} selected files that are not part of this push event: ${invalidFiles.join(", ")}`));
            }
            // Verify target repo exists and is client
            const targetRepo = await prisma.repository.findFirst({
                where: {
                    id: targetRepoId,
                    userId: req.user.id,
                },
            });
            if (!targetRepo) {
                return next(AppError.notFound(`Target repository ${targetRepoId} not found`));
            }
            if (targetRepo.role !== "CLIENT" || !targetRepo.isActive) {
                return next(AppError.badRequest(`Target repository ${targetRepo.fullName} must be an active CLIENT repository`));
            }
            // Create SyncJob and SyncJobFiles
            const syncJob = await prisma.syncJob.create({
                data: {
                    pushEventId,
                    targetRepoId,
                    status: "PENDING",
                    files: {
                        create: selectedFiles.map((filePath) => ({
                            filePath,
                            mergeResult: "PENDING",
                        })),
                    },
                },
                include: {
                    files: true,
                    targetRepo: true,
                },
            });
            createdJobs.push(syncJob);
            // Enqueue background dry run
            syncQueue.enqueueDryRun(syncJob.id);
        }
        res.status(201).json({
            ok: true,
            data: createdJobs,
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * GET /push-events/:id/sync-jobs
 * Lists all sync jobs created for a push event, including target repo metadata.
 */
syncJobsRouter.get("/push-events/:id/sync-jobs", async (req, res, next) => {
    try {
        const pushEventId = req.params.id;
        const pushEvent = await prisma.pushEvent.findFirst({
            where: {
                id: pushEventId,
                repository: {
                    userId: req.user.id,
                },
            },
        });
        if (!pushEvent) {
            return next(AppError.notFound("Push event not found"));
        }
        const syncJobs = await prisma.syncJob.findMany({
            where: {
                pushEventId,
                pushEvent: {
                    repository: {
                        userId: req.user.id,
                    },
                },
            },
            include: {
                targetRepo: true,
                files: true,
            },
            orderBy: {
                createdAt: "desc",
            },
        });
        res.json({
            ok: true,
            data: syncJobs,
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * GET /sync-jobs/:id
 * Fetches full details for a sync job, including files, merge results, and conflict diffs.
 */
syncJobsRouter.get("/sync-jobs/:id", async (req, res, next) => {
    try {
        const id = req.params.id;
        const syncJob = await prisma.syncJob.findFirst({
            where: {
                id,
                pushEvent: {
                    repository: {
                        userId: req.user.id,
                    },
                },
            },
            include: {
                targetRepo: true,
                pushEvent: {
                    include: {
                        repository: true,
                    },
                },
                files: true,
            },
        });
        if (!syncJob) {
            return next(AppError.notFound("Sync job not found"));
        }
        res.json({
            ok: true,
            data: syncJob,
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * POST /sync-jobs/:id/retry-dry-run
 * Retries a sync job dry-run analysis.
 */
syncJobsRouter.post("/sync-jobs/:id/retry-dry-run", async (req, res, next) => {
    try {
        const id = req.params.id;
        const syncJob = await prisma.syncJob.findFirst({
            where: {
                id,
                pushEvent: {
                    repository: {
                        userId: req.user.id,
                    },
                },
            },
        });
        if (!syncJob) {
            return next(AppError.notFound("Sync job not found"));
        }
        // Reset status to PENDING and clean any previous error message
        const updatedSyncJob = await prisma.syncJob.update({
            where: { id },
            data: {
                status: "PENDING",
                errorMessage: null,
            },
        });
        // Reset all files back to PENDING mergeResult
        await prisma.syncJobFile.updateMany({
            where: { syncJobId: id },
            data: {
                mergeResult: "PENDING",
                conflictDiff: null,
            },
        });
        // Re-enqueue dry run
        syncQueue.enqueueDryRun(id);
        res.json({
            ok: true,
            data: updatedSyncJob,
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * POST /sync-jobs/:id/resolve-conflict
 * Saves one conflicted file's resolved content for the next merge attempt.
 */
syncJobsRouter.post("/sync-jobs/:id/resolve-conflict", async (req, res, next) => {
    try {
        const id = req.params.id;
        const { filePath, resolvedContent } = req.body;
        if (!filePath || typeof filePath !== "string") {
            return next(AppError.badRequest("filePath is required"));
        }
        if (typeof resolvedContent !== "string") {
            return next(AppError.badRequest("resolvedContent is required"));
        }
        const ownedSyncJob = await prisma.syncJob.findFirst({
            where: {
                id,
                pushEvent: {
                    repository: {
                        userId: req.user.id,
                    },
                },
            },
            select: { id: true },
        });
        if (!ownedSyncJob) {
            return next(AppError.notFound("Sync job not found"));
        }
        await syncQueue.resolveConflictFile(id, filePath, resolvedContent);
        const updatedSyncJob = await prisma.syncJob.findFirst({
            where: {
                id,
                pushEvent: {
                    repository: {
                        userId: req.user.id,
                    },
                },
            },
            include: {
                targetRepo: true,
                files: true,
            },
        });
        if (!updatedSyncJob) {
            return next(AppError.notFound("Sync job not found"));
        }
        res.json({
            ok: true,
            data: updatedSyncJob,
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * POST /push-events/:id/apply
 * Merges a list of CLEAN SyncJobs in the background.
 */
syncJobsRouter.post("/push-events/:id/apply", async (req, res, next) => {
    try {
        const pushEventId = req.params.id;
        const { syncJobIds, autoMerge } = req.body;
        if (!syncJobIds || !Array.isArray(syncJobIds) || syncJobIds.length === 0) {
            return next(AppError.badRequest("syncJobIds must be a non-empty array"));
        }
        const pushEvent = await prisma.pushEvent.findFirst({
            where: {
                id: pushEventId,
                repository: {
                    userId: req.user.id,
                },
            },
        });
        if (!pushEvent) {
            return next(AppError.notFound("Push event not found"));
        }
        const enqueuedJobs = [];
        for (const jobId of syncJobIds) {
            const job = await prisma.syncJob.findFirst({
                where: {
                    id: jobId,
                    pushEvent: {
                        repository: {
                            userId: req.user.id,
                        },
                    },
                },
                include: {
                    targetRepo: true,
                    files: true,
                },
            });
            if (!job) {
                return next(AppError.notFound(`Sync job ${jobId} not found`));
            }
            if (job.pushEventId !== pushEventId) {
                return next(AppError.badRequest(`Sync job ${jobId} is not linked to this push event`));
            }
            const canApply = job.status === "CLEAN";
            const canMergeExistingPr = Boolean(autoMerge &&
                job.prNumber &&
                (job.status === "APPLIED" || job.status === "FAILED"));
            if (!canApply && !canMergeExistingPr) {
                return next(AppError.badRequest(`Sync job ${jobId} is ${job.status}; only CLEAN jobs can be merged`));
            }
            if (!job.targetRepo.isActive || job.targetRepo.role !== "CLIENT") {
                return next(AppError.badRequest(`Sync job ${jobId} target must be an active CLIENT repository`));
            }
            if (job.files.length === 0) {
                return next(AppError.badRequest(`Sync job ${jobId} has no selected files`));
            }
            // Enqueue job execution
            syncQueue.enqueueApply(jobId, { autoMerge });
            enqueuedJobs.push(job);
        }
        res.json({
            ok: true,
            data: enqueuedJobs,
        });
    }
    catch (error) {
        next(error);
    }
});
/**
 * GET /sync-jobs/:id/status
 * Lightweight polling status endpoint.
 */
syncJobsRouter.get("/sync-jobs/:id/status", async (req, res, next) => {
    try {
        const id = req.params.id;
        const job = await prisma.syncJob.findFirst({
            where: {
                id,
                pushEvent: {
                    repository: {
                        userId: req.user.id,
                    },
                },
            },
            select: {
                id: true,
                status: true,
                prUrl: true,
                prNumber: true,
                errorMessage: true,
            },
        });
        if (!job) {
            return next(AppError.notFound("Sync job not found"));
        }
        res.json({
            ok: true,
            data: job,
        });
    }
    catch (error) {
        next(error);
    }
});
//# sourceMappingURL=sync-jobs.routes.js.map