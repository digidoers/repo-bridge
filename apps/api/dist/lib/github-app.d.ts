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
export declare class GithubAppService {
    private static getGithubSettings;
    private static getAppJwt;
    static isMockMode(): Promise<boolean>;
    static getAppInstallUrl(): Promise<string | null>;
    /**
     * Fetches all repositories across all installations of this GitHub App.
     */
    static getInstallableRepositories(): Promise<GithubAppRepo[]>;
    /**
     * Fetches repositories visible to the logged-in GitHub user via OAuth and marks
     * which are installed on the GitHub App. Only installed repos can be synced.
     */
    static getAccountRepositories(userToken: string): Promise<GithubAccountRepo[]>;
    static listAccountBranches(userToken: string, fullName: string): Promise<GithubBranch[]>;
    /**
     * Verifies if the GitHub App is installed on a specific repository.
     * Returns the installationId if installed, null otherwise.
     */
    static verifyInstallation(owner: string, repo: string): Promise<number | null>;
    /**
     * Gets an installation access token for a given installation ID.
     */
    static getInstallationToken(installationId: number): Promise<string>;
    /**
     * Calls GitHub's Compare API to get full file list + patches between base and head.
     */
    static compareCommits(installationId: number, fullName: string, base: string, head: string): Promise<{
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
    }>;
    static listBranches(installationId: number, fullName: string): Promise<GithubBranch[]>;
    static listCommits(installationId: number, fullName: string, branch: string, options?: {
        page?: number;
        pageSize?: number;
        search?: string;
    }): Promise<{
        items: GithubCommitSummary[];
        page: number;
        pageSize: number;
        hasNextPage: boolean;
        hasPreviousPage: boolean;
        total: number;
        totalPages: number;
    }>;
    static getCommit(installationId: number, fullName: string, sha: string): Promise<{
        sha: string;
        parentSha: string;
        message: string;
        authorName: string;
        authorEmail: string;
        date: string;
        files: GithubCommitFile[];
    }>;
}
//# sourceMappingURL=github-app.d.ts.map