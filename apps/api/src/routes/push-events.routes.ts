import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { prisma } from "@repo-sync/db";
import { authenticate } from "../middleware/auth.js";
import { AppError } from "../middleware/error-handler.js";
import type { PushStatus } from "@repo-sync/shared";
import { GithubAppService } from "../lib/github-app.js";

export const pushEventsRouter = Router();

// Protect all push events endpoints
pushEventsRouter.use(authenticate);

/**
 * GET /push-events
 * Lists push events, filterable by status, paginated, newest first.
 */
pushEventsRouter.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = req.query.status as PushStatus | undefined;
    const repositoryId = req.query.repositoryId as string | undefined;
    const targetRepoId = req.query.targetRepoId as string | undefined;
    const startDate = req.query.startDate as string | undefined;
    const endDate = req.query.endDate as string | undefined;
    const page = parseInt(req.query.page as string || "1", 10);
    const pageSize = parseInt(req.query.pageSize as string || "10", 10);

    if (isNaN(page) || page < 1) {
      return next(AppError.badRequest("Invalid page query parameter"));
    }
    if (isNaN(pageSize) || pageSize < 1 || pageSize > 100) {
      return next(AppError.badRequest("Invalid pageSize query parameter"));
    }

    const whereClause: any = {
      repository: {
        userId: req.user!.id,
      },
    };
    if (status) {
      if (!["NEW", "TRIAGED", "COMPLETED"].includes(status)) {
        return next(AppError.badRequest("Invalid status query parameter"));
      }
      whereClause.status = status;
    }
    if (repositoryId) {
      whereClause.repositoryId = repositoryId;
    }
    if (targetRepoId) {
      whereClause.syncJobs = {
        some: {
          targetRepoId,
          targetRepo: {
            userId: req.user!.id,
          },
        },
      };
    }
    if (startDate || endDate) {
      whereClause.pushedAt = {};
      if (startDate) {
        whereClause.pushedAt.gte = new Date(startDate);
      }
      if (endDate) {
        const inclusiveEnd = new Date(endDate);
        inclusiveEnd.setHours(23, 59, 59, 999);
        whereClause.pushedAt.lte = inclusiveEnd;
      }
    }

    const [items, total] = await Promise.all([
      prisma.pushEvent.findMany({
        where: whereClause,
        include: {
          repository: true,
          syncJobs: {
            include: {
              targetRepo: true,
              files: true,
            },
            orderBy: {
              createdAt: "desc",
            },
          },
        },
        orderBy: {
          pushedAt: "desc",
        },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.pushEvent.count({
        where: whereClause,
      }),
    ]);

    const totalPages = Math.ceil(total / pageSize);

    res.json({
      ok: true,
      data: {
        items,
        total,
        page,
        pageSize,
        totalPages,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /push-events/:id
 * Fetches detail for a single push event, including files and diff patches.
 */
pushEventsRouter.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;

    const pushEvent = await prisma.pushEvent.findFirst({
      where: {
        id,
        repository: {
          userId: req.user!.id,
        },
      },
      include: {
        repository: true,
        files: true,
      },
    });

    if (!pushEvent) {
      return next(AppError.notFound("Push event not found"));
    }

    let commitFileGroups: Array<{
      sha: string;
      message: string;
      authorName: string;
      date: string;
      files: Array<{
        filePath: string;
        changeType: string;
        additions: number;
        deletions: number;
      }>;
    }> = [];

    if (pushEvent.baseSha !== "HEAD") {
      try {
        const selectedFilePaths = new Set(pushEvent.files.map((file) => file.filePath));
        const branchCommitsResult = await GithubAppService.listCommits(
          pushEvent.repository.installationId,
          pushEvent.repository.fullName,
          pushEvent.branch,
          { pageSize: 50 }
        );
        const branchCommits = branchCommitsResult.items;
        const headIndex = branchCommits.findIndex((commit) => commit.sha === pushEvent.commitSha);

        if (headIndex >= 0) {
          const rangeSummaries = branchCommits.slice(headIndex);

          // Fetch commit details in parallel to optimize initial load time
          const commitDetails = await Promise.all(
            rangeSummaries.map(async (summary) => {
              try {
                const commit = await GithubAppService.getCommit(
                  pushEvent.repository.installationId,
                  pushEvent.repository.fullName,
                  summary.sha
                );
                return { summary, commit };
              } catch (err) {
                console.warn(`[PushEvents] Failed to fetch commit ${summary.sha}:`, err);
                return null;
              }
            })
          );

          for (const item of commitDetails) {
            if (!item) continue;
            const { commit } = item;
            const files = commit.files
              .filter((file) => selectedFilePaths.has(file.filename))
              .map((file) => ({
                filePath: file.filename,
                changeType: file.status,
                additions: file.additions,
                deletions: file.deletions,
              }));

            if (files.length > 0) {
              commitFileGroups.push({
                sha: commit.sha,
                message: commit.message,
                authorName: commit.authorName,
                date: commit.date,
                files,
              });
            }

            if (commit.parentSha === pushEvent.baseSha) {
              break;
            }
          }
        }
      } catch (groupError) {
        console.warn(`[PushEvents] Failed to build commit file groups for ${pushEvent.id}:`, groupError);
      }
    }

    res.json({
      ok: true,
      data: {
        ...pushEvent,
        commitFileGroups,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /push-events/:id/triage
 * Marks a push event as TRIAGED.
 */
pushEventsRouter.post("/:id/triage", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;

    const pushEvent = await prisma.pushEvent.findFirst({
      where: {
        id,
        repository: {
          userId: req.user!.id,
        },
      },
    });

    if (!pushEvent) {
      return next(AppError.notFound("Push event not found"));
    }

    let updatedPushEvent = pushEvent;
    if (pushEvent.status === "NEW") {
      updatedPushEvent = await prisma.pushEvent.update({
        where: { id },
        data: { status: "TRIAGED" },
      });
    }

    res.json({
      ok: true,
      data: updatedPushEvent,
    });
  } catch (error) {
    next(error);
  }
});
