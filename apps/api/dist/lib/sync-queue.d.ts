type ApplyOptions = {
    autoMerge?: boolean;
};
type DryRunOptions = {
    autoResolveStrategy?: "current" | "incoming" | "both";
    autoMerge?: boolean;
};
declare class SyncQueue {
    private activeJobs;
    /**
     * Enqueues a sync job to run its dry-run analysis in the background.
     */
    enqueueDryRun(syncJobId: string, options?: DryRunOptions): void;
    private processDryRun;
    private runRealDryRun;
    enqueueApply(syncJobId: string, options?: ApplyOptions): void;
    resolveConflictFile(syncJobId: string, filePath: string, resolvedContent: string): Promise<void>;
    bulkResolveConflictFiles(syncJobId: string, filePaths: string[], resolutions: Array<{
        filePath: string;
        resolvedContent: string;
    }>): Promise<void>;
    resetConflictFile(syncJobId: string, filePath: string): Promise<void>;
    private processApply;
    private checkPushEventCompletion;
    private mergeExistingPullRequest;
    private extractConflictHunk;
    private recordApplyConflicts;
    private applySavedResolvedFiles;
    private runRealApply;
}
export declare const syncQueue: SyncQueue;
export {};
//# sourceMappingURL=sync-queue.d.ts.map