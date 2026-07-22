import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileCode,
  GitCommit,
  GitMerge,
  Loader2,
  Search,
  Server,
} from "lucide-react";
import { api, ApiError } from "../lib/api-client";
import { Button } from "../components/ui/button";
import toast from "react-hot-toast";

export function ManualSyncPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [mainRepoId, setMainRepoId] = useState("");
  const [mainBranch, setMainBranch] = useState("");
  const [targetRepoIds, setTargetRepoIds] = useState<string[]>([]);
  const [commitShas, setCommitShas] = useState<string[]>([]);
  const [selectedCommitCache, setSelectedCommitCache] = useState<Record<string, any>>({});
  const [commitPage, setCommitPage] = useState(1);
  const [commitSearch, setCommitSearch] = useState("");
  const [filePaths, setFilePaths] = useState<string[]>([]);
  const [commitPageSize, setCommitPageSize] = useState(10);
  const [isSelectingAll, setIsSelectingAll] = useState(false);
  const [syncMode, setSyncMode] = useState<"commits" | "branch">("commits");

  const { data: repos = [], isLoading: reposLoading } = useQuery({
    queryKey: ["repositories"],
    queryFn: () => api.getRepos(),
  });

  const mainRepos = repos.filter((repo) => repo.role === "MAIN" && repo.isActive);
  const childRepos = repos.filter(
    (repo) => repo.role === "CLIENT" && repo.isActive && repo.id !== mainRepoId
  );
  const selectedMainRepo = mainRepos.find((repo) => repo.id === mainRepoId);

  const { data: branches = [], isLoading: branchesLoading } = useQuery({
    queryKey: ["repo-branches", mainRepoId],
    queryFn: () => api.getRepoBranches(mainRepoId),
    enabled: !!mainRepoId,
  });

  useEffect(() => {
    if (selectedMainRepo && !mainBranch) {
      setMainBranch(selectedMainRepo.branch);
    }
  }, [selectedMainRepo, mainBranch]);

  const { data: commitsResult, isLoading: commitsLoading, isFetching: commitsFetching } = useQuery({
    queryKey: ["repo-commits", mainRepoId, mainBranch, commitPage, commitSearch],
    queryFn: () => api.getRepoCommits(mainRepoId, mainBranch, {
      page: commitPage,
      pageSize: commitPageSize,
      search: commitSearch.trim() || undefined,
    }),
    enabled: step >= 2 && !!mainRepoId && !!mainBranch,
  });
  const commits = commitsResult?.items || [];

  const selectedCommits = useMemo(
    () => commitShas.map((sha) => selectedCommitCache[sha]).filter(Boolean),
    [commitShas, selectedCommitCache]
  );
  const selectedCommitIndexes = commitShas
    .map((sha) => selectedCommitCache[sha]?.listIndex)
    .filter((index) => index >= 0);
  const areSelectedCommitsContiguous =
    selectedCommitIndexes.length <= 1 ||
    Math.max(...selectedCommitIndexes) - Math.min(...selectedCommitIndexes) + 1 === selectedCommitIndexes.length;

  const { data: commitDetail, isLoading: filesLoading } = useQuery({
    queryKey: ["commit-files", mainRepoId, commitShas],
    queryFn: async () => {
      if (commitShas.length === 0) return { files: [] };
      if (commitShas.length === 1) {
        const detail = await api.getCommitFiles(mainRepoId, commitShas[0]);
        return { files: detail.files };
      }

      if (selectedCommits.length === commitShas.length) {
        const oldestCommit = selectedCommits.reduce((oldest, current) => {
          return (current.listIndex > oldest.listIndex) ? current : oldest;
        }, selectedCommits[0]);

        const newestCommit = selectedCommits.reduce((newest, current) => {
          return (current.listIndex < newest.listIndex) ? current : newest;
        }, selectedCommits[0]);

        if (oldestCommit && newestCommit) {
          try {
            const oldestDetail = await api.getCommitFiles(mainRepoId, oldestCommit.sha);
            const parentSha = oldestDetail.parentSha;
            if (parentSha) {
              const compare = await api.compareRepoCommits(mainRepoId, parentSha, newestCommit.sha);
              return { files: compare.files };
            } else {
              const compare = await api.compareRepoCommits(mainRepoId, oldestCommit.sha, newestCommit.sha);
              const filesByPath = new Map<string, any>();
              for (const file of oldestDetail.files) {
                filesByPath.set(file.filename, file);
              }
              for (const file of compare.files) {
                filesByPath.set(file.filename, file);
              }
              return { files: Array.from(filesByPath.values()).sort((a, b) => a.filename.localeCompare(b.filename)) };
            }
          } catch (err) {
            console.warn("Optimized compare failed, falling back to batch loading files", err);
          }
        }
      }

      const details = await Promise.all(commitShas.map((sha) => api.getCommitFiles(mainRepoId, sha)));
      const filesByPath = new Map<string, {
        filename: string;
        status: string;
        patch?: string;
        additions: number;
        deletions: number;
      }>();

      for (const detail of details) {
        for (const file of detail.files) {
          const existing = filesByPath.get(file.filename);
          filesByPath.set(file.filename, {
            filename: file.filename,
            status: file.status,
            patch: file.patch || existing?.patch,
            additions: (existing?.additions || 0) + file.additions,
            deletions: (existing?.deletions || 0) + file.deletions,
          });
        }
      }

      return { files: Array.from(filesByPath.values()).sort((a, b) => a.filename.localeCompare(b.filename)) };
    },
    enabled: step >= 3 && !!mainRepoId && commitShas.length > 0 && selectedCommits.length > 0,
  });

  const defaultBranch = selectedMainRepo?.branch || "";

  const { data: branchCompareResult, isLoading: branchCompareLoading } = useQuery({
    queryKey: ["branch-compare", mainRepoId, defaultBranch, mainBranch],
    queryFn: () => api.compareRepoCommits(mainRepoId, defaultBranch, mainBranch),
    enabled:
      step >= 2 &&
      syncMode === "branch" &&
      !!mainRepoId &&
      !!defaultBranch &&
      !!mainBranch &&
      mainBranch !== defaultBranch,
  });

  const manualSyncMutation = useMutation({
    mutationFn: (options?: { autoResolveStrategy?: "current" | "incoming" | "both"; autoMerge?: boolean }) =>
      api.createManualSync({
        mainRepoId,
        targetRepoIds,
        commitShas: syncMode === "commits" ? commitShas : undefined,
        filePaths: syncMode === "branch" ? ["*"] : filePaths,
        syncMode,
        baseBranch: syncMode === "branch" ? defaultBranch : undefined,
        compareBranch: syncMode === "branch" ? mainBranch : undefined,
        autoResolveStrategy: options?.autoResolveStrategy,
        autoMerge: options?.autoMerge,
      }),
    onSuccess: (data, variables) => {
      if (variables?.autoResolveStrategy) {
        toast.success(`Direct Branch Sync started with strategy: ${variables.autoResolveStrategy === "current" ? "Accept Target" : variables.autoResolveStrategy === "incoming" ? "Accept Source" : "Keep Both"}`);
      } else {
        toast.success("Review page prepared. Dry-run check is running.");
      }
      queryClient.removeQueries({ queryKey: ["sync-jobs", data.pushEvent.id] });
      queryClient.invalidateQueries({ queryKey: ["push-event", data.pushEvent.id] });
      queryClient.invalidateQueries({ queryKey: ["push-events-dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["push-events-history"] });
      navigate(`/dashboard/push-events/${data.pushEvent.id}`);
    },
    onError: (err: any) => {
      const msg = err instanceof ApiError ? err.message : "Failed to start merge";
      toast.error(msg);
    },
  });

  const selectedChildRepos = childRepos.filter((repo) => targetRepoIds.includes(repo.id));
  const childRepoLabel =
    selectedChildRepos.length === 1
      ? selectedChildRepos[0].customerName || selectedChildRepos[0].githubName
      : selectedChildRepos.length > 1
      ? `${selectedChildRepos[0].customerName || selectedChildRepos[0].githubName} +${selectedChildRepos.length - 1}`
      : "Child Repos";

  const parentRepoLabel = selectedMainRepo?.customerName || selectedMainRepo?.githubName || "Parent Repo";

  const canContinueFromRepos = !!mainRepoId && !!mainBranch && targetRepoIds.length > 0;
  const canContinueFromCommit =
    syncMode === "branch"
      ? !!mainBranch
      : commitShas.length > 0 && areSelectedCommitsContiguous;

  const canProceedToReview = filePaths.length > 0 && !manualSyncMutation.isPending;
  const childRepoIds = childRepos.map((repo) => repo.id);
  const areAllChildReposSelected =
    childRepoIds.length > 0 && childRepoIds.every((repoId) => targetRepoIds.includes(repoId));

  const changedFiles = useMemo(() => {
    if (syncMode === "branch") {
      return branchCompareResult?.files || [];
    }
    return commitDetail?.files || [];
  }, [syncMode, branchCompareResult, commitDetail]);

  const isFilesLoading = filesLoading || (syncMode === "branch" && branchCompareLoading);

  const areAllFilesSelected =
    changedFiles.length > 0 && changedFiles.every((file) => filePaths.includes(file.filename));

  const toggleTargetRepo = (repoId: string) => {
    setTargetRepoIds((current) =>
      current.includes(repoId)
        ? current.filter((id) => id !== repoId)
        : [...current, repoId]
    );
  };

  const toggleAllChildRepos = () => {
    setTargetRepoIds(areAllChildReposSelected ? [] : childRepoIds);
  };

  const resetCommitSelection = () => {
    setCommitShas([]);
    setSelectedCommitCache({});
    setFilePaths([]);
  };

  const toggleCommit = (commit: any, visibleIndex: number) => {
    const listIndex = (commitPage - 1) * commitPageSize + visibleIndex;
    setCommitShas((current) =>
      current.includes(commit.sha)
        ? current.filter((item) => item !== commit.sha)
        : [...current, commit.sha]
    );
    setSelectedCommitCache((current) => {
      if (current[commit.sha]) {
        const next = { ...current };
        delete next[commit.sha];
        return next;
      }
      return {
        ...current,
        [commit.sha]: {
          ...commit,
          listIndex,
        },
      };
    });
    setFilePaths([]);
  };

  const isAllOnPageSelected =
    commits.length > 0 && commits.every((commit) => commitShas.includes(commit.sha));

  const toggleSelectAllOnPage = () => {
    if (isAllOnPageSelected) {
      const pageShas = commits.map((c) => c.sha);
      setCommitShas((current) => current.filter((sha) => !pageShas.includes(sha)));
      setSelectedCommitCache((current) => {
        const next = { ...current };
        for (const sha of pageShas) {
          delete next[sha];
        }
        return next;
      });
    } else {
      const shasToAdd: string[] = [];
      const cacheUpdates: Record<string, any> = {};

      commits.forEach((commit, visibleIndex) => {
        const listIndex = (commitPage - 1) * commitPageSize + visibleIndex;
        if (!commitShas.includes(commit.sha)) {
          shasToAdd.push(commit.sha);
        }
        cacheUpdates[commit.sha] = {
          ...commit,
          listIndex,
        };
      });

      setCommitShas((current) => [...current, ...shasToAdd]);
      setSelectedCommitCache((current) => ({
        ...current,
        ...cacheUpdates,
      }));
    }
    setFilePaths([]);
  };

  const isAllCommitsSelected =
    commitsResult?.total && commitsResult.total > 0 ? commitShas.length >= commitsResult.total : false;

  const toggleSelectAllCommits = async () => {
    if (isAllCommitsSelected) {
      resetCommitSelection();
      return;
    }

    try {
      setIsSelectingAll(true);
      const allCommits: any[] = [];
      let currentPage = 1;
      let hasNext = true;

      while (hasNext && currentPage <= 10) {
        const result = await api.getRepoCommits(mainRepoId, mainBranch, {
          page: currentPage,
          pageSize: 100,
          search: commitSearch.trim() || undefined,
        });

        allCommits.push(...(result.items || []));
        hasNext = result.hasNextPage && allCommits.length < (result.total || 0);
        currentPage += 1;
      }

      const shas = allCommits.map((c) => c.sha);
      const cache: Record<string, any> = {};
      allCommits.forEach((commit, idx) => {
        cache[commit.sha] = {
          ...commit,
          listIndex: idx,
        };
      });

      setCommitShas(shas);
      setSelectedCommitCache(cache);
      setFilePaths([]);
    } catch (err) {
      console.error("Failed to select all commits", err);
      toast.error("Failed to select all commits");
    } finally {
      setIsSelectingAll(false);
    }
  };

  const toggleFile = (filePath: string) => {
    setFilePaths((current) =>
      current.includes(filePath)
        ? current.filter((path) => path !== filePath)
        : [...current, filePath]
    );
  };

  const toggleAllFiles = () => {
    setFilePaths(areAllFilesSelected ? [] : changedFiles.map((file) => file.filename));
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6 animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Manual Sync</h1>
          <p className="text-sm text-text-secondary mt-1">
            Pick a main repo commit, select files, and sync them into selected child repositories.
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={() => navigate("/dashboard/repositories")}
          className="text-xs flex items-center gap-1.5"
        >
          <Server className="w-3.5 h-3.5" />
          Manage Repos
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {[
          ["Repos", 1],
          ["Commit", 2],
          ["Files", 3],
        ].map(([label, value]) => (
          <div
            key={label}
            className={`h-2 rounded-full ${step >= Number(value) ? "bg-accent" : "bg-border"}`}
            title={String(label)}
          />
        ))}
      </div>

      {step === 1 && (
        <section className="bg-card border border-border rounded-xl p-4 space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="space-y-3">
              <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2">
                <GitMerge className="w-4 h-4 text-accent" />
                Main Repository
              </h2>
              {reposLoading ? (
                <LoadingText text="Loading repositories..." />
              ) : (
                <select
                  value={mainRepoId}
                  onChange={(e) => {
                    setMainRepoId(e.target.value);
                    setMainBranch("");
                    setCommitPage(1);
                    setCommitSearch("");
                    resetCommitSelection();
                    setTargetRepoIds((ids) => ids.filter((id) => id !== e.target.value));
                  }}
                  className="w-full h-10 rounded-lg bg-page border border-border hover:border-border-light focus:border-accent px-3 text-sm text-text-primary focus:outline-none transition-colors"
                >
                  <option value="">Select main repo</option>
                  {mainRepos.map((repo) => (
                    <option key={repo.id} value={repo.id}>
                      {repo.fullName}
                    </option>
                  ))}
                </select>
              )}

              <select
                value={mainBranch}
                onChange={(e) => {
                  setMainBranch(e.target.value);
                  setCommitPage(1);
                  setCommitSearch("");
                  resetCommitSelection();
                }}
                disabled={!mainRepoId || branchesLoading}
                className="w-full h-10 rounded-lg bg-page border border-border hover:border-border-light focus:border-accent px-3 text-sm text-text-primary focus:outline-none transition-colors disabled:opacity-60"
              >
                <option value="">
                  {branchesLoading ? "Loading branches..." : "Select required branch"}
                </option>
                {branches.map((branch) => (
                  <option key={branch.name} value={branch.name}>
                    {branch.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2">
                  <Server className="w-4 h-4 text-success" />
                  Child Repositories
                </h2>
                {childRepos.length > 0 && (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={toggleAllChildRepos}
                    className="h-8 text-3xs px-2.5"
                  >
                    {areAllChildReposSelected ? "Clear all" : "Select all"}
                  </Button>
                )}
              </div>
              <div className="border border-border rounded-lg bg-page/50 max-h-64 overflow-y-auto p-2 space-y-2">
                {childRepos.length > 0 ? (
                  childRepos.map((repo) => (
                    <label
                      key={repo.id}
                      className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${targetRepoIds.includes(repo.id)
                        ? "bg-success/10 border-success/30 text-text-primary"
                        : "bg-card border-border hover:bg-card-hover text-text-secondary"
                        }`}
                    >
                      <input
                        type="checkbox"
                        checked={targetRepoIds.includes(repo.id)}
                        onChange={() => toggleTargetRepo(repo.id)}
                        className="w-4 h-4 rounded border-border text-accent focus:ring-accent bg-page cursor-pointer"
                      />
                      <span className="text-xs font-medium">{repo.fullName}</span>
                      <span className="ml-auto text-3xs text-text-muted font-mono">{repo.branch}</span>
                    </label>
                  ))
                ) : (
                  <div className="p-6 text-center text-xs text-text-muted">
                    Link child repositories first. The selected main repo will never appear here.
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="flex justify-end">
            <Button
              disabled={!canContinueFromRepos}
              onClick={() => setStep(2)}
              className="text-xs flex items-center gap-1.5"
            >
              Continue to Commits
              <ArrowRight className="w-3.5 h-3.5" />
            </Button>
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="bg-card border border-border rounded-xl p-4 space-y-5">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2">
              <GitCommit className="w-4 h-4 text-accent" />
              Select Commits
            </h2>
            <Button variant="secondary" onClick={() => setStep(1)} className="text-xs flex items-center gap-1">
              <ArrowLeft className="w-3.5 h-3.5" />
              Back
            </Button>
          </div>

          <div className="flex border-b border-border pb-3">
            <div className="flex gap-2 bg-page p-1 rounded-lg border border-border">
              <button
                type="button"
                onClick={() => {
                  setSyncMode("commits");
                  resetCommitSelection();
                }}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                  syncMode === "commits"
                    ? "bg-card text-text-primary shadow-sm border border-border"
                    : "text-text-secondary hover:text-text-primary"
                }`}
              >
                Select Commits
              </button>
              <button
                type="button"
                onClick={() => {
                  setSyncMode("branch");
                  resetCommitSelection();
                }}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                  syncMode === "branch"
                    ? "bg-card text-text-primary shadow-sm border border-border"
                    : "text-text-secondary hover:text-text-primary"
                }`}
              >
                Sync Entire Branch
              </button>
            </div>
          </div>

          {syncMode === "commits" ? (
            <>
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                <div className="relative w-full md:max-w-md">
                  <Search className="w-4 h-4 text-text-muted absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    value={commitSearch}
                    onChange={(e) => {
                      setCommitSearch(e.target.value);
                      setCommitPage(1);
                    }}
                    placeholder="Search current commit page by message, author, or SHA"
                    className="w-full h-10 rounded-lg bg-page border border-border hover:border-border-light focus:border-accent pl-9 pr-3 text-sm text-text-primary placeholder:text-text-muted focus:outline-none transition-colors"
                  />
                </div>
                <div className="flex items-center gap-3">
                  {commitShas.length > 0 && (
                    <span className="text-xs text-text-secondary font-medium mr-1 bg-accent/10 text-accent px-2.5 py-1 rounded-md border border-accent/20">
                      {commitShas.length} selected
                    </span>
                  )}
                  {commits.length > 0 && (
                    <>
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={toggleSelectAllCommits}
                        disabled={isSelectingAll}
                        className="h-10 text-xs px-4 flex items-center gap-1.5"
                      >
                        {isSelectingAll && <Loader2 className="w-3.5 h-3.5 animate-spin text-accent" />}
                        {isAllCommitsSelected ? "Deselect all" : "Select all"}
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={toggleSelectAllOnPage}
                        className="h-10 text-xs px-4"
                      >
                        {isAllOnPageSelected ? "Deselect page" : "Select page"}
                      </Button>
                    </>
                  )}
                  {commitsFetching && !commitsLoading && (
                    <div className="flex items-center gap-1.5 text-xs text-text-muted">
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-accent" />
                      <span>Updating...</span>
                    </div>
                  )}
                </div>
              </div>

              {commitsLoading ? (
                <LoadingText text="Loading commits from GitHub..." />
              ) : commits.length === 0 ? (
                <div className="bg-page/50 border border-dashed border-border rounded-lg p-8 text-center text-xs text-text-muted">
                  No commits found on this page. Try another page or clear the search.
                </div>
              ) : (
                <div className="space-y-2 max-h-[520px] overflow-y-auto">
                  {commits.map((commit, index) => (
                    <label
                      key={commit.sha}
                      className={`w-full p-4 rounded-lg border text-left transition-colors cursor-pointer flex items-start gap-3 ${commitShas.includes(commit.sha)
                        ? "border-accent bg-accent/10"
                        : "border-border bg-page/50 hover:bg-card-hover"
                        }`}
                    >
                      <input
                        type="checkbox"
                        checked={commitShas.includes(commit.sha)}
                        onChange={() => toggleCommit(commit, index)}
                        className="w-4 h-4 rounded border-border text-accent focus:ring-accent bg-page cursor-pointer mt-0.5"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-3xs px-2 py-0.5 rounded bg-card border border-border text-text-secondary">
                            {commit.sha.substring(0, 7)}
                          </span>
                          <span className="text-xs font-semibold text-text-primary line-clamp-1">
                            {commit.message.split("\n")[0]}
                          </span>
                        </div>
                        <p className="text-3xs text-text-muted mt-1">
                          {commit.authorName} - {new Date(commit.date).toLocaleString()}
                        </p>
                      </div>
                    </label>
                  ))}
                </div>
              )}

              {!commitsLoading && commits.length > 0 && (
                <div className="flex flex-col sm:flex-row items-center justify-between gap-4 border-t border-border pt-4 mt-2">
                  <div className="text-xs text-text-secondary">
                    Showing {Math.min((commitPage - 1) * commitPageSize + 1, commitsResult?.total || 0)} to{" "}
                    {Math.min(commitPage * commitPageSize, commitsResult?.total || 0)} of {commitsResult?.total || 0} results
                  </div>

                  <div className="flex flex-wrap items-center gap-4">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-text-secondary">Per page</span>
                      <div className="relative">
                        <select
                          value={commitPageSize}
                          onChange={(e) => {
                            setCommitPageSize(Number(e.target.value));
                            setCommitPage(1);
                          }}
                          className="h-8 rounded-lg bg-page border border-border hover:border-border-light focus:border-accent pl-2.5 pr-8 text-xs text-text-primary focus:outline-none transition-colors appearance-none cursor-pointer font-medium"
                        >
                          <option value={10}>10</option>
                          <option value={20}>20</option>
                          <option value={50}>50</option>
                        </select>
                        <ChevronDown className="w-3.5 h-3.5 text-text-muted absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                      </div>
                    </div>

                    {(commitsResult?.totalPages || 1) > 1 && (
                      <div className="border border-border rounded-lg flex items-center divide-x divide-border bg-page overflow-hidden">
                        <button
                          type="button"
                          onClick={() => setCommitPage((p) => Math.max(1, p - 1))}
                          disabled={commitPage === 1 || commitsFetching}
                          className="w-8 h-8 flex items-center justify-center text-xs font-semibold text-text-secondary hover:bg-card-hover transition-colors disabled:opacity-50"
                        >
                          <ChevronLeft className="w-3.5 h-3.5" />
                        </button>

                        {getPaginationRange(commitPage, commitsResult?.totalPages || 1).map((p, idx) => {
                          if (p === "...") {
                            return (
                              <span
                                key={`dots-${idx}`}
                                className="w-8 h-8 flex items-center justify-center text-xs font-semibold text-text-muted bg-page select-none"
                              >
                                ...
                              </span>
                            );
                          }

                          const pageNum = p as number;
                          const isActive = pageNum === commitPage;

                          return (
                            <button
                              key={`page-${pageNum}`}
                              type="button"
                              onClick={() => setCommitPage(pageNum)}
                              disabled={commitsFetching}
                              className={`w-8 h-8 flex items-center justify-center text-xs font-semibold transition-colors ${isActive
                                ? "text-accent bg-accent/10 font-bold"
                                : "text-text-secondary hover:bg-card-hover bg-page"
                                }`}
                            >
                              {pageNum}
                            </button>
                          );
                        })}

                        <button
                          type="button"
                          onClick={() => setCommitPage((p) => Math.min(commitsResult?.totalPages || 1, p + 1))}
                          disabled={commitPage === (commitsResult?.totalPages || 1) || commitsFetching}
                          className="w-8 h-8 flex items-center justify-center text-xs font-semibold text-text-secondary hover:bg-card-hover transition-colors disabled:opacity-50"
                        >
                          <ChevronRight className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="space-y-4">
              <div className="bg-accent/5 border border-accent/20 rounded-lg p-4 text-xs text-text-secondary flex justify-between items-center">
                <span>
                  Syncing entire branch <span className="font-semibold text-text-primary">"{mainBranch}"</span> directly to target repositories.
                </span>
                <span className="text-3xs font-mono text-text-muted">
                  Branch: {mainBranch}
                </span>
              </div>
              <div className="bg-page/50 border border-dashed border-border rounded-lg p-8 text-center text-xs text-text-muted">
                No commit-level selection is required for entire branch sync. 
                <br />
                All changes on the branch <span className="font-semibold text-text-primary">"{mainBranch}"</span> will be merged directly into the selected child repositories.
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <p className="text-xs text-text-secondary">
              {syncMode === "branch" ? (
                <span className="text-success font-medium">
                  The entire branch "{mainBranch}" will be merged directly.
                </span>
              ) : (
                <>
                  {commitShas.length} commit{commitShas.length === 1 ? "" : "s"} selected.
                  {!areSelectedCommitsContiguous && " Select every commit between the oldest and newest selected commit."}
                </>
              )}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {syncMode === "commits" && commitShas.length > 0 && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={resetCommitSelection}
                  className="text-xs"
                >
                  Clear selected
                </Button>
              )}

              {syncMode === "branch" ? (
                <>
                  <Button
                    type="button"
                    onClick={() => manualSyncMutation.mutate({ autoResolveStrategy: "current", autoMerge: true })}
                    disabled={!mainBranch || manualSyncMutation.isPending}
                    className="text-xs bg-red-500/20 hover:bg-red-500/30 text-red-300 border border-red-500/30 font-semibold"
                  >
                    Auto-Sync & Accept Target ({childRepoLabel})
                  </Button>
                  <Button
                    type="button"
                    onClick={() => manualSyncMutation.mutate({ autoResolveStrategy: "incoming", autoMerge: true })}
                    disabled={!mainBranch || manualSyncMutation.isPending}
                    className="text-xs bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 border border-blue-500/30 font-semibold"
                  >
                    Auto-Sync & Accept Source ({parentRepoLabel})
                  </Button>
                  <Button
                    type="button"
                    onClick={() => manualSyncMutation.mutate({ autoResolveStrategy: "both", autoMerge: true })}
                    disabled={!mainBranch || manualSyncMutation.isPending}
                    variant="secondary"
                    className="text-xs"
                  >
                    Auto-Sync & Keep Both
                  </Button>
                  <Button
                    type="button"
                    disabled={!mainBranch || manualSyncMutation.isPending}
                    onClick={() => manualSyncMutation.mutate(undefined)}
                    className="text-xs flex items-center gap-1.5"
                  >
                    Proceed to Review
                    {manualSyncMutation.isPending ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <ArrowRight className="w-3.5 h-3.5" />
                    )}
                  </Button>
                </>
              ) : (
                <Button
                  disabled={!canContinueFromCommit}
                  onClick={() => setStep(3)}
                  className="text-xs flex items-center gap-1.5"
                >
                  Continue to Files
                  <ArrowRight className="w-3.5 h-3.5" />
                </Button>
              )}
            </div>
          </div>
        </section>
      )}

      {step === 3 && (
        <section className="bg-card border border-border rounded-xl p-4 space-y-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2">
                <FileCode className="w-4 h-4 text-accent" />
                Select Files
              </h2>
              {syncMode === "branch" ? (
                <p className="text-3xs text-text-muted mt-1">
                  Syncing entire branch {mainBranch} (compared to {defaultBranch})
                </p>
              ) : (
                selectedCommits.length > 0 && (
                  <p className="text-3xs text-text-muted mt-1">
                    {selectedCommits.length} commit{selectedCommits.length === 1 ? "" : "s"} selected
                  </p>
                )
              )}
            </div>
            <div className="flex items-center gap-2">
              {changedFiles.length > 0 && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={toggleAllFiles}
                  className="text-xs"
                >
                  {areAllFilesSelected ? "Clear all files" : "Select all files"}
                </Button>
              )}
              <Button variant="secondary" onClick={() => setStep(2)} className="text-xs flex items-center gap-1">
                <ArrowLeft className="w-3.5 h-3.5" />
                Back
              </Button>
            </div>
          </div>

          {isFilesLoading ? (
            <LoadingText text="Loading changed files..." />
          ) : changedFiles.length === 0 ? (
            <div className="bg-page/50 border border-dashed border-border rounded-lg p-8 text-center text-xs text-text-muted">
              {syncMode === "branch"
                ? "No changed files were found between the selected branches."
                : "No changed files were returned for the selected commit range."}
            </div>
          ) : (
            <div className="space-y-2 max-h-[520px] overflow-y-auto">
              {changedFiles.map((file) => (
                <label
                  key={file.filename}
                  className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${filePaths.includes(file.filename)
                    ? "bg-accent/10 border-accent/30 text-text-primary"
                    : "bg-page/50 border-border hover:bg-card-hover text-text-secondary"
                    }`}
                >
                  <input
                    type="checkbox"
                    checked={filePaths.includes(file.filename)}
                    onChange={() => toggleFile(file.filename)}
                    className="w-4 h-4 rounded border-border text-accent focus:ring-accent bg-page cursor-pointer"
                  />
                  <span className="font-mono text-xs truncate">{file.filename}</span>
                  <span className="ml-auto text-3xs font-semibold">
                    <span className="text-success">+{file.additions}</span>{" "}
                    <span className="text-danger">-{file.deletions}</span>
                  </span>
                </label>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <p className="text-xs text-text-secondary">
              Proceed opens a review page with the selected diffs and starts the dry-run conflict check.
            </p>
            <Button
              disabled={!canProceedToReview}
              onClick={() => manualSyncMutation.mutate(undefined)}
              className="text-xs flex items-center gap-1.5 bg-accent hover:bg-accent-hover text-white"
            >
              {manualSyncMutation.isPending ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Preparing...
                </>
              ) : (
                <>
                  <ArrowRight className="w-3.5 h-3.5" />
                  Proceed to Review
                </>
              )}
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}

function LoadingText({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 text-xs text-text-muted py-6">
      <Loader2 className="w-4 h-4 text-accent animate-spin" />
      {text}
    </div>
  );
}

function getPaginationRange(current: number, total: number) {
  const pages: (number | string)[] = [];

  if (total <= 7) {
    for (let i = 1; i <= total; i++) {
      pages.push(i);
    }
    return pages;
  }

  let start = Math.max(3, current - 1);
  let end = Math.min(total - 2, current + 1);

  if (current <= 3) {
    start = 3;
    end = 4;
  }
  if (current >= total - 2) {
    start = total - 3;
    end = total - 2;
  }

  pages.push(1);
  pages.push(2);

  if (start > 3) {
    pages.push("...");
  }

  for (let i = start; i <= end; i++) {
    pages.push(i);
  }

  if (end < total - 2) {
    pages.push("...");
  }

  pages.push(total - 1);
  pages.push(total);

  return pages;
}
