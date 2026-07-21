// ─────────────────────────────────────────────────────────
// Auth Types
// ─────────────────────────────────────────────────────────

export interface SignupRequest {
  name: string;
  email: string;
  password: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface AuthResponse {
  user: UserProfile;
  token: string;
}

export interface UserProfile {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  githubLogin: string | null;
  createdAt: string;
}

// ─────────────────────────────────────────────────────────
// API Response Envelope
// ─────────────────────────────────────────────────────────

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiError {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, string[]>;
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

// ─────────────────────────────────────────────────────────
// Pagination
// ─────────────────────────────────────────────────────────

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface CursorPaginatedResponse<T> {
  items: T[];
  page: number;
  pageSize: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  total?: number;
  totalPages?: number;
}

// ─────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
export const NAME_MAX_LENGTH = 100;
export const EMAIL_MAX_LENGTH = 255;

// ─────────────────────────────────────────────────────────
// Repository Types
// ─────────────────────────────────────────────────────────

export type RepoRole = "MAIN" | "CLIENT";

export interface Repository {
  id: string;
  userId?: string | null;
  githubOwner: string;
  githubName: string;
  fullName: string;
  installationId: number;
  role: RepoRole;
  branch: string;
  description: string | null;
  customerName: string | null;
  isActive: boolean;
  autoMergeEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RegisterRepoRequest {
  githubOwner: string;
  githubName: string;
  role: RepoRole;
  branch?: string;
  description?: string;
  customerName?: string;
  autoMergeEnabled?: boolean;
}

export interface UpdateRepoRequest {
  branch?: string;
  description?: string;
  customerName?: string;
  isActive?: boolean;
  autoMergeEnabled?: boolean;
}

export interface InstallableRepo {
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

export interface GithubSetupStatus {
  githubLinked: boolean;
  githubLogin: string | null;
  appConfigured: boolean;
  appInstallUrl: string | null;
  installableCount: number;
}

export interface PublicGithubSettings {
  oauthClientId: string;
  oauthCallbackUrl: string;
  appId: string;
  appSlug: string;
  hasOauthClientSecret: boolean;
  hasPrivateKey: boolean;
  hasWebhookSecret: boolean;
}

export interface UpdateGithubSettingsRequest {
  oauthClientId?: string;
  oauthClientSecret?: string;
  oauthCallbackUrl?: string;
  appId?: string;
  appSlug?: string;
  privateKey?: string;
  webhookSecret?: string;
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

export interface GithubCommitDetail {
  sha: string;
  parentSha: string;
  message: string;
  authorName: string;
  authorEmail: string;
  date: string;
  files: GithubCommitFile[];
}

export interface ManualSyncRequest {
  mainRepoId: string;
  targetRepoIds: string[];
  commitSha?: string;
  commitShas?: string[];
  filePaths: string[];
  syncMode?: "commits" | "branch";
  baseBranch?: string;
  compareBranch?: string;
}

export interface ManualSyncResponse {
  pushEvent: PushEvent;
  syncJobs: SyncJob[];
}

// ─────────────────────────────────────────────────────────
// Push Event Types
// ─────────────────────────────────────────────────────────

export type PushStatus = "NEW" | "TRIAGED" | "COMPLETED";

export interface PushFile {
  id: string;
  pushEventId: string;
  filePath: string;
  changeType: string; // "added" | "modified" | "removed" | "renamed"
  patch: string | null;
  additions: number;
  deletions: number;
}

export interface PushEvent {
  id: string;
  repositoryId: string;
  repository?: Repository;
  commitSha: string;
  baseSha: string;
  branch: string;
  authorName: string;
  authorEmail: string;
  message: string;
  pushedAt: string;
  status: PushStatus;
  createdAt: string;
  files?: PushFile[];
  syncJobs?: SyncJob[];
}

// ─────────────────────────────────────────────────────────
// Module 4: Sync Targeting & Dry Run Types
// ─────────────────────────────────────────────────────────

export type SyncJobStatus =
  | "PENDING"
  | "DRY_RUN_RUNNING"
  | "CLEAN"
  | "CONFLICT"
  | "APPLYING"
  | "APPLIED"
  | "FAILED";

export type MergeResult = "PENDING" | "CLEAN" | "MERGED" | "CONFLICT";

export interface SyncJobFile {
  id: string;
  syncJobId: string;
  filePath: string;
  mergeResult: MergeResult;
  conflictDiff: string | null;
}

export interface SyncJob {
  id: string;
  pushEventId: string;
  pushEvent?: PushEvent;
  targetRepoId: string;
  targetRepo?: Repository;
  status: SyncJobStatus;
  branchName: string | null;
  prUrl: string | null;
  prNumber: number | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  files?: SyncJobFile[];
}

export interface CreateSyncJobsRequest {
  targetRepoIds: string[];
  filesByRepo: {
    [repoId: string]: string[];
  };
}
