import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { prisma } from "@repo-sync/db";
import { authenticate } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { registerRepoSchema, updateRepoSchema } from "./repos.schemas.js";
import type { RegisterRepoInput, UpdateRepoInput } from "./repos.schemas.js";
import { GithubAppService } from "../lib/github-app.js";
import type { GithubAppRepo } from "../lib/github-app.js";
import { AppError } from "../middleware/error-handler.js";
import { decrypt } from "../lib/encryption.js";

export const reposRouter = Router();

// Protect all repository endpoints
reposRouter.use(authenticate);

// ─────────────────────────────────────────────────────────
// GET /repos/installable
// ─────────────────────────────────────────────────────────
reposRouter.get(
  "/installable",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.user!.id },
        select: { githubToken: true },
      });

      let installable: GithubAppRepo[];
      if (user?.githubToken) {
        const token = decrypt(user.githubToken);
        installable = (await GithubAppService.getAccountRepositories(token))
          .filter((repo) => repo.appInstalled && repo.installationId)
          .map((repo) => ({
            githubOwner: repo.githubOwner,
            githubName: repo.githubName,
            fullName: repo.fullName,
            installationId: repo.installationId!,
          }));
      } else {
        installable = [];
      }

      // Only hide repositories that are currently active. Inactive repos should
      // be selectable again so users can reactivate them.
      const registered = await prisma.repository.findMany({
        where: { userId: req.user!.id, isActive: true },
        select: { fullName: true },
      });
      const registeredNames = new Set(registered.map((r) => r.fullName.toLowerCase()));

      // Filter out repositories that are already actively registered in our database
      const filtered = installable.filter(
        (r) => !registeredNames.has(r.fullName.toLowerCase())
      );

      res.json({ ok: true, data: filtered });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────
// GET /repos/github-setup
// ─────────────────────────────────────────────────────────
reposRouter.get(
  "/github-setup",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const appConfigured = !(await GithubAppService.isMockMode());
      let installableCount = 0;

      if (appConfigured) {
        const user = await prisma.user.findUnique({
          where: { id: req.user!.id },
          select: { githubToken: true },
        });

        if (user?.githubToken) {
          const token = decrypt(user.githubToken);
          installableCount = (await GithubAppService.getAccountRepositories(token))
            .filter((repo) => repo.appInstalled)
            .length;
        }
      }

      res.json({
        ok: true,
        data: {
          githubLinked: !!req.user?.githubLogin,
          githubLogin: req.user?.githubLogin || null,
          appConfigured,
          appInstallUrl: await GithubAppService.getAppInstallUrl(),
          installableCount,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────
// GET /repos/github-account/:owner/:repo/branches
// ─────────────────────────────────────────────────────────
reposRouter.get(
  "/github-account/:owner/:repo/branches",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.user!.id },
        select: { githubToken: true },
      });

      const fullName = `${req.params.owner}/${req.params.repo}`;

      if (!user?.githubToken) {
        throw AppError.badRequest("Connect your GitHub account before loading repository branches.");
      }

      const token = decrypt(user.githubToken);
      const branches = await GithubAppService.listAccountBranches(token, fullName);

      res.json({ ok: true, data: branches });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────
// GET /repos/github-account
// ─────────────────────────────────────────────────────────
reposRouter.get(
  "/github-account",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.user!.id },
        select: { githubToken: true },
      });

      if (!user?.githubToken) {
        throw AppError.badRequest("Connect your GitHub account before browsing account repositories.");
      }

      if (await GithubAppService.isMockMode()) {
        throw AppError.badRequest("Configure the GitHub App before browsing real account repositories.");
      }

      const token = decrypt(user.githubToken);
      const repos = await GithubAppService.getAccountRepositories(token);

      res.json({ ok: true, data: repos });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────
// GET /repos
// ─────────────────────────────────────────────────────────
reposRouter.get(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { role, activeOnly } = req.query;

      const where: any = {};
      where.userId = req.user!.id;

      if (role === "MAIN" || role === "CLIENT") {
        where.role = role;
      }

      // Default to active-only unless specified otherwise
      if (activeOnly !== "false") {
        where.isActive = true;
      }

      const repos = await prisma.repository.findMany({
        where,
        orderBy: [
          { isActive: "desc" },
          { createdAt: "desc" },
        ],
      });

      res.json({ ok: true, data: repos });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────
// POST /repos
// ─────────────────────────────────────────────────────────
reposRouter.post(
  "/",
  validate(registerRepoSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        githubOwner,
        githubName,
        role,
        branch,
        description,
        customerName,
        autoMergeEnabled,
      } = req.body as RegisterRepoInput & { autoMergeEnabled?: boolean };

      const fullName = `${githubOwner}/${githubName}`.toLowerCase();

      const user = await prisma.user.findUnique({
        where: { id: req.user!.id },
        select: { githubToken: true },
      });

      if (!user?.githubToken) {
        throw AppError.badRequest("Connect your GitHub account before registering repositories.");
      }

      const token = decrypt(user.githubToken);
      const accountRepos = await GithubAppService.getAccountRepositories(token);
      const accountRepo = accountRepos.find((repo) => repo.fullName.toLowerCase() === fullName);

      if (!accountRepo) {
        throw AppError.badRequest(`Repository ${githubOwner}/${githubName} is not accessible from your GitHub account.`);
      }

      // 1. Verify GitHub App is installed on this repository
      const installationId = await GithubAppService.verifyInstallation(
        githubOwner,
        githubName
      );

      if (installationId === null) {
        throw AppError.badRequest(
          `GitHub App is not installed on repository ${githubOwner}/${githubName}. Please install the App first.`
        );
      }

      // 2. Enforce only one active MAIN repository
      if (role === "MAIN") {
        await prisma.repository.updateMany({
          where: { userId: req.user!.id, role: "MAIN", isActive: true },
          data: { isActive: false },
        });
      }

      // 3. Register or reactivate repository
      // Check if it already exists (even if inactive)
      const existing = await prisma.repository.findFirst({
        where: {
          userId: req.user!.id,
          fullName,
        },
      });

      let repo;
      if (existing) {
        // Reactivate and update configuration
        repo = await prisma.repository.update({
          where: { id: existing.id },
          data: {
            userId: req.user!.id,
            role,
            branch,
            description,
            customerName: role === "CLIENT" ? customerName : null,
            installationId,
            isActive: true,
            autoMergeEnabled,
          },
        });
      } else {
        // Create new record
        repo = await prisma.repository.create({
          data: {
            userId: req.user!.id,
            githubOwner,
            githubName,
            fullName,
            role,
            branch,
            description,
            customerName: role === "CLIENT" ? customerName : null,
            installationId,
            isActive: true,
            autoMergeEnabled,
          },
        });
      }

      res.status(201).json({ ok: true, data: repo });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────
// GET /repos/:id/branches
// ─────────────────────────────────────────────────────────
reposRouter.get(
  "/:id/branches",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const repo = await prisma.repository.findUnique({
        where: { id: req.params.id as string },
      });

      if (!repo || repo.userId !== req.user!.id) {
        throw AppError.notFound("Repository not found");
      }

      const branches = await GithubAppService.listBranches(
        repo.installationId,
        repo.fullName
      );

      res.json({ ok: true, data: branches });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────
// GET /repos/:id/commits?branch=<branch>
// ─────────────────────────────────────────────────────────
reposRouter.get(
  "/:id/commits",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const branch = req.query.branch as string | undefined;
      const repo = await prisma.repository.findUnique({
        where: { id: req.params.id as string },
      });

      if (!repo || repo.userId !== req.user!.id) {
        throw AppError.notFound("Repository not found");
      }

      const page = Math.max(1, Number(req.query.page || 1));
      const pageSize = Math.min(100, Math.max(10, Number(req.query.pageSize || 20)));
      const search = typeof req.query.search === "string" ? req.query.search : undefined;

      const commits = await GithubAppService.listCommits(
        repo.installationId,
        repo.fullName,
        branch || repo.branch,
        { page, pageSize, search }
      );

      res.json({ ok: true, data: commits });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────
// GET /repos/:id/commits/:sha/files
// ─────────────────────────────────────────────────────────
reposRouter.get(
  "/:id/commits/:sha/files",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const repo = await prisma.repository.findUnique({
        where: { id: req.params.id as string },
      });

      if (!repo || repo.userId !== req.user!.id) {
        throw AppError.notFound("Repository not found");
      }

      const commit = await GithubAppService.getCommit(
        repo.installationId,
        repo.fullName,
        req.params.sha as string
      );

      res.json({ ok: true, data: commit });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────
// GET /repos/:id/compare?base=<base>&head=<head>
// ─────────────────────────────────────────────────────────
reposRouter.get(
  "/:id/compare",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const repo = await prisma.repository.findUnique({
        where: { id: req.params.id as string },
      });

      if (!repo || repo.userId !== req.user!.id) {
        throw AppError.notFound("Repository not found");
      }

      const base = req.query.base as string;
      const head = req.query.head as string;

      if (!base || !head) {
        throw AppError.badRequest("base and head query parameters are required");
      }

      const comparison = await GithubAppService.compareCommits(
        repo.installationId,
        repo.fullName,
        base,
        head
      );

      res.json({ ok: true, data: comparison });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────
// GET /repos/:id
// ─────────────────────────────────────────────────────────
reposRouter.get(
  "/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const repo = await prisma.repository.findUnique({
        where: { id: req.params.id as string },
      });

      if (!repo || repo.userId !== req.user!.id) {
        throw AppError.notFound("Repository not found");
      }

      res.json({ ok: true, data: repo });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────
// PATCH /repos/:id
// ─────────────────────────────────────────────────────────
reposRouter.patch(
  "/:id",
  validate(updateRepoSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { branch, description, customerName, isActive, autoMergeEnabled } =
        req.body as UpdateRepoInput & { autoMergeEnabled?: boolean };

      // 1. Verify existence
      const existing = await prisma.repository.findUnique({
        where: { id: req.params.id as string },
      });

      if (!existing || existing.userId !== req.user!.id) {
        throw AppError.notFound("Repository not found");
      }

      // 2. Enforce only one active MAIN repository if activating this one
      if (existing.role === "MAIN" && isActive === true) {
        await prisma.repository.updateMany({
          where: {
            userId: req.user!.id,
            role: "MAIN",
            isActive: true,
            id: { not: existing.id },
          },
          data: { isActive: false },
        });
      }

      // 3. Perform update
      const repo = await prisma.repository.update({
        where: { id: req.params.id as string },
        data: {
          branch,
          description,
          customerName: existing.role === "CLIENT" ? customerName : undefined,
          isActive,
          autoMergeEnabled,
        },
      });

      res.json({ ok: true, data: repo });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────
// DELETE /repos/:id (Soft-delete)
// ─────────────────────────────────────────────────────────
reposRouter.delete(
  "/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.repository.findUnique({
        where: { id: req.params.id as string },
      });

      if (!existing || existing.userId !== req.user!.id) {
        throw AppError.notFound("Repository not found");
      }

      const repo = await prisma.repository.update({
        where: { id: req.params.id as string },
        data: { isActive: false },
      });

      res.json({ ok: true, data: repo });
    } catch (err) {
      next(err);
    }
  }
);
