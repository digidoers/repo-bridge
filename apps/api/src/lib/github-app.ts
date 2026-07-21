import jwt from "jsonwebtoken";
import { AppSettingsService } from "./app-settings.js";

export interface GithubAppRepo {
  githubOwner: string;
  githubName: string;
  fullName: string;
  installationId: number;
}

export interface GithubAccountRepo {
  githubOwner: string;
  githubName: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  appInstalled: boolean;
  installationId: number | null;
}

export interface GithubBranch {
  name: string;
  sha: string;
}

export interface GithubCommitSummary {
  sha: string;
  message: string;
  authorName: string;
  authorEmail: string;
  date: string;
  htmlUrl: string;
}

export interface GithubCommitFile {
  filename: string;
  status: string;
  patch?: string;
  additions: number;
  deletions: number;
}

export class GithubAppService {
  private static async getGithubSettings() {
    return AppSettingsService.getGithubSettings();
  }

  private static async getAppJwt(): Promise<string> {
    const settings = await this.getGithubSettings();
    if (!settings.appId || !settings.privateKey) {
      throw new Error("GitHub App ID or Private Key is not configured");
    }

    const payload = {
      // Issued at time
      iat: Math.floor(Date.now() / 1000) - 60,
      // JWT expiration time (10 minute maximum)
      exp: Math.floor(Date.now() / 1000) + (10 * 60),
      // GitHub App's identifier
      iss: settings.appId,
    };

    // Private key might have literal newlines in env or be base64 encoded.
    // Let's decode or clean it.
    let key = settings.privateKey;
    if (key.includes("base64:")) {
      key = Buffer.from(key.replace("base64:", ""), "base64").toString("utf8");
    } else {
      // replace literal \n with real newlines if present
      key = key.replace(/\\n/g, "\n");
    }

    // If the key has no internal newlines but contains header/footer, it's a flattened PEM.
    // Format it properly to be a valid PEM key.
    if (key.includes("-----BEGIN") && !key.includes("\n")) {
      const match = key.match(/(-----BEGIN[^-]+-----)(.*)(-----END[^-]+-----)/);
      if (match) {
        const header = match[1];
        const body = match[2].replace(/\s+/g, "");
        const footer = match[3];
        
        const lines = [];
        for (let i = 0; i < body.length; i += 64) {
          lines.push(body.slice(i, i + 64));
        }
        key = `${header}\n${lines.join("\n")}\n${footer}\n`;
      }
    }

    return jwt.sign(payload, key, { algorithm: "RS256" });
  }

  public static async isMockMode(): Promise<boolean> {
    const settings = await this.getGithubSettings();
    return !settings.appId || !settings.privateKey;
  }

  public static async getAppInstallUrl(): Promise<string | null> {
    const settings = await this.getGithubSettings();
    if (!settings.appSlug) {
      return null;
    }

    return `https://github.com/apps/${settings.appSlug}/installations/new`;
  }

  /**
   * Fetches all repositories across all installations of this GitHub App.
   */
  public static async getInstallableRepositories(): Promise<GithubAppRepo[]> {
    if (await this.isMockMode()) {
      console.warn("GitHub App not configured. No real installable repositories can be listed.");
      return [];
    }

    try {
      const appJwt = await this.getAppJwt();

      // 1. Get all installations of the App
      const installationsRes = await fetch("https://api.github.com/app/installations", {
        headers: {
          Authorization: `Bearer ${appJwt}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "RepoSync-App",
        },
      });

      if (!installationsRes.ok) {
        const errText = await installationsRes.text();
        throw new Error(`Failed to fetch installations: ${installationsRes.status} ${errText}`);
      }

      const installations = (await installationsRes.json()) as Array<{
        id: number;
        account: { login: string };
      }>;

      const allRepos: GithubAppRepo[] = [];

      // 2. Fetch repos for each installation
      for (const inst of installations) {
        // Request installation access token
        const tokenRes = await fetch(
          `https://api.github.com/app/installations/${inst.id}/access_tokens`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${appJwt}`,
              Accept: "application/vnd.github+json",
              "User-Agent": "RepoSync-App",
            },
          }
        );

        if (!tokenRes.ok) {
          console.error(`Failed to get access token for installation ${inst.id}`);
          continue;
        }

        const tokenData = (await tokenRes.json()) as { token: string };
        const instToken = tokenData.token;

        // Fetch repositories under this installation
        const reposRes = await fetch("https://api.github.com/installation/repositories", {
          headers: {
            Authorization: `Bearer ${instToken}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "RepoSync-App",
          },
        });

        if (!reposRes.ok) {
          console.error(`Failed to get repos for installation ${inst.id}`);
          continue;
        }

        const reposData = (await reposRes.json()) as {
          repositories: Array<{ name: string; full_name: string; owner: { login: string } }>;
        };

        for (const r of reposData.repositories) {
          allRepos.push({
            githubOwner: r.owner.login,
            githubName: r.name,
            fullName: r.full_name,
            installationId: inst.id,
          });
        }
      }

      return allRepos;
    } catch (err) {
      console.error("Error in getInstallableRepositories:", err);
      throw err;
    }
  }

  /**
   * Fetches repositories visible to the logged-in GitHub user via OAuth and marks
   * which are installed on the GitHub App. Only installed repos can be synced.
   */
  public static async getAccountRepositories(userToken: string): Promise<GithubAccountRepo[]> {
    const installedRepos = await this.getInstallableRepositories();
    const installedByFullName = new Map(
      installedRepos.map((repo) => [repo.fullName.toLowerCase(), repo])
    );

    const repos: GithubAccountRepo[] = [];
    let page = 1;

    while (page <= 10) {
      const reposRes = await fetch(
        `https://api.github.com/user/repos?affiliation=owner,collaborator,organization_member&visibility=all&sort=updated&per_page=100&page=${page}`,
        {
          headers: {
            Authorization: `Bearer ${userToken}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "RepoSync-App",
          },
        }
      );

      if (!reposRes.ok) {
        const errText = await reposRes.text();
        throw new Error(`Failed to fetch GitHub account repositories: ${reposRes.status} ${errText}`);
      }

      const pageRepos = (await reposRes.json()) as Array<{
        name: string;
        full_name: string;
        private: boolean;
        default_branch: string;
        owner: { login: string };
      }>;

      for (const repo of pageRepos) {
        const installed = installedByFullName.get(repo.full_name.toLowerCase()) || null;
        repos.push({
          githubOwner: repo.owner.login,
          githubName: repo.name,
          fullName: repo.full_name,
          defaultBranch: repo.default_branch,
          private: repo.private,
          appInstalled: !!installed,
          installationId: installed?.installationId || null,
        });
      }

      if (pageRepos.length < 100) {
        break;
      }
      page += 1;
    }

    return repos;
  }

  public static async listAccountBranches(
    userToken: string,
    fullName: string
  ): Promise<GithubBranch[]> {
    const branches: GithubBranch[] = [];
    let page = 1;

    while (page <= 10) {
      const res = await fetch(
        `https://api.github.com/repos/${fullName}/branches?per_page=100&page=${page}`,
        {
          headers: {
            Authorization: `Bearer ${userToken}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "RepoSync-App",
          },
        }
      );

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Failed to fetch GitHub account repository branches: ${res.status} ${errText}`);
      }

      const data = (await res.json()) as Array<{
        name: string;
        commit: { sha: string };
      }>;

      branches.push(...data.map((branch) => ({
        name: branch.name,
        sha: branch.commit.sha,
      })));

      if (data.length < 100) break;
      page += 1;
    }

    return branches;
  }

  /**
   * Verifies if the GitHub App is installed on a specific repository.
   * Returns the installationId if installed, null otherwise.
   */
  public static async verifyInstallation(
    owner: string,
    repo: string
  ): Promise<number | null> {
    if (await this.isMockMode()) {
      return null;
    }

    try {
      const allRepos = await this.getInstallableRepositories();
      const match = allRepos.find(
        (r) =>
          r.githubOwner.toLowerCase() === owner.toLowerCase() &&
          r.githubName.toLowerCase() === repo.toLowerCase()
      );

      return match ? match.installationId : null;
    } catch (err) {
      console.error(`Failed to verify installation for ${owner}/${repo}:`, err);
      return null;
    }
  }

  /**
   * Gets an installation access token for a given installation ID.
   */
  public static async getInstallationToken(installationId: number): Promise<string> {
    if (await this.isMockMode()) {
      throw new Error("GitHub App is not configured. Cannot create installation token.");
    }

    const appJwt = await this.getAppJwt();
    let tokenRes: Response;
    try {
      tokenRes = await fetch(
        `https://api.github.com/app/installations/${installationId}/access_tokens`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${appJwt}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "RepoSync-App",
          },
        }
      );
    } catch (fetchErr: any) {
      throw new Error(`Network error fetching GitHub installation token (installation ${installationId}): ${fetchErr?.cause?.message || fetchErr.message || "connection failed"}`);
    }

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      throw new Error(`Failed to get access token: ${tokenRes.status} ${errText}`);
    }

    const tokenData = (await tokenRes.json()) as { token: string };
    return tokenData.token;
  }

  /**
   * Calls GitHub's Compare API to get full file list + patches between base and head.
   */
  public static async compareCommits(
    installationId: number,
    fullName: string,
    base: string,
    head: string
  ): Promise<{
    baseSha: string;
    headSha: string;
    commits: Array<{
      sha: string;
      message: string;
      authorName: string;
      authorEmail: string;
      date: string;
    }>;
    files: Array<{
      filename: string;
      status: string;
      patch?: string;
      additions: number;
      deletions: number;
    }>;
  }> {
    if (await this.isMockMode()) {
      throw new Error("GitHub App is not configured. Real GitHub compare data is required.");
    }

    const token = await this.getInstallationToken(installationId);
    const compareRes = await fetch(
      `https://api.github.com/repos/${fullName}/compare/${base}...${head}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "RepoSync-App",
        },
      }
    );

    if (!compareRes.ok) {
      const errText = await compareRes.text();
      throw new Error(`Failed to compare commits: ${compareRes.status} ${errText}`);
    }

    const compareData = (await compareRes.json()) as {
      base_commit?: { sha: string };
      merge_base_commit?: { sha: string };
      commits?: Array<{
        sha: string;
        commit: {
          message: string;
          author?: {
            name?: string;
            email?: string;
            date?: string;
          };
        };
      }>;
      files?: Array<{
        filename: string;
        status: string;
        patch?: string;
        additions: number;
        deletions: number;
      }>;
    };

    const commits = (compareData.commits || []).map((c) => ({
      sha: c.sha,
      message: c.commit.message,
      authorName: c.commit.author?.name || "Unknown",
      authorEmail: c.commit.author?.email || "",
      date: c.commit.author?.date || new Date().toISOString(),
    }));

    const baseSha = compareData.merge_base_commit?.sha || compareData.base_commit?.sha || base;
    const headSha = commits.length > 0 ? commits[commits.length - 1].sha : head;

    return {
      baseSha,
      headSha,
      commits,
      files: compareData.files || [],
    };
  }

  public static async listBranches(
    installationId: number,
    fullName: string
  ): Promise<GithubBranch[]> {
    const token = await this.getInstallationToken(installationId);
    const branches: GithubBranch[] = [];
    let page = 1;

    while (page <= 10) {
      const res = await fetch(
        `https://api.github.com/repos/${fullName}/branches?per_page=100&page=${page}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "RepoSync-App",
          },
        }
      );

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Failed to fetch branches: ${res.status} ${errText}`);
      }

      const data = (await res.json()) as Array<{
        name: string;
        commit: { sha: string };
      }>;

      branches.push(...data.map((branch) => ({
        name: branch.name,
        sha: branch.commit.sha,
      })));

      if (data.length < 100) break;
      page += 1;
    }

    return branches;
  }

  public static async listCommits(
    installationId: number,
    fullName: string,
    branch: string,
    options: { page?: number; pageSize?: number; search?: string } = {}
  ): Promise<{ items: GithubCommitSummary[]; page: number; pageSize: number; hasNextPage: boolean; hasPreviousPage: boolean; total: number; totalPages: number }> {
    const page = Math.max(1, options.page || 1);
    const pageSize = Math.min(100, Math.max(10, options.pageSize || 20));
    const token = await this.getInstallationToken(installationId);
    const res = await fetch(
      `https://api.github.com/repos/${fullName}/commits?sha=${encodeURIComponent(branch)}&per_page=${pageSize}&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "RepoSync-App",
        },
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to fetch commits: ${res.status} ${errText}`);
    }

    const data = (await res.json()) as Array<{
      sha: string;
      html_url: string;
      commit: {
        message: string;
        author?: { name?: string; email?: string; date?: string };
        committer?: { name?: string; email?: string; date?: string };
      };
    }>;

    const search = options.search?.trim().toLowerCase();
    const commits = data.map((commit) => ({
      sha: commit.sha,
      message: commit.commit.message,
      authorName: commit.commit.author?.name || commit.commit.committer?.name || "Unknown",
      authorEmail: commit.commit.author?.email || commit.commit.committer?.email || "unknown@example.com",
      date: commit.commit.author?.date || commit.commit.committer?.date || new Date().toISOString(),
      htmlUrl: commit.html_url,
    })).filter((commit) => {
      if (!search) return true;
      return (
        commit.sha.toLowerCase().includes(search) ||
        commit.message.toLowerCase().includes(search) ||
        commit.authorName.toLowerCase().includes(search) ||
        commit.authorEmail.toLowerCase().includes(search)
      );
    });

    const linkHeader = res.headers.get("Link");
    let totalPages = page;
    if (linkHeader) {
      const match = linkHeader.match(/<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="last"/);
      if (match) {
        totalPages = parseInt(match[1], 10);
      } else {
        const nextMatch = linkHeader.match(/<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="next"/);
        if (nextMatch) {
          totalPages = Math.max(totalPages, parseInt(nextMatch[1], 10));
        }
      }
    }

    let total = totalPages * pageSize;
    if (page === totalPages) {
      total = (totalPages - 1) * pageSize + data.length;
    }

    return {
      items: commits,
      page,
      pageSize,
      hasNextPage: data.length === pageSize,
      hasPreviousPage: page > 1,
      total,
      totalPages,
    };
  }

  public static async getCommit(
    installationId: number,
    fullName: string,
    sha: string
  ): Promise<{
    sha: string;
    parentSha: string;
    message: string;
    authorName: string;
    authorEmail: string;
    date: string;
    files: GithubCommitFile[];
  }> {
    const token = await this.getInstallationToken(installationId);
    const res = await fetch(
      `https://api.github.com/repos/${fullName}/commits/${encodeURIComponent(sha)}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "RepoSync-App",
        },
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to fetch commit: ${res.status} ${errText}`);
    }

    const data = (await res.json()) as {
      sha: string;
      parents?: Array<{ sha: string }>;
      commit: {
        message: string;
        author?: { name?: string; email?: string; date?: string };
        committer?: { name?: string; email?: string; date?: string };
      };
      files?: Array<{
        filename: string;
        status: string;
        patch?: string;
        additions: number;
        deletions: number;
      }>;
    };

    return {
      sha: data.sha,
      parentSha: data.parents?.[0]?.sha || `${data.sha}~1`,
      message: data.commit.message,
      authorName: data.commit.author?.name || data.commit.committer?.name || "Unknown",
      authorEmail: data.commit.author?.email || data.commit.committer?.email || "unknown@example.com",
      date: data.commit.author?.date || data.commit.committer?.date || new Date().toISOString(),
      files: data.files || [],
    };
  }
}
