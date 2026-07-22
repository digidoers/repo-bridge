import type {
  ApiResponse,
  AuthResponse,
  SignupRequest,
  LoginRequest,
  UserProfile,
  Repository,
  RepoRole,
  RegisterRepoRequest,
  UpdateRepoRequest,
  InstallableRepo,
  GithubAccountRepo,
  GithubSetupStatus,
  PublicGithubSettings,
  UpdateGithubSettingsRequest,
  GithubBranch,
  GithubCommitSummary,
  GithubCommitDetail,
  ManualSyncRequest,
  ManualSyncResponse,
  PushEvent,
  PushStatus,
  PaginatedResponse,
  CursorPaginatedResponse,
  SyncJob,
  CreateSyncJobsRequest,
} from "@repo-sync/shared";

const API_BASE = "/api";

class ApiClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  private async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string>),
    };

    const response = await fetch(url, {
      ...options,
      headers,
      credentials: "include", // send httpOnly cookies
    });

    const body = (await response.json()) as ApiResponse<T>;

    if (!body.ok) {
      const error = new ApiError(
        body.error.message,
        body.error.code,
        response.status,
        body.error.details
      );
      throw error;
    }

    return body.data;
  }

  // ─── Auth ────────────────────────────────────────────

  async signup(data: SignupRequest): Promise<AuthResponse> {
    return this.request<AuthResponse>("/auth/signup", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async login(data: LoginRequest): Promise<AuthResponse> {
    return this.request<AuthResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async getMe(): Promise<UserProfile> {
    return this.request<UserProfile>("/auth/me");
  }

  async logout(): Promise<void> {
    await this.request<{ message: string }>("/auth/logout", {
      method: "POST",
    });
  }

  getGitHubOAuthUrl(): string {
    return `${this.baseUrl}/auth/github/start`;
  }

  // ─── Repositories ─────────────────────────────────────

  async getRepos(role?: RepoRole, activeOnly?: boolean): Promise<Repository[]> {
    const params = new URLSearchParams();
    if (role) params.append("role", role);
    if (activeOnly !== undefined) params.append("activeOnly", String(activeOnly));

    const query = params.toString() ? `?${params.toString()}` : "";
    return this.request<Repository[]>(`/repos${query}`);
  }

  async getRepo(id: string): Promise<Repository> {
    return this.request<Repository>(`/repos/${id}`);
  }

  async registerRepo(data: RegisterRepoRequest): Promise<Repository> {
    return this.request<Repository>("/repos", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async updateRepo(id: string, data: UpdateRepoRequest): Promise<Repository> {
    return this.request<Repository>(`/repos/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }

  async deleteRepo(id: string): Promise<Repository> {
    return this.request<Repository>(`/repos/${id}`, {
      method: "DELETE",
    });
  }

  async getInstallableRepos(): Promise<InstallableRepo[]> {
    return this.request<InstallableRepo[]>("/repos/installable");
  }

  async getGithubSetupStatus(): Promise<GithubSetupStatus> {
    return this.request<GithubSetupStatus>("/repos/github-setup");
  }

  async getGithubAccountRepos(): Promise<GithubAccountRepo[]> {
    return this.request<GithubAccountRepo[]>("/repos/github-account");
  }

  async getGithubAccountRepoBranches(
    owner: string,
    repo: string
  ): Promise<GithubBranch[]> {
    return this.request<GithubBranch[]>(
      `/repos/github-account/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`
    );
  }

  async getGithubSettings(): Promise<PublicGithubSettings> {
    return this.request<PublicGithubSettings>("/settings/github");
  }

  async updateGithubSettings(
    data: UpdateGithubSettingsRequest
  ): Promise<PublicGithubSettings> {
    return this.request<PublicGithubSettings>("/settings/github", {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }

  async getRepoBranches(repoId: string): Promise<GithubBranch[]> {
    return this.request<GithubBranch[]>(`/repos/${repoId}/branches`);
  }

  async getRepoCommits(
    repoId: string,
    branch?: string,
    options: { page?: number; pageSize?: number; search?: string } = {}
  ): Promise<CursorPaginatedResponse<GithubCommitSummary>> {
    const params = new URLSearchParams();
    if (branch) params.append("branch", branch);
    if (options.page) params.append("page", String(options.page));
    if (options.pageSize) params.append("pageSize", String(options.pageSize));
    if (options.search) params.append("search", options.search);
    const query = params.toString() ? `?${params.toString()}` : "";
    return this.request<CursorPaginatedResponse<GithubCommitSummary>>(`/repos/${repoId}/commits${query}`);
  }

  async getCommitFiles(repoId: string, sha: string): Promise<GithubCommitDetail> {
    return this.request<GithubCommitDetail>(`/repos/${repoId}/commits/${sha}/files`);
  }

  async compareRepoCommits(
    repoId: string,
    base: string,
    head: string
  ): Promise<{
    baseSha: string;
    headSha: string;
    commits: Array<{ sha: string; message: string; authorName: string; date: string }>;
    files: Array<{
      filename: string;
      status: string;
      patch?: string;
      additions: number;
      deletions: number;
    }>;
  }> {
    return this.request<{
      baseSha: string;
      headSha: string;
      commits: Array<{ sha: string; message: string; authorName: string; date: string }>;
      files: Array<{
        filename: string;
        status: string;
        patch?: string;
        additions: number;
        deletions: number;
      }>;
    }>(`/repos/${repoId}/compare?base=${encodeURIComponent(base)}&head=${encodeURIComponent(head)}`);
  }

  async createManualSync(data: ManualSyncRequest): Promise<ManualSyncResponse> {
    return this.request<ManualSyncResponse>("/manual-sync", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  // ─── Push Events ──────────────────────────────────────

  async getPushEvents(
    filters?: {
      status?: PushStatus;
      repositoryId?: string;
      targetRepoId?: string;
      startDate?: string;
      endDate?: string;
    },
    page?: number,
    pageSize?: number
  ): Promise<PaginatedResponse<PushEvent>> {
    const params = new URLSearchParams();
    if (filters?.status) params.append("status", filters.status);
    if (filters?.repositoryId) params.append("repositoryId", filters.repositoryId);
    if (filters?.targetRepoId) params.append("targetRepoId", filters.targetRepoId);
    if (filters?.startDate) params.append("startDate", filters.startDate);
    if (filters?.endDate) params.append("endDate", filters.endDate);
    if (page) params.append("page", String(page));
    if (pageSize) params.append("pageSize", String(pageSize));

    const query = params.toString() ? `?${params.toString()}` : "";
    return this.request<PaginatedResponse<PushEvent>>(`/push-events${query}`);
  }

  async getPushEvent(id: string): Promise<PushEvent> {
    return this.request<PushEvent>(`/push-events/${id}`);
  }

  async triagePushEvent(id: string): Promise<PushEvent> {
    return this.request<PushEvent>(`/push-events/${id}/triage`, {
      method: "POST",
    });
  }

  // ─── Sync Jobs ────────────────────────────────────────

  async createSyncJobs(
    pushEventId: string,
    data: CreateSyncJobsRequest
  ): Promise<SyncJob[]> {
    return this.request<SyncJob[]>(`/push-events/${pushEventId}/sync-jobs`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async getSyncJobs(pushEventId: string): Promise<SyncJob[]> {
    return this.request<SyncJob[]>(`/push-events/${pushEventId}/sync-jobs`);
  }

  async getSyncJob(id: string): Promise<SyncJob> {
    return this.request<SyncJob>(`/sync-jobs/${id}`);
  }

  async retrySyncJobDryRun(id: string): Promise<SyncJob> {
    return this.request<SyncJob>(`/sync-jobs/${id}/retry-dry-run`, {
      method: "POST",
    });
  }

  async resolveSyncJobConflict(
    id: string,
    data: { filePath: string; resolvedContent: string }
  ): Promise<SyncJob> {
    return this.request<SyncJob>(`/sync-jobs/${id}/resolve-conflict`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async bulkResolveSyncJobConflicts(
    id: string,
    resolutions: Array<{ filePath: string; resolvedContent: string }>
  ): Promise<SyncJob> {
    return this.request<SyncJob>(`/sync-jobs/${id}/bulk-resolve-conflicts`, {
      method: "POST",
      body: JSON.stringify({ resolutions }),
    });
  }

  async resetSyncJobConflict(
    id: string,
    filePath: string
  ): Promise<SyncJob> {
    return this.request<SyncJob>(`/sync-jobs/${id}/reset-conflict`, {
      method: "POST",
      body: JSON.stringify({ filePath }),
    });
  }

  async applySyncJobs(
    pushEventId: string,
    syncJobIds: string[],
    options: { autoMerge?: boolean } = {}
  ): Promise<SyncJob[]> {
    return this.request<SyncJob[]>(`/push-events/${pushEventId}/apply`, {
      method: "POST",
      body: JSON.stringify({ syncJobIds, ...options }),
    });
  }

  async getSyncJobStatus(
    id: string
  ): Promise<{ id: string; status: string; prUrl: string | null; prNumber: number | null; errorMessage: string | null }> {
    return this.request<{
      id: string;
      status: string;
      prUrl: string | null;
      prNumber: number | null;
      errorMessage: string | null;
    }>(`/sync-jobs/${id}/status`);
  }
}

export class ApiError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details?: Record<string, string[]>;

  constructor(
    message: string,
    code: string,
    statusCode: number,
    details?: Record<string, string[]>
  ) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    Object.setPrototypeOf(this, ApiError.prototype);
  }
}

export const api = new ApiClient(API_BASE);
