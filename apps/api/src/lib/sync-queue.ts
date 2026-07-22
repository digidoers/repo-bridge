import { prisma } from "@repo-sync/db";
import { GithubAppService } from "./github-app.js";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { config } from "../config.js";

function runGit(args: string[], cwd: string, options: { stdio?: "ignore" | "pipe" } = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: options.stdio === "ignore" ? "ignore" : "pipe",
    maxBuffer: 50 * 1024 * 1024,
  }) as string;
}

function sanitizeBranchPart(value: string) {
  return value.replace(/[^a-zA-Z0-9._/-]/g, "-").replace(/\/+/g, "/").replace(/^-+|-+$/g, "");
}

function safeRepoPath(value: string) {
  const normalized = path.posix.normalize(value.replace(/\\/g, "/"));
  if (normalized.startsWith("../") || normalized === ".." || path.posix.isAbsolute(normalized)) {
    throw new Error("Invalid repository file path.");
  }
  return normalized;
}

function formatGitError(err: any) {
  const stderr = err?.stderr?.toString?.() || "";
  const stdout = err?.stdout?.toString?.() || "";
  const message = err?.message || "";
  const combined = `${stderr}\n${stdout}\n${message}`.trim();

  const lines = combined
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.includes(": trailing whitespace."));

  return lines.join("\n") || "Unknown git error";
}

/**
 * For files that the client repo doesn't have yet (not in working tree),
 * directly check out their final commitSha content using `git checkout <sha> -- <path>`.
 * This places the file in the working tree AND stages it, so it is included in the
 * commit without needing to go through git-apply (which requires the file to already
 * be in the index). Returns the list of paths that were successfully placed.
 */
function placeFilesFromCommit(
  missingPaths: string[],
  commitSha: string,
  targetDir: string
): string[] {
  const placed: string[] = [];
  for (const filePath of missingPaths) {
    try {
      const safePath = safeRepoPath(filePath);
      // git checkout <sha> -- <path> places the file at commitSha into working tree and index
      runGit(["checkout", commitSha, "--", safePath], targetDir);
      placed.push(filePath);
      console.log(`[SyncQueue] Directly placed missing file from commitSha: ${filePath}`);
    } catch {
      // File may have been deleted in commitSha, renamed, or another error — skip it
    }
  }
  return placed;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseUnifiedDiff(diffOutput: string): Map<string, string> {
  const filePatches = new Map<string, string>();
  const parts = diffOutput.split(/^diff --git /gm);

  for (const part of parts) {
    if (!part.trim()) continue;

    const firstNewline = part.indexOf("\n");
    if (firstNewline === -1) continue;
    const headerLine = part.substring(0, firstNewline).trim();

    let filePath = "";
    const quotedMatch = headerLine.match(/^"a\/(.+?)" "b\/.+$/);
    if (quotedMatch) {
      filePath = quotedMatch[1];
      try {
        filePath = JSON.parse(`"${filePath}"`);
      } catch (e) {}
    } else {
      const unquotedMatch = headerLine.match(/^a\/(.+?) b\/.+$/);
      if (unquotedMatch) {
        filePath = unquotedMatch[1];
      }
    }

    if (filePath) {
      filePatches.set(filePath, "diff --git " + part);
    }
  }

  return filePatches;
}

/**
 * Returns only files that exist in the target working tree.
 * Files that don't exist in the client repo are handled separately by
 * placeFilesFromCommit(), which places them directly at their final commitSha
 * state. This avoids the fragile git ls-tree baseSha approach (which can
 * silently fail and cause ALL files to bypass the safety filter).
 */
function getSafeSelectedPaths(selectedPaths: string[], targetDir: string): string[] {
  return selectedPaths.filter(filePath => {
    try {
      return fs.existsSync(path.join(targetDir, safeRepoPath(filePath)));
    } catch {
      return false;
    }
  });
}

type ApplyOptions = {
  autoMerge?: boolean;
};

const RESOLVED_CONTENT_PREFIX = "repo-sync:resolved-content:v1\n";

class SyncQueue {
  private activeJobs = new Set<string>();

  /**
   * Enqueues a sync job to run its dry-run analysis in the background.
   */
  public enqueueDryRun(syncJobId: string) {
    setImmediate(async () => {
      await this.processDryRun(syncJobId);
    });
  }

  private async processDryRun(syncJobId: string) {
    if (this.activeJobs.has(syncJobId)) return;
    this.activeJobs.add(syncJobId);

    console.log(`[SyncQueue] Starting dry-run for SyncJob ${syncJobId}`);

    try {
      // 1. Update status to DRY_RUN_RUNNING
      await prisma.syncJob.update({
        where: { id: syncJobId },
        data: { status: "DRY_RUN_RUNNING" },
      });

      // Fetch job details
      const job = await prisma.syncJob.findUnique({
        where: { id: syncJobId },
        include: {
          pushEvent: {
            include: {
              repository: true,
            },
          },
          targetRepo: true,
          files: true,
        },
      });

      if (!job) {
        console.error(`[SyncQueue] SyncJob ${syncJobId} not found`);
        return;
      }

      if (await GithubAppService.isMockMode()) {
        throw new Error("GitHub App is not configured. Dry-run requires real repository access.");
      }

      await this.runRealDryRun(job);
    } catch (err: any) {
      console.error(`[SyncQueue] Unexpected error in SyncJob ${syncJobId}:`, err);
      await prisma.syncJob.update({
        where: { id: syncJobId },
        data: {
          status: "FAILED",
          errorMessage: err.message || "Unexpected dry-run failure",
        },
      });
    } finally {
      this.activeJobs.delete(syncJobId);
    }
  }

  private async runRealDryRun(job: any) {
    console.log(`[SyncQueue] Running Real Dry-Run for SyncJob ${job.id}`);

    const jobId = job.id;
    const tempDir = path.join(process.cwd(), "temp-jobs", jobId);
    
    try {
      // 1. Create temp directory
      fs.mkdirSync(tempDir, { recursive: true });

      const targetDir = path.join(tempDir, "target");
      const targetRepo = job.targetRepo;
      const mainRepo = job.pushEvent.repository;

      // 2. Get tokens
      const targetToken = await GithubAppService.getInstallationToken(targetRepo.installationId);
      const mainToken = await GithubAppService.getInstallationToken(mainRepo.installationId);

      // 3. Clone target repo
      const targetUrl = `https://x-access-token:${targetToken}@github.com/${targetRepo.fullName}.git`;
      runGit(["clone", "--branch", targetRepo.branch, "--depth", "50", targetUrl, "target"], tempDir, { stdio: "ignore" });

      // 4. Add upstream remote and fetch commits
      const mainUrl = `https://x-access-token:${mainToken}@github.com/${mainRepo.fullName}.git`;
      runGit(["remote", "add", "upstream", mainUrl], targetDir);
      
      const fetchArgs = ["fetch", "upstream"];
      if (job.pushEvent.baseSha !== "HEAD") {
        fetchArgs.push(job.pushEvent.baseSha);
      }
      fetchArgs.push(job.pushEvent.commitSha);
      runGit(fetchArgs, targetDir, { stdio: "ignore" });

      // 5. Build patch file for selected files (dynamically computed if baseSha is HEAD)
      let selectedPaths: string[] = [];
      if (job.pushEvent.baseSha === "HEAD") {
        const diffFilesStr = runGit(["diff", "--name-only", "HEAD", job.pushEvent.commitSha], targetDir);
        selectedPaths = diffFilesStr.split("\n").map(f => f.trim()).filter(Boolean);

        // Delete the placeholder '*' file record from SyncJobFile
        await prisma.syncJobFile.deleteMany({
          where: { syncJobId: job.id }
        });

        // Create the actual file records for this sync job
        if (selectedPaths.length > 0) {
          await prisma.syncJobFile.createMany({
            data: selectedPaths.map(filePath => ({
              syncJobId: job.id,
              filePath,
              mergeResult: "PENDING" as const,
            }))
          });
        }

        if (selectedPaths.length > 0) {
          // Bulk get stats and patches in single git commands instead of spawning for each file
          const numstatOutput = runGit(["diff", "--numstat", "HEAD", job.pushEvent.commitSha], targetDir);
          const statsMap = new Map<string, { additions: number; deletions: number }>();
          const lines = numstatOutput.split("\n");
          for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 3) {
              const additions = parts[0] === "-" ? 0 : parseInt(parts[0], 10) || 0;
              const deletions = parts[1] === "-" ? 0 : parseInt(parts[1], 10) || 0;
              const filePath = parts.slice(2).join(" ");
              statsMap.set(filePath, { additions, deletions });
            }
          }

          const fullDiffOutput = runGit(["diff", "--binary", "HEAD", job.pushEvent.commitSha], targetDir);
          const patchesMap = parseUnifiedDiff(fullDiffOutput);

          // Get existing push files to decide whether to update or create
          const existingPushFiles = await prisma.pushFile.findMany({
            where: {
              pushEventId: job.pushEventId,
              filePath: { in: selectedPaths }
            }
          });
          const existingPushFilesMap = new Map(existingPushFiles.map(pf => [pf.filePath, pf.id]));

          const pushFileOperations = [];
          for (const filePath of selectedPaths) {
            const stats = statsMap.get(filePath) || { additions: 0, deletions: 0 };
            const filePatch = patchesMap.get(filePath) || null;
            const existingId = existingPushFilesMap.get(filePath);

            if (existingId) {
              pushFileOperations.push(
                prisma.pushFile.update({
                  where: { id: existingId },
                  data: {
                    patch: filePatch,
                    additions: stats.additions,
                    deletions: stats.deletions,
                  }
                })
              );
            } else {
              pushFileOperations.push(
                prisma.pushFile.create({
                  data: {
                    pushEventId: job.pushEventId,
                    filePath,
                    changeType: "modified",
                    patch: filePatch,
                    additions: stats.additions,
                    deletions: stats.deletions,
                  }
                })
              );
            }
          }

          // Run push files operations in chunks of 200 via transaction
          if (pushFileOperations.length > 0) {
            const chunkSize = 200;
            for (let i = 0; i < pushFileOperations.length; i += chunkSize) {
              const chunk = pushFileOperations.slice(i, i + chunkSize);
              await prisma.$transaction(chunk);
            }
          }
        }

        // Remove the placeholder '*' from PushFile if it exists
        await prisma.pushFile.deleteMany({
          where: {
            pushEventId: job.pushEventId,
            filePath: "*"
          }
        });

        // Reload files for this job
        job.files = await prisma.syncJobFile.findMany({
          where: { syncJobId: job.id }
        });
      } else {
        selectedPaths = job.files.map((f: any) => f.filePath);
      }

      // Separate files into: those that already exist in the client (patchable)
      // and those that are missing from the client (must be placed directly).
      const safePaths = getSafeSelectedPaths(selectedPaths, targetDir);
      const missingPaths = selectedPaths.filter(p => !safePaths.includes(p));

      // Directly place missing files at their final commitSha state.
      // This avoids "does not exist in index" errors from git apply.
      if (missingPaths.length > 0) {
        console.log(`[SyncQueue] Dry-Run: Placing ${missingPaths.length} missing file(s) directly from commitSha.`);
        placeFilesFromCommit(missingPaths, job.pushEvent.commitSha, targetDir);
      }

      // Build patch only for files that already exist in the client repo.
      const patchFile = path.join(tempDir, "selected.patch");
      let selectedPatch = "";
      if (safePaths.length > 0) {
        selectedPatch = runGit(["diff", "--binary", job.pushEvent.baseSha, job.pushEvent.commitSha, "--", ...safePaths], targetDir);
      }
      fs.writeFileSync(patchFile, selectedPatch);

      // 6. Checkout temporary branch for checking
      runGit(["checkout", "-b", `dry-run-${jobId}`], targetDir);

      // Bulk diff to identify drifted files in target branch compared to baseSha in a single call
      const driftedFiles = new Set<string>();
      try {
        const diffOutput = runGit(["diff", "--name-only", job.pushEvent.baseSha, "HEAD"], targetDir);
        diffOutput.split("\n").map(f => f.trim()).filter(Boolean).forEach(f => driftedFiles.add(f));
      } catch (diffErr) {
        console.error("Failed to run bulk git diff between baseSha and HEAD:", diffErr);
      }

      const mergeResultsByFile = new Map<string, "CLEAN" | "MERGED">();
      for (const jobFile of job.files) {
        const mergeResult = driftedFiles.has(jobFile.filePath) ? "MERGED" : "CLEAN";
        mergeResultsByFile.set(jobFile.filePath, mergeResult);
      }

      // 7. Simulate the exact apply operation used by real merge.
      try {
        runGit(["apply", "--3way", "--whitespace=nowarn", patchFile], targetDir);
      } catch (applyErr) {
        // Ignore here; conflict markers in the temp worktree are inspected below.
      }

      let hasConflict = false;
      const jobFileUpdates = [];

      for (const jobFile of job.files) {
        const filePathOnDisk = path.join(targetDir, jobFile.filePath);
        let mergeResult: "CLEAN" | "MERGED" | "CONFLICT" = mergeResultsByFile.get(jobFile.filePath) || "CLEAN";
        let conflictDiff: string | null = null;

        if (fs.existsSync(filePathOnDisk)) {
          const content = fs.readFileSync(filePathOnDisk, "utf8");
          if (content.includes("<<<<<<<") && content.includes("=======") && content.includes(">>>>>>>")) {
            mergeResult = "CONFLICT";
            hasConflict = true;
            conflictDiff = content;
          }
        }

        jobFileUpdates.push(
          prisma.syncJobFile.update({
            where: { id: jobFile.id },
            data: { mergeResult, conflictDiff },
          })
        );
      }

      // Run database updates in chunks of 200 via transaction
      if (jobFileUpdates.length > 0) {
        const chunkSize = 200;
        for (let i = 0; i < jobFileUpdates.length; i += chunkSize) {
          const chunk = jobFileUpdates.slice(i, i + chunkSize);
          await prisma.$transaction(chunk);
        }
      }

      await prisma.syncJob.update({
        where: { id: jobId },
        data: {
          status: hasConflict ? "CONFLICT" : "CLEAN",
        },
      });

      console.log(`[SyncQueue] Real Dry-Run finished for SyncJob ${jobId}. Status: ${hasConflict ? "CONFLICT" : "CLEAN"}`);
    } finally {
      // 8. Clean up temporary directory
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (rmErr) {
        console.error(`[SyncQueue] Failed to clean up ${tempDir}:`, rmErr);
      }
    }
  }

  // ─── Apply Sync Jobs ──────────────────────────────────

  public enqueueApply(syncJobId: string, options: ApplyOptions = {}) {
    setImmediate(async () => {
      await this.processApply(syncJobId, options);
    });
  }

  public async resolveConflictFile(
    syncJobId: string,
    filePath: string,
    resolvedContent: string
  ) {
    try {
      const job = await prisma.syncJob.findUnique({
        where: { id: syncJobId },
        include: {
          targetRepo: true,
          files: true,
        },
      });

      if (!job) {
        throw new Error("Sync job not found");
      }

      if (job.status !== "CONFLICT" && job.status !== "FAILED") {
        throw new Error(`Only conflicted jobs can be resolved. Current status is ${job.status}.`);
      }

      if (!job.files.some((file: any) => file.filePath === filePath && file.mergeResult === "CONFLICT")) {
        throw new Error("Selected file is not marked as a conflict for this sync job.");
      }

      if (await GithubAppService.isMockMode()) {
        throw new Error("GitHub App is not configured. Conflict resolution requires real repository access.");
      }

      await prisma.syncJobFile.updateMany({
        where: {
          syncJobId,
          filePath,
        },
        data: {
          mergeResult: "MERGED",
          conflictDiff: `${RESOLVED_CONTENT_PREFIX}${resolvedContent}`,
        },
      });

      const remainingConflicts = await prisma.syncJobFile.count({
        where: {
          syncJobId,
          mergeResult: "CONFLICT",
        },
      });

      await prisma.syncJob.update({
        where: { id: syncJobId },
        data: {
          status: remainingConflicts > 0 ? "CONFLICT" : "CLEAN",
          errorMessage: null,
        },
      });
    } catch (err: any) {
      throw err;
    }
  }

  private async processApply(syncJobId: string, options: ApplyOptions = {}) {
    if (this.activeJobs.has(syncJobId)) return;
    this.activeJobs.add(syncJobId);

    console.log(`[SyncQueue] Starting apply for SyncJob ${syncJobId}`);

    try {
      const job = await prisma.syncJob.findUnique({
        where: { id: syncJobId },
        include: {
          pushEvent: {
            include: {
              repository: true,
            },
          },
          targetRepo: true,
          files: true,
        },
      });

      if (!job) {
        console.error(`[SyncQueue] SyncJob ${syncJobId} not found`);
        return;
      }

      const canMergeExistingPr =
        options.autoMerge &&
        Boolean(job.prNumber) &&
        (job.status === "APPLIED" || job.status === "FAILED");

      if (job.status !== "CLEAN" && !canMergeExistingPr) {
        throw new Error(`Only CLEAN sync jobs can be applied. Current status is ${job.status}.`);
      }

      if (await GithubAppService.isMockMode()) {
        throw new Error("GitHub App is not configured. Apply requires real repository access.");
      }

      await prisma.syncJob.update({
        where: { id: syncJobId },
        data: { status: "APPLYING", errorMessage: null },
      });

      if (canMergeExistingPr) {
        await this.mergeExistingPullRequest(job, true);
      } else {
        await this.runRealApply(job, options);
      }
    } catch (err: any) {
      console.error(`[SyncQueue] Unexpected error in SyncJob ${syncJobId}:`, err);
      await prisma.syncJob.update({
        where: { id: syncJobId },
        data: {
          status: err.syncStatus === "CONFLICT" ? "CONFLICT" : "FAILED",
          errorMessage: err.message || "Unexpected apply failure",
        },
      });
    } finally {
      this.activeJobs.delete(syncJobId);
      
      // Rollup PushEvent completion check
      try {
        const job = await prisma.syncJob.findUnique({
          where: { id: syncJobId },
          select: { pushEventId: true },
        });
        if (job) {
          await this.checkPushEventCompletion(job.pushEventId);
        }
      } catch (rollupErr) {
        console.error(`[SyncQueue] Failed to execute PushEvent rollup completion:`, rollupErr);
      }
    }
  }

  private async checkPushEventCompletion(pushEventId: string) {
    // Count jobs that are not in terminal states (APPLIED, CONFLICT, FAILED)
    const activeJobsCount = await prisma.syncJob.count({
      where: {
        pushEventId,
        status: {
          in: ["PENDING", "DRY_RUN_RUNNING", "APPLYING"],
        },
      },
    });

    if (activeJobsCount === 0) {
      await prisma.pushEvent.update({
        where: { id: pushEventId },
        data: { status: "COMPLETED" },
      });
      console.log(`[SyncQueue] PushEvent ${pushEventId} status updated to COMPLETED`);
    }
  }

  private async mergeExistingPullRequest(job: any, required: boolean) {
    const targetRepo = job.targetRepo;
    const targetToken = await GithubAppService.getInstallationToken(targetRepo.installationId);
    const mergeUrl = `https://api.github.com/repos/${targetRepo.fullName}/pulls/${job.prNumber}/merge`;
    const pullUrl = `https://api.github.com/repos/${targetRepo.fullName}/pulls/${job.prNumber}`;
    const headers = {
      "Authorization": `Bearer ${targetToken}`,
      "Accept": "application/vnd.github.v3+json",
      "User-Agent": "Repo-Sync-Bot",
      "Content-Type": "application/json",
    };

    const getPullRequest = async () => {
      try {
        const response = await fetch(pullUrl, { headers });
        if (!response.ok) return null;
        return response.json() as Promise<any>;
      } catch (fetchErr: any) {
        console.warn(`[SyncQueue] Network error fetching PR #${job.prNumber}: ${fetchErr.message}`);
        return null;
      }
    };

    const markMerged = async () => {
      await prisma.syncJob.update({
        where: { id: job.id },
        data: {
          status: "APPLIED",
          errorMessage: null,
        },
      });

      console.log(`[SyncQueue] PR #${job.prNumber} merged for SyncJob ${job.id}.`);
      return true;
    };

    let lastMessage = "";
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const pullBefore = await getPullRequest();
      if (pullBefore?.merged) {
        return markMerged();
      }

      let mergeResponse: Response;
      try {
        mergeResponse = await fetch(mergeUrl, {
          method: "PUT",
          headers,
          body: JSON.stringify({
            merge_method: "squash",
            commit_title: `Merge pull request #${job.prNumber} from ${job.branchName || "repo-sync"}`,
          }),
        });
      } catch (fetchErr: any) {
        lastMessage = `Network error while merging PR #${job.prNumber} for ${targetRepo.fullName}: ${fetchErr?.cause?.message || fetchErr.message || "connection failed"}`;
        await sleep(1200);
        continue;
      }

      if (mergeResponse.ok) {
        return markMerged();
      }

      const errText = await mergeResponse.text();
      lastMessage = `GitHub PR merge failed for #${job.prNumber}: ${errText}`;

      await sleep(1200);
      const pullAfter = await getPullRequest();
      if (pullAfter?.merged) {
        return markMerged();
      }

      const isRetryable = mergeResponse.status === 405 || mergeResponse.status === 409;
      if (!isRetryable) break;
    }

    if (required) {
      throw new Error(lastMessage || `GitHub PR merge failed for #${job.prNumber}.`);
    }

    console.warn(`[SyncQueue] ${lastMessage}`);
    return false;
  }

  private extractConflictHunk(content: string) {
    const lines = content.split("\n");
    const hunkLines: string[] = [];
    let insideConflict = false;

    for (const line of lines) {
      if (line.startsWith("<<<<<<<")) {
        insideConflict = true;
      }
      if (insideConflict) {
        hunkLines.push(line);
      }
      if (line.startsWith(">>>>>>>")) {
        insideConflict = false;
      }
    }

    return hunkLines.join("\n");
  }

  private async recordApplyConflicts(job: any, targetDir: string) {
    let hasConflict = false;

    for (const jobFile of job.files) {
      const filePathOnDisk = path.join(targetDir, jobFile.filePath);
      if (!fs.existsSync(filePathOnDisk)) continue;

      const content = fs.readFileSync(filePathOnDisk, "utf8");
      const isConflict = content.includes("<<<<<<<") && content.includes("=======") && content.includes(">>>>>>>");
      if (!isConflict) continue;

      hasConflict = true;
      await prisma.syncJobFile.update({
        where: { id: jobFile.id },
        data: {
          mergeResult: "CONFLICT",
          conflictDiff: content,
        },
      });
    }

    return hasConflict;
  }

  private applySavedResolvedFiles(job: any, targetDir: string) {
    let appliedAny = false;

    for (const jobFile of job.files) {
      if (
        jobFile.mergeResult !== "MERGED" ||
        typeof jobFile.conflictDiff !== "string" ||
        !jobFile.conflictDiff.startsWith(RESOLVED_CONTENT_PREFIX)
      ) {
        continue;
      }

      const safePath = safeRepoPath(jobFile.filePath);
      const filePathOnDisk = path.join(targetDir, safePath);
      fs.mkdirSync(path.dirname(filePathOnDisk), { recursive: true });
      fs.writeFileSync(filePathOnDisk, jobFile.conflictDiff.slice(RESOLVED_CONTENT_PREFIX.length));
      appliedAny = true;
    }

    return appliedAny;
  }

  private async runRealApply(job: any, options: ApplyOptions = {}) {
    console.log(`[SyncQueue] Running Real Apply for SyncJob ${job.id}`);

    const jobId = job.id;
    const tempDir = path.join(process.cwd(), "temp-jobs", `apply-${jobId}`);
    
    try {
      // 1. Create fresh temp directory
      fs.mkdirSync(tempDir, { recursive: true });

      const targetRepo = job.targetRepo;
      const mainRepo = job.pushEvent.repository;
      const targetDir = path.join(tempDir, "target");

      // 2. Get tokens
      const targetToken = await GithubAppService.getInstallationToken(targetRepo.installationId);
      const mainToken = await GithubAppService.getInstallationToken(mainRepo.installationId);

      // 3. Clone target repo fresh
      const targetUrl = `https://x-access-token:${targetToken}@github.com/${targetRepo.fullName}.git`;
      runGit(["clone", "--branch", targetRepo.branch, "--depth", "50", targetUrl, "target"], tempDir, { stdio: "ignore" });

      // 4. Add upstream remote and fetch commits
      const mainUrl = `https://x-access-token:${mainToken}@github.com/${mainRepo.fullName}.git`;
      runGit(["remote", "add", "upstream", mainUrl], targetDir);
      
      const fetchArgs = ["fetch", "upstream"];
      if (job.pushEvent.baseSha !== "HEAD") {
        fetchArgs.push(job.pushEvent.baseSha);
      }
      fetchArgs.push(job.pushEvent.commitSha);
      runGit(fetchArgs, targetDir, { stdio: "ignore" });

      // 5. Build patch file for selected files only
      const patchFile = path.join(tempDir, "selected.patch");
      const selectedPaths = job.files.map((f: any) => f.filePath);

      // Separate files into: those that already exist in the client (patchable)
      // and those that are missing from the client (must be placed directly).
      const safePaths = getSafeSelectedPaths(selectedPaths, targetDir);
      const missingPaths = selectedPaths.filter((p: string) => !safePaths.includes(p));

      // Directly place missing files at their final commitSha state.
      // This avoids "does not exist in index" errors from git apply.
      if (missingPaths.length > 0) {
        console.log(`[SyncQueue] Apply: Placing ${missingPaths.length} missing file(s) directly from commitSha.`);
        placeFilesFromCommit(missingPaths, job.pushEvent.commitSha, targetDir);
      }

      // Build patch only for files that already exist in the client repo.
      let selectedPatch = "";
      if (safePaths.length > 0) {
        selectedPatch = runGit(["diff", "--binary", job.pushEvent.baseSha, job.pushEvent.commitSha, "--", ...safePaths], targetDir);
      }
      fs.writeFileSync(patchFile, selectedPatch);

      if (selectedPatch.trim().length === 0) {
        await prisma.syncJobFile.updateMany({
          where: { syncJobId: jobId },
          data: {
            mergeResult: "CLEAN",
            conflictDiff: null,
          },
        });

        await prisma.syncJob.update({
          where: { id: jobId },
          data: {
            status: "APPLIED",
            branchName: null,
            prUrl: null,
            prNumber: null,
            errorMessage: "Already up to date",
          },
        });

        console.log(`[SyncQueue] Real Apply skipped for SyncJob ${jobId}. Empty patch; already up to date.`);
        return;
      }

      // 6. Create sync branch
      const shortSha = job.pushEvent.commitSha.substring(0, 7);
      const branchName = sanitizeBranchPart(`sync/main-${shortSha}-${jobId.substring(0, 8)}`);
      runGit(["checkout", "-b", branchName], targetDir);

      // Save branchName in DB immediately so that subsequent commit/push/PR errors
      // are correctly recognized as apply stage failures in the UI.
      await prisma.syncJob.update({
        where: { id: jobId },
        data: { branchName },
      });

      // 7. Apply patch. If the user saved conflict resolutions, those files
      // override the patch result before we stage and commit.
      try {
        runGit(["apply", "--3way", "--whitespace=nowarn", patchFile], targetDir);
        this.applySavedResolvedFiles(job, targetDir);
        runGit(["add", "-A"], targetDir);
      } catch (applyErr) {
        const usedSavedResolutions = this.applySavedResolvedFiles(job, targetDir);
        if (usedSavedResolutions) {
          const hasRemainingConflict = await this.recordApplyConflicts(job, targetDir);
          if (!hasRemainingConflict) {
            runGit(["add", "-A"], targetDir);
          } else {
            throw Object.assign(
              new Error(`Git apply patch failed: ${formatGitError(applyErr)}`),
              { syncStatus: "CONFLICT" }
            );
          }
        } else {
          const hasConflict = await this.recordApplyConflicts(job, targetDir);
          throw Object.assign(
            new Error(`Git apply patch failed: ${formatGitError(applyErr)}`),
            { syncStatus: hasConflict ? "CONFLICT" : "FAILED" }
          );
        }
      }

      let hasStagedChanges = true;
      try {
        runGit(["diff", "--cached", "--quiet"], targetDir);
        hasStagedChanges = false;
      } catch (diffErr: any) {
        if (diffErr?.status !== 1) {
          throw diffErr;
        }
      }

      if (!hasStagedChanges) {
        await prisma.syncJobFile.updateMany({
          where: { syncJobId: jobId },
          data: {
            mergeResult: "CLEAN",
            conflictDiff: null,
          },
        });

        await prisma.syncJob.update({
          where: { id: jobId },
          data: {
            status: "APPLIED",
            branchName: null,
            prUrl: null,
            prNumber: null,
            errorMessage: "Already up to date",
          },
        });

        console.log(`[SyncQueue] Real Apply skipped for SyncJob ${jobId}. Already up to date.`);
        return;
      }

      // 8. Commit
      const commitMsg = `Sync from main @ ${shortSha}: ${job.pushEvent.message}`;
      runGit(["-c", "user.name=Sync Bot", "-c", "user.email=sync-bot@yourcompany.com", "commit", "-m", commitMsg], targetDir);

      // 9. Push branch
      try {
        runGit(["push", "origin", branchName], targetDir, { stdio: "pipe" });
      } catch (pushErr: any) {
        let errMsg = pushErr.stderr?.toString() || pushErr.message || "Unknown push error";
        if (targetToken) errMsg = errMsg.replaceAll(targetToken, "***");
        if (mainToken) errMsg = errMsg.replaceAll(mainToken, "***");

        if (
          errMsg.includes("refusing to allow a GitHub App to create or update workflow") &&
          errMsg.includes("workflows")
        ) {
          throw new Error(
            `Git push rejected: The sync modified a GitHub Actions workflow file, but your GitHub App installation is missing the 'Workflows' read/write permission. Please grant the 'Workflows' permission to your GitHub App in its developer settings on GitHub, or exclude workflow files from this sync.\n\nDetails: ${errMsg.trim()}`
          );
        }
        throw new Error(`Git push failed: ${errMsg.trim()}`);
      }

      // 10. Open Pull Request via GitHub REST API
      const fileListMarkdown = job.files.map((f: any) => `- \`${f.filePath}\``).join("\n");
      const linkBack = `[Push Event Detail](${config.webUrl}/dashboard/push-events/${job.pushEventId})`;
      const prBody = `Automated sync from main repository.\n\nSynced files:\n${fileListMarkdown}\n\nLink to original push: ${linkBack}`;

      const pullsUrl = `https://api.github.com/repos/${targetRepo.fullName}/pulls`;
      let prResponse: Response;
      try {
        prResponse = await fetch(pullsUrl, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${targetToken}`,
            "Accept": "application/vnd.github.v3+json",
            "User-Agent": "Repo-Sync-Bot",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            title: commitMsg,
            head: branchName,
            base: targetRepo.branch,
            body: prBody,
          }),
        });
      } catch (fetchErr: any) {
        throw new Error(`Network error while creating Pull Request for ${targetRepo.fullName}: ${fetchErr?.cause?.message || fetchErr.message || "connection failed"}`);
      }

      if (!prResponse.ok) {
        const errText = await prResponse.text();
        throw new Error(`Failed to create Pull Request: ${errText}`);
      }

      const prJson = (await prResponse.json()) as any;
      const prUrl = prJson.html_url;
      const prNumber = prJson.number;

      await prisma.syncJob.update({
        where: { id: jobId },
        data: {
          branchName,
          prUrl,
          prNumber,
        },
      });

      // 11. Optionally auto-merge the Pull Request
      const shouldMerge = options.autoMerge || targetRepo.autoMergeEnabled;
      let mergeWarning: string | null = null;
      if (shouldMerge) {
        try {
          await this.mergeExistingPullRequest(
            { ...job, prNumber, branchName, targetRepo },
            Boolean(options.autoMerge)
          );
        } catch (mergeErr: any) {
          // PR was created but merge failed — still mark as APPLIED so the
          // user can merge the PR manually on GitHub, instead of marking the
          // entire job as FAILED which is misleading.
          console.warn(`[SyncQueue] PR #${prNumber} created but auto-merge failed for SyncJob ${jobId}:`, mergeErr);
          mergeWarning = `PR #${prNumber} created but auto-merge failed: ${mergeErr?.cause?.message || mergeErr.message || "merge request failed"}. Merge the PR manually on GitHub.`;
        }
      }

      await prisma.syncJobFile.updateMany({
        where: { syncJobId: jobId },
        data: { conflictDiff: null },
      });

      // 12. Save results
      await prisma.syncJob.update({
        where: { id: jobId },
        data: {
          status: "APPLIED",
          branchName,
          prUrl,
          prNumber,
          errorMessage: mergeWarning,
        },
      });

      console.log(`[SyncQueue] Real Apply finished for SyncJob ${jobId}. PR #${prNumber} created.`);
    } finally {
      // 13. Clean up temporary directory
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (rmErr) {
        console.error(`[SyncQueue] Failed to clean up ${tempDir}:`, rmErr);
      }
    }
  }

}

export const syncQueue = new SyncQueue();
