import React, { useState, useEffect, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  GitCommit,
  User,
  Calendar,
  FileCode,
  Plus,
  Minus,
  CheckCircle2,
  ExternalLink,
  Copy,
  ChevronRight,
  Folder,
  Loader2,
  AlertCircle,
  GitMerge,
  Server,
  Settings,
  HelpCircle,
  Play,
  RotateCcw,
  AlertTriangle,
  XCircle,
  Undo2,
} from "lucide-react";
import { api } from "../lib/api-client";
import { Button } from "../components/ui/button";
import { LoadingScreen } from "../components/ui/loading-screen";
import toast from "react-hot-toast";
import type { SyncJob, Repository } from "@repo-sync/shared";

interface FileChange {
  id: string;
  filePath: string;
  changeType: string;
  patch: string | null;
  additions: number;
  deletions: number;
}

interface CommitFileGroup {
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
}

function applyConflictChoice(content: string, choice: "current" | "incoming" | "both") {
  const lines = content.split("\n");
  const resolved: string[] = [];
  let current: string[] = [];
  let incoming: string[] = [];
  let mode: "normal" | "current" | "base" | "incoming" = "normal";

  for (const line of lines) {
    if (line.startsWith("<<<<<<<")) {
      current = [];
      incoming = [];
      mode = "current";
      continue;
    }
    if (mode === "current" && line.startsWith("=======")) {
      mode = "incoming";
      continue;
    }
    if (mode === "current" && line.startsWith("|||||||")) {
      mode = "base";
      continue;
    }
    if (mode === "base" && line.startsWith("=======")) {
      mode = "incoming";
      continue;
    }
    if (mode === "incoming" && line.startsWith(">>>>>>>")) {
      if (choice === "current") resolved.push(...current);
      if (choice === "incoming") resolved.push(...incoming);
      if (choice === "both") resolved.push(...current, ...incoming);
      mode = "normal";
      continue;
    }
    if (mode === "current") {
      current.push(line);
    } else if (mode === "base") {
      continue;
    } else if (mode === "incoming") {
      incoming.push(line);
    } else {
      resolved.push(line);
    }
  }

  return resolved.join("\n");
}

/**
 * Renders conflict diff content as an array of React elements with color-coded
 * conflict sections. Non-conflict lines use default styling; conflict markers
 * and their content are highlighted with distinct colors per side.
 */
function renderConflictDiff(
  content: string,
  currentLabel: string,
  incomingLabel: string
) {
  const lines = content.split("\n");
  const elements: React.ReactNode[] = [];
  let mode: "normal" | "current" | "base" | "incoming" = "normal";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("<<<<<<<")) {
      mode = "current";
      elements.push(
        <div key={i} className="bg-red-500/15 text-red-400 border-l-2 border-red-500 pl-2 -mx-3 px-3 py-0.5 font-bold">
          {`<<<<<<< ${currentLabel} (target branch)`}
        </div>
      );
      continue;
    }
    if (mode === "current" && line.startsWith("|||||||")) {
      mode = "base";
      elements.push(
        <div key={i} className="bg-text-muted/10 text-text-muted border-l-2 border-text-muted pl-2 -mx-3 px-3 py-0.5 font-bold">
          ||||||| common ancestor
        </div>
      );
      continue;
    }
    if ((mode === "current" || mode === "base") && line.startsWith("=======")) {
      mode = "incoming";
      elements.push(
        <div key={i} className="bg-text-muted/10 text-text-muted border-l-2 border-text-muted pl-2 -mx-3 px-3 py-0.5 font-bold">
          =======
        </div>
      );
      continue;
    }
    if (mode === "incoming" && line.startsWith(">>>>>>>")) {
      elements.push(
        <div key={i} className="bg-blue-500/15 text-blue-400 border-l-2 border-blue-500 pl-2 -mx-3 px-3 py-0.5 font-bold">
          {`>>>>>>> ${incomingLabel} (source branch)`}
        </div>
      );
      mode = "normal";
      continue;
    }

    if (mode === "current") {
      elements.push(
        <div key={i} className="bg-red-500/8 text-red-300 border-l-2 border-red-500/40 pl-2 -mx-3 px-3">
          {line || " "}
        </div>
      );
    } else if (mode === "base") {
      elements.push(
        <div key={i} className="bg-text-muted/5 text-text-muted/60 border-l-2 border-text-muted/20 pl-2 -mx-3 px-3 line-through">
          {line || " "}
        </div>
      );
    } else if (mode === "incoming") {
      elements.push(
        <div key={i} className="bg-blue-500/8 text-blue-300 border-l-2 border-blue-500/40 pl-2 -mx-3 px-3">
          {line || " "}
        </div>
      );
    } else {
      elements.push(
        <div key={i} className="text-text-secondary">
          {line || " "}
        </div>
      );
    }
  }

  return elements;
}

function getFileMergeResultLabel(file: { mergeResult?: string | null; conflictDiff?: string | null }) {
  if (
    file.mergeResult === "MERGED" &&
    file.conflictDiff?.startsWith("repo-sync:resolved-content:v1\n")
  ) {
    return "SAVED";
  }

  switch (file.mergeResult) {
    case "CLEAN":
      return "DIRECT";
    case "MERGED":
      return "AUTO-MERGE";
    case "CONFLICT":
      return "CONFLICT";
    default:
      return file.mergeResult || "PENDING";
  }
}

export function PushEventDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [activeTab, setActiveTab] = useState<"diff" | "sync">("diff");
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [openCommitShas, setOpenCommitShas] = useState<string[]>([]);
  const defaultOpenEventIdRef = useRef<string | null>(null);
  const fileSelectionInitializedRef = useRef<string | null>(null);
  const [resolutionDraft, setResolutionDraft] = useState<{
    jobId: string;
    filePath: string;
    content: string;
    originalContent: string;
    currentLabel: string;
    incomingLabel: string;
  } | null>(null);

  // Filters & performance paging states for Dry-Run results
  const [syncFileFilter, setSyncFileFilter] = useState<"ALL" | "CONFLICT" | "MERGED" | "CLEAN">("ALL");
  const [showAllFilesMap, setShowAllFilesMap] = useState<Record<string, boolean>>({});

  // Sync targeting states
  const [selectedRepoIds, setSelectedRepoIds] = useState<string[]>([]);
  // Map of repoId -> filePaths[]
  const [fileSelection, setFileSelection] = useState<Record<string, string[]>>({});

  // Query: Fetch Push Event detail
  const { data: event, isLoading, error, refetch: refetchPushEvent } = useQuery({
    queryKey: ["push-event", id],
    queryFn: () => api.getPushEvent(id as string),
    enabled: !!id,
  });

  // Query: Fetch active client repositories
  const { data: repositories = [] } = useQuery({
    queryKey: ["repositories"],
    queryFn: () => api.getRepos(),
  });

  const clientRepos = repositories.filter(
    (r) => r.role === "CLIENT" && r.isActive
  );

  // Query: Fetch existing sync jobs for this push event
  const { data: syncJobs = [], refetch: refetchSyncJobs } = useQuery({
    queryKey: ["sync-jobs", id],
    queryFn: () => api.getSyncJobs(id as string),
    enabled: !!id,
  });

  // Poll sync jobs if any job is currently in progress (PENDING, DRY_RUN_RUNNING, or APPLYING)
  const isAnyJobRunning = syncJobs.some(
    (job) => job.status === "PENDING" || job.status === "DRY_RUN_RUNNING" || job.status === "APPLYING"
  );

  useEffect(() => {
    let intervalId: any;
    if (isAnyJobRunning) {
      intervalId = setInterval(() => {
        refetchSyncJobs();
        refetchPushEvent();
      }, 2000);
    }
    return () => {
      if (intervalId) clearInterval(intervalId);
    };
  }, [isAnyJobRunning, refetchSyncJobs, refetchPushEvent]);

  // Mutation: Triage Push Event (Mark as TRIAGED)
  const triageMutation = useMutation({
    mutationFn: () => api.triagePushEvent(id as string),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["push-event", id] });
    },
  });

  // Automatically trigger triage when detail page is opened
  useEffect(() => {
    if (event && event.status === "NEW") {
      triageMutation.mutate();
    }
  }, [event]);

  // Set default selected file when files load
  useEffect(() => {
    if (!event?.files || event.files.length === 0) {
      setSelectedFileId(null);
      setOpenCommitShas([]);
      return;
    }

    const commitGroups = (((event as any).commitFileGroups || []) as CommitFileGroup[])
      .filter((group) => group.files.length > 0);
    const firstGroupedFilePath = commitGroups[0]?.files[0]?.filePath;
    const firstGroupedFile = firstGroupedFilePath
      ? event.files.find((file) => file.filePath === firstGroupedFilePath)
      : null;
    const currentFileStillExists = event.files.some((file) => file.id === selectedFileId);

    if (commitGroups.length > 0 && defaultOpenEventIdRef.current !== event.id) {
      setOpenCommitShas([commitGroups[0].sha]);
      defaultOpenEventIdRef.current = event.id;
    }

    if (!selectedFileId || !currentFileStillExists) {
      setSelectedFileId(firstGroupedFile?.id || event.files[0].id);
    }
  }, [event, selectedFileId]);

  // Initialize file selections when repositories and files are loaded.
  // Only run once per push event (or when event/repositories actually change),
  // NOT on every syncJobs poll update, to avoid resetting user selections.
  const fileInitKey = `${event?.id}:${event?.files?.length || 0}:${clientRepos.map((r) => r.id).sort().join(",")}`;
  useEffect(() => {
    if (fileSelectionInitializedRef.current === fileInitKey) return;

    const targetRepos = Array.from(new Map(syncJobs
      .map((job) => job.targetRepo)
      .filter((repo): repo is Repository => Boolean(repo?.id))
      .map((repo) => [repo.id, repo])).values());
    const visibleClientRepos = targetRepos.length > 0 ? targetRepos : clientRepos;

    if (event?.files && visibleClientRepos.length > 0) {
      const initialSelection: Record<string, string[]> = {};
      const filePaths = event.files.map((f) => f.filePath);
      
      visibleClientRepos.forEach((repo) => {
        initialSelection[repo.id] = [...filePaths];
      });
      setFileSelection(initialSelection);
      setSelectedRepoIds(visibleClientRepos.map((repo) => repo.id));
      fileSelectionInitializedRef.current = fileInitKey;
    }
  }, [event, repositories, syncJobs, fileInitKey]);

  // Mutation: Create Sync Jobs (Dry Run)
  const createSyncJobsMutation = useMutation({
    mutationFn: (data: { targetRepoIds: string[]; filesByRepo: Record<string, string[]> }) =>
      api.createSyncJobs(id as string, data),
    onSuccess: () => {
      toast.success("Dry-run analysis enqueued!");
      refetchSyncJobs();
    },
    onError: (err: any) => {
      toast.error(err.message || "Failed to start dry-run analysis");
    },
  });

  // Mutation: Retry single dry-run
  const retryDryRunMutation = useMutation({
    mutationFn: (jobId: string) => api.retrySyncJobDryRun(jobId),
    onSuccess: () => {
      toast.success("Retrying dry-run check...");
      refetchSyncJobs();
    },
    onError: (err: any) => {
      toast.error(err.message || "Failed to retry dry-run");
    },
  });

  const resolveConflictMutation = useMutation({
    mutationFn: (data: { jobId: string; filePath: string; resolvedContent: string }) =>
      api.resolveSyncJobConflict(data.jobId, {
        filePath: data.filePath,
        resolvedContent: data.resolvedContent,
      }),
    onSuccess: () => {
      toast.success("Conflict resolution saved.");
      setResolutionDraft(null);
      refetchSyncJobs();
    },
    onError: (err: any) => {
      toast.error(err.message || "Failed to resolve conflict");
    },
  });

  // Mutation: merge clean sync jobs
  const applySyncJobsMutation = useMutation({
    mutationFn: async () => {
      const latest = await refetchSyncJobs();
      const latestMergeableJobIds = (latest.data || [])
        .filter((job) => job.status === "CLEAN" || (job.status === "FAILED" && Boolean(job.prNumber)))
        .map((job) => job.id);

      if (latestMergeableJobIds.length === 0) {
        throw new Error("No clean sync jobs are ready to merge. Please wait for dry-run or retry it.");
      }

      return api.applySyncJobs(id as string, latestMergeableJobIds, { autoMerge: true });
    },
    onSuccess: () => {
      toast.success("Merge check started. RepoBridge will skip repos that are already up to date.");
      refetchSyncJobs();
    },
    onError: (err: any) => {
      toast.error(err.message || "Failed to merge sync jobs");
    },
  });

  const handleCopySha = (sha: string) => {
    navigator.clipboard.writeText(sha);
    toast.success("Commit SHA copied!");
  };

  const handleRepoToggle = (repoId: string) => {
    if (selectedRepoIds.includes(repoId)) {
      setSelectedRepoIds(selectedRepoIds.filter((x) => x !== repoId));
    } else {
      setSelectedRepoIds([...selectedRepoIds, repoId]);
    }
  };

  const handleFileToggle = (repoId: string, filePath: string) => {
    const currentSelected = fileSelection[repoId] || [];
    if (currentSelected.includes(filePath)) {
      setFileSelection({
        ...fileSelection,
        [repoId]: currentSelected.filter((x) => x !== filePath),
      });
    } else {
      setFileSelection({
        ...fileSelection,
        [repoId]: [...currentSelected, filePath],
      });
    }
  };

  const handleToggleAllFilesForRepo = (repoId: string, allFiles: string[]) => {
    const currentSelected = fileSelection[repoId] || [];
    if (currentSelected.length === allFiles.length) {
      // Clear all
      setFileSelection({
        ...fileSelection,
        [repoId]: [],
      });
    } else {
      // Select all
      setFileSelection({
        ...fileSelection,
        [repoId]: [...allFiles],
      });
    }
  };

  const handleRunDryRun = () => {
    if (selectedRepoIds.length === 0) {
      toast.error("Please select at least one client repository.");
      return;
    }

    const payload: Record<string, string[]> = {};
    let hasSelectedFiles = false;

    selectedRepoIds.forEach((repoId) => {
      const files = fileSelection[repoId] || [];
      if (files.length > 0) {
        payload[repoId] = files;
        hasSelectedFiles = true;
      }
    });

    if (!hasSelectedFiles) {
      toast.error("Please select at least one file to sync for the targeted repositories.");
      return;
    }

    createSyncJobsMutation.mutate({
      targetRepoIds: selectedRepoIds,
      filesByRepo: payload,
    });
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && activeTab === "sync") {
        e.preventDefault();
        if (selectedRepoIds.length > 0 && !createSyncJobsMutation.isPending && !isAnyJobRunning) {
          handleRunDryRun();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeTab, selectedRepoIds, createSyncJobsMutation.isPending, isAnyJobRunning, fileSelection]);

  const handleExcludeAndRetry = (job: SyncJob, conflictedFilePath: string) => {
    // 1. Remove the file from state targeting for this repo
    const currentSelected = fileSelection[job.targetRepoId] || [];
    const updatedSelected = currentSelected.filter((x) => x !== conflictedFilePath);
    if (updatedSelected.length === 0) {
      toast.error("Cannot retry this repo after excluding its last selected file.");
      return;
    }
    
    setFileSelection({
      ...fileSelection,
      [job.targetRepoId]: updatedSelected,
    });

    // 2. We delete the previous sync job and trigger a new dry run in a single flow, 
    // but a simpler/safer backend approach: we can just call createSyncJobs again with updated selection!
    toast.loading("Excluding file and re-running dry-run...", { duration: 2000 });
    
    // We run creation mutation directly with updated select
    createSyncJobsMutation.mutate({
      targetRepoIds: [job.targetRepoId],
      filesByRepo: {
        [job.targetRepoId]: updatedSelected,
      },
    });
  };

  const openResolutionEditor = (job: SyncJob, filePath: string, conflictDiff: string | null) => {
    setResolutionDraft({
      jobId: job.id,
      filePath,
      content: conflictDiff || "",
      originalContent: conflictDiff || "",
      currentLabel: `${job.targetRepo?.fullName || "Target repo"}:${job.targetRepo?.branch || "target branch"}`,
      incomingLabel: `${event?.repository?.fullName || "Main repo"}:${event?.branch || "source branch"}`,
    });
  };

  const submitResolution = () => {
    if (!resolutionDraft) return;
    const hasConflictMarkers =
      resolutionDraft.content.includes("<<<<<<<") ||
      resolutionDraft.content.includes("=======") ||
      resolutionDraft.content.includes(">>>>>>>");

    if (hasConflictMarkers) {
      toast.error("Remove all conflict markers before submitting the resolution.");
      return;
    }

    resolveConflictMutation.mutate({
      jobId: resolutionDraft.jobId,
      filePath: resolutionDraft.filePath,
      resolvedContent: resolutionDraft.content,
    });
  };

  if (isLoading) {
    return <LoadingScreen />;
  }

  if (error || !event) {
    return (
      <div className="max-w-md mx-auto text-center space-y-4 py-20">
        <AlertCircle className="w-12 h-12 text-danger mx-auto" />
        <h2 className="text-lg font-semibold text-text-primary">Push Event Not Found</h2>
        <p className="text-sm text-text-secondary leading-relaxed">
          The requested commit push event record could not be loaded. It may have been deleted.
        </p>
        <Button onClick={() => navigate("/dashboard")} variant="secondary" className="flex items-center gap-1 mx-auto text-xs">
          <ArrowLeft className="w-4 h-4" /> Back to Dashboard
        </Button>
      </div>
    );
  }

  const files = (event.files || []) as FileChange[];
  const allFilePaths = files.map((f) => f.filePath);
  const commitFileGroups = (((event as any).commitFileGroups || []) as CommitFileGroup[])
    .filter((group) => group.files.length > 0);
  const fileByPath = new Map(files.map((file) => [file.filePath, file]));
  
  const cleanJobs = syncJobs.filter(
    (job) => job.status === "CLEAN"
  );
  const failedJobs = syncJobs.filter((job) => job.status === "FAILED");
  const recoverableFailedJobs = failedJobs.filter((job) => Boolean(job.prNumber));
  const mergeableJobs = [...cleanJobs, ...recoverableFailedJobs];
  const mergeableJobIds = mergeableJobs.map((job) => job.id);
  const conflictJobs = syncJobs.filter((job) => job.status === "CONFLICT");
  const appliedJobs = syncJobs.filter((job) => job.status === "APPLIED");
  const nothingToMergeJobs = appliedJobs.filter((job) => job.errorMessage === "Already up to date");
  const pendingReviewJobs = syncJobs.filter((job) => job.status === "PENDING" || job.status === "DRY_RUN_RUNNING");
  const targetReposFromJobs = Array.from(new Map(syncJobs
    .map((job) => job.targetRepo)
    .filter((repo): repo is Repository => Boolean(repo?.id))
    .map((repo) => [repo.id, repo])).values());
  const scopedClientRepos = targetReposFromJobs.length > 0 ? targetReposFromJobs : clientRepos;

  // Group files by top-level folder for Diff Viewer
  const groupedFiles: Record<string, FileChange[]> = {};
  files.forEach((file) => {
    const parts = file.filePath.split("/");
    const folder = parts.length > 1 ? parts[0] : "/";
    if (!groupedFiles[folder]) {
      groupedFiles[folder] = [];
    }
    groupedFiles[folder].push(file);
  });

  const selectedFile = files.find((f) => f.id === selectedFileId);

  const toggleCommitGroup = (sha: string) => {
    setOpenCommitShas((current) =>
      current.includes(sha)
        ? current.filter((item) => item !== sha)
        : [...current, sha]
    );
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "PENDING":
        return <Loader2 className="w-4 h-4 text-text-muted animate-spin" />;
      case "DRY_RUN_RUNNING":
      case "APPLYING":
        return <Loader2 className="w-4 h-4 text-accent animate-spin" />;
      case "CLEAN":
      case "APPLIED":
        return <CheckCircle2 className="w-4.5 h-4.5 text-success" />;
      case "CONFLICT":
        return <AlertTriangle className="w-4.5 h-4.5 text-warning" />;
      case "FAILED":
        return <XCircle className="w-4.5 h-4.5 text-danger" />;
      default:
        return null;
    }
  };

  const getStatusClass = (status: string) => {
    switch (status) {
      case "PENDING":
      case "DRY_RUN_RUNNING":
      case "APPLYING":
        return "bg-accent/10 border-accent/20 text-accent";
      case "CLEAN":
      case "APPLIED":
        return "bg-success/15 border-success/30 text-success";
      case "CONFLICT":
        return "bg-warning/15 border-warning/30 text-warning";
      case "FAILED":
        return "bg-danger/15 border-danger/30 text-danger";
      default:
        return "bg-border text-text-secondary";
    }
  };

  return (
    <div className="space-y-4 animate-fade-in max-w-none mx-auto">
      {/* Back Button */}
      <button
        onClick={() => navigate("/dashboard")}
        className="inline-flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors group"
      >
        <ArrowLeft className="w-4 h-4 group-hover:-translate-x-0.5 transition-transform" />
        Back to Dashboard
      </button>

      {/* Header Panel */}
      <div className="bg-card border border-border rounded-xl p-3 relative overflow-hidden">
        <div className="absolute top-0 right-0 w-32 h-32 bg-accent/5 rounded-full blur-2xl pointer-events-none" />
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
          <div className="space-y-1.5 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-2xs font-semibold px-2 py-0.5 rounded-full bg-accent/15 border border-accent/25 text-accent uppercase tracking-wider">
                Push Webhook Commit
              </span>
              <span className="text-2xs font-semibold px-2 py-0.5 rounded bg-border text-text-muted">
                {event.repository?.githubOwner}/{event.repository?.githubName}
              </span>
            </div>
            <h1 className="text-lg font-bold text-text-primary leading-snug">{event.message}</h1>
            
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-3xs text-text-secondary pt-0.5">
              <span className="flex items-center gap-1 font-mono">
                <GitCommit className="w-3.5 h-3.5 text-text-muted" />
                <span className="font-semibold text-text-primary">{event.commitSha.substring(0, 7)}</span>
                <button
                  onClick={() => handleCopySha(event.commitSha)}
                  className="p-0.5 rounded hover:bg-card-hover text-text-muted hover:text-text-primary transition-colors"
                  title="Copy full SHA"
                >
                  <Copy className="w-3 h-3" />
                </button>
              </span>
              <span className="flex items-center gap-1">
                <User className="w-3.5 h-3.5 text-text-muted" />
                {event.authorName}
              </span>
              <span className="flex items-center gap-1">
                <Calendar className="w-3.5 h-3.5 text-text-muted" />
                {new Date(event.pushedAt).toLocaleString()}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Tabs Selector */}
      <div className="flex border-b border-border">
        <button
          onClick={() => setActiveTab("diff")}
          className={`flex items-center gap-2 px-3 py-2.5 text-xs font-semibold border-b-2 transition-all ${
            activeTab === "diff"
              ? "border-accent text-accent"
              : "border-transparent text-text-secondary hover:text-text-primary"
          }`}
        >
          <FileCode className="w-4 h-4" />
          Inspect Diff ({files.length} files)
        </button>
        <button
          onClick={() => setActiveTab("sync")}
          className={`flex items-center gap-2 px-3 py-2.5 text-xs font-semibold border-b-2 transition-all ${
            activeTab === "sync"
              ? "border-accent text-accent"
              : "border-transparent text-text-secondary hover:text-text-primary"
          }`}
        >
          <GitMerge className="w-4 h-4" />
          Sync Targeting & Dry-Run
        </button>
      </div>

      {/* Tab Contents */}
      {activeTab === "diff" && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Left: Files List */}
          <div className="space-y-2">
            <h2 className="text-xs font-bold text-text-muted uppercase tracking-wider">
              Modified Files List
            </h2>
            <div className="space-y-2 max-h-[76vh] overflow-y-auto pr-0.5">
              {commitFileGroups.length > 0 ? (
                commitFileGroups.map((group, index) => {
                  const isOpen = openCommitShas.includes(group.sha);
                  return (
                    <div key={group.sha} className="border border-border rounded-lg bg-card overflow-hidden">
                      <div className="flex items-start gap-2 p-2.5 hover:bg-card-hover transition-colors">
                        <button
                          type="button"
                          onClick={() => toggleCommitGroup(group.sha)}
                          className="min-w-0 flex-1 flex items-start gap-2 text-left"
                        >
                          <ChevronRight className={`w-4 h-4 text-accent mt-0.5 flex-shrink-0 transition-transform ${isOpen ? "rotate-90" : ""}`} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-3xs px-2 py-0.5 rounded bg-page border border-border text-text-primary">
                                {group.sha.substring(0, 7)}
                              </span>
                              {index === 0 && (
                                <span className="text-[10px] uppercase font-bold text-accent bg-accent/10 border border-accent/20 rounded px-1.5 py-0.5">
                                  Head
                                </span>
                              )}
                            </div>
                            <p className="text-3xs text-text-secondary mt-1 truncate" title={group.message}>
                              {group.message.split("\n")[0]}
                            </p>
                            <p className="text-[10px] text-text-muted mt-0.5">
                              {group.files.length} file{group.files.length === 1 ? "" : "s"} affected
                            </p>
                          </div>
                        </button>
                        <a
                          href={`https://github.com/${event.repository?.fullName}/commit/${group.sha}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-[10px] px-1.5 py-1 rounded border border-border text-accent hover:bg-accent/10 hover:border-accent/30 transition-colors flex-shrink-0"
                          title={`Open commit ${group.sha.substring(0, 7)} on GitHub`}
                        >
                          <span>Commit</span>
                          <ExternalLink className="w-2.5 h-2.5" />
                        </a>
                      </div>

                      {isOpen && (
                        <div className="space-y-1 p-1.5 border-t border-border bg-page/30">
                          {group.files.map((groupFile) => {
                            const file = fileByPath.get(groupFile.filePath);
                            if (!file) return null;
                            const isSelected = file.id === selectedFileId;
                            return (
                              <button
                                key={`${group.sha}-${groupFile.filePath}`}
                                onClick={() => setSelectedFileId(file.id)}
                                className={`w-full text-left p-2 rounded-lg border text-xs flex items-center justify-between gap-3 transition-all duration-150 ${
                                  isSelected
                                    ? "bg-accent/10 border-accent/40 text-text-primary font-medium"
                                    : "bg-card border-border hover:border-border-light text-text-secondary hover:bg-card-hover"
                                }`}
                              >
                                <span className="truncate block flex-1 font-mono text-3xs" title={groupFile.filePath}>
                                  {groupFile.filePath}
                                </span>
                                <span className="font-mono text-3xs font-semibold flex-shrink-0">
                                  {groupFile.additions > 0 && <span className="text-success">+{groupFile.additions} </span>}
                                  {groupFile.deletions > 0 && <span className="text-danger">-{groupFile.deletions}</span>}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })
              ) : (
                Object.keys(groupedFiles).map((folder) => (
                  <div key={folder} className="space-y-1">
                    <div className="flex items-center gap-1 text-3xs font-bold text-text-muted uppercase tracking-wider py-1 px-1">
                      <Folder className="w-3 h-3 text-accent" />
                      <span>{folder === "/" ? "Root Files" : folder}</span>
                    </div>
                    <div className="space-y-1 pl-1">
                      {groupedFiles[folder].map((file) => {
                        const isSelected = file.id === selectedFileId;
                        return (
                          <button
                            key={file.id}
                            onClick={() => setSelectedFileId(file.id)}
                            className={`w-full text-left p-2 rounded-lg border text-xs flex items-center justify-between gap-3 transition-all duration-150 ${
                              isSelected
                                ? "bg-accent/10 border-accent/40 text-text-primary font-medium"
                                : "bg-card border-border hover:border-border-light text-text-secondary hover:bg-card-hover"
                            }`}
                          >
                            <span className="truncate block flex-1" title={file.filePath}>
                              {file.filePath.split("/").slice(1).join("/") || file.filePath}
                            </span>
                            <span className="font-mono text-3xs font-semibold flex-shrink-0">
                              {file.additions > 0 && <span className="text-success">+{file.additions} </span>}
                              {file.deletions > 0 && <span className="text-danger">-{file.deletions}</span>}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Right: Code Diff Viewer */}
          <div className="lg:col-span-2 space-y-2">
            <div className="flex items-center justify-between border-b border-border pb-1">
              <h2 className="text-xs font-bold text-text-muted uppercase tracking-wider">Diff Viewer</h2>
              {selectedFile && (
                <span className="text-3xs font-mono text-text-muted bg-card px-2 py-0.5 border border-border rounded capitalize">
                  {selectedFile.changeType}
                </span>
              )}
            </div>

            {selectedFile ? (
              <div className="bg-card border border-border rounded-xl overflow-hidden">
                <div className="px-3 py-2 bg-page/50 border-b border-border flex items-center justify-between gap-4">
                  <span className="font-mono text-xs text-text-primary truncate" title={selectedFile.filePath}>
                    {selectedFile.filePath}
                  </span>
                  <div className="flex items-center gap-1.5 text-2xs font-mono">
                    <span className="text-success bg-success/15 border border-success/20 px-1.5 py-0.5 rounded flex items-center gap-0.5">
                      <Plus className="w-3 h-3" /> {selectedFile.additions}
                    </span>
                    <span className="text-danger bg-danger/15 border border-danger/20 px-1.5 py-0.5 rounded flex items-center gap-0.5">
                      <Minus className="w-3 h-3" /> {selectedFile.deletions}
                    </span>
                  </div>
                </div>

                <div className="p-3 bg-page overflow-x-auto">
                  {selectedFile.patch ? (
                    <pre className="font-mono text-2xs leading-relaxed select-text space-y-0.5">
                      {selectedFile.patch.split("\n").map((line, idx) => {
                        let lineClass = "text-text-secondary";
                        if (line.startsWith("+")) {
                          lineClass = "bg-success/10 text-success font-medium border-l-2 border-success pl-1 -mx-3 px-3";
                        } else if (line.startsWith("-")) {
                          lineClass = "bg-danger/10 text-danger font-medium border-l-2 border-danger pl-1 -mx-3 px-3";
                        } else if (line.startsWith("@@")) {
                          lineClass = "text-accent/60 bg-accent/5 font-semibold -mx-3 px-3 py-0.5";
                        }
                        return (
                          <div key={idx} className={`${lineClass} whitespace-pre`}>
                            {line}
                          </div>
                        );
                      })}
                    </pre>
                  ) : (
                    <div className="py-20 text-center text-text-muted italic text-xs">
                      No patch content available.
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="bg-card border border-border rounded-xl p-8 text-center text-text-muted italic text-xs">
                Select a file to inspect.
              </div>
            )}

            <div className="bg-card border border-border rounded-xl p-3 flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
                  <GitMerge className="w-4 h-4 text-success" />
                  Merge Selected Changes
                </h3>
                <p className="text-xs text-text-secondary leading-relaxed">
                  {pendingReviewJobs.length > 0
                    ? "Dry-run is checking the selected files against the selected child repos."
                    : mergeableJobIds.length > 0
                      ? `${mergeableJobIds.length} repo job${mergeableJobIds.length === 1 ? "" : "s"} ready to merge.`
                      : appliedJobs.length > 0
                        ? nothingToMergeJobs.length === appliedJobs.length
                          ? "Nothing to merge. The selected changes are already in the child repo."
                          : "Selected changes have already been applied."
                        : conflictJobs.length > 0
                          ? "Conflicts were found. Open Sync Targeting & Dry-Run to review them."
                          : failedJobs.length > 0
                            ? "Merge check failed. Open Sync Targeting & Dry-Run to see the error."
                            : "No dry-run result is ready yet."}
                </p>
              </div>

              <div className="flex items-center gap-2">
                {isAnyJobRunning && (
                  <span className="text-3xs bg-accent/15 border border-accent/20 px-2.5 py-1 rounded-full text-accent flex items-center gap-1.5">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Checking...
                  </span>
                )}
                {(conflictJobs.length > 0 || failedJobs.length > 0) && (
                  <Button
                    variant="secondary"
                    onClick={() => setActiveTab("sync")}
                    className="text-xs"
                  >
                    Review Results
                  </Button>
                )}
                <Button
                  onClick={() => applySyncJobsMutation.mutate()}
                  disabled={mergeableJobIds.length === 0 || applySyncJobsMutation.isPending || isAnyJobRunning}
                  className="text-xs flex items-center gap-1.5 bg-success hover:bg-success/80 text-white"
                >
                  {applySyncJobsMutation.isPending ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        Checking...
                      </>
                  ) : (
                    <>
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Merge Repos ({mergeableJobIds.length})
                    </>
                  )}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === "sync" && (
        <div className="space-y-4 min-w-0">
          {/* Top section: Configuration options */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 min-w-0">
            {/* Column 1: Repo Selector */}
            <div className="bg-card border border-border rounded-xl p-3 space-y-3 min-w-0">
              <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
                <Server className="w-4 h-4 text-accent" />
                Target Client Repositories
              </h3>
              <p className="text-xs text-text-secondary leading-relaxed">
                Select the target client repositories you wish to deploy code synchronization to.
              </p>

              {scopedClientRepos.length > 0 ? (
                <div className="space-y-2 pt-2">
                  {scopedClientRepos.map((repo) => {
                    const isChecked = selectedRepoIds.includes(repo.id);
                    return (
                      <label
                        key={repo.id}
                        className={`flex items-center gap-3 p-2.5 rounded-lg border cursor-pointer transition-all ${
                          isChecked
                            ? "bg-accent/10 border-accent/30 text-text-primary"
                            : "bg-page/50 border-border hover:border-border-light text-text-secondary"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => handleRepoToggle(repo.id)}
                          className="w-4.5 h-4.5 rounded border-border text-accent focus:ring-accent bg-page cursor-pointer"
                        />
                        <div className="flex flex-col min-w-0">
                          <span className="text-xs font-semibold truncate">
                            {repo.customerName || repo.githubName}
                          </span>
                          <span className="text-3xs text-text-muted font-mono truncate">
                            {repo.fullName} ({repo.branch})
                          </span>
                        </div>
                      </label>
                    );
                  })}
                </div>
              ) : (
                <div className="p-4 bg-page/50 border border-dashed border-border rounded-lg text-center text-text-muted text-xs">
                  No target client repositories were selected for this sync.
                </div>
              )}
            </div>

            {/* Column 2 & 3: File Sync targeting matrix */}
            <div className="lg:col-span-2 bg-card border border-border rounded-xl p-3 space-y-3 flex flex-col justify-between min-w-0">
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
                  <Settings className="w-4 h-4 text-accent" />
                  Granular File Synchronization Matrix
                </h3>
                <p className="text-xs text-text-secondary leading-relaxed">
                  Specify exactly which files should sync to which destination client repositories.
                </p>

                {selectedRepoIds.length > 0 ? (
                  <div className="border border-border rounded-lg overflow-hidden bg-page mt-3 max-h-[300px] overflow-y-auto">
                    <table className="w-full text-left text-xs border-collapse">
                      <thead>
                        <tr className="bg-card border-b border-border text-3xs text-text-muted uppercase font-bold tracking-wider">
                          <th className="p-3">File Path</th>
                          {selectedRepoIds.map((repoId) => {
                            const repo = scopedClientRepos.find((r) => r.id === repoId);
                            return (
                              <th key={repoId} className="p-3 text-center min-w-[100px] truncate max-w-[120px]">
                                <div className="flex flex-col items-center gap-1">
                                  <span className="text-text-primary text-2xs truncate block w-full text-center">
                                    {repo?.customerName || repo?.githubName}
                                  </span>
                                  <button
                                    onClick={() => handleToggleAllFilesForRepo(repoId, allFilePaths)}
                                    className="text-[10px] text-accent hover:underline font-medium normal-case"
                                  >
                                    Toggle All
                                  </button>
                                </div>
                              </th>
                            );
                          })}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/60">
                        {files.map((file) => (
                          <tr key={file.id} className="hover:bg-card-hover/20">
                            <td className="p-3 font-mono text-3xs text-text-secondary truncate max-w-[200px]" title={file.filePath}>
                              {file.filePath}
                            </td>
                            {selectedRepoIds.map((repoId) => {
                              const repoSelectedFiles = fileSelection[repoId] || [];
                              const isChecked = repoSelectedFiles.includes(file.filePath);
                              return (
                                <td key={repoId} className="p-3 text-center">
                                  <input
                                    type="checkbox"
                                    checked={isChecked}
                                    onChange={() => handleFileToggle(repoId, file.filePath)}
                                    className="w-4 h-4 rounded border-border text-accent focus:ring-accent bg-page cursor-pointer"
                                  />
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="p-6 bg-page/50 border border-dashed border-border rounded-lg text-center text-text-muted text-xs leading-relaxed">
                    No target repositories selected. <br />
                    Check client targets on the left to activate file mapping.
                  </div>
                )}
              </div>

              {selectedRepoIds.length > 0 && (
                <div className="pt-4 border-t border-border flex justify-end">
                  <Button
                    onClick={handleRunDryRun}
                    disabled={createSyncJobsMutation.isPending || isAnyJobRunning}
                    className="text-xs flex items-center gap-1.5"
                  >
                    {createSyncJobsMutation.isPending || isAnyJobRunning ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        Running Analysis...
                      </>
                    ) : (
                      <>
                        <Play className="w-3.5 h-3.5 fill-current" />
                        Run Dry-Run Conflict Check
                      </>
                    )}
                  </Button>
                </div>
              )}
            </div>
          </div>

          {/* Sync Jobs Results Stream */}
          <div className="space-y-3 min-w-0">
            <div className="flex items-center justify-between border-b border-border pb-2 gap-4">
              <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
                <GitMerge className="w-4.5 h-4.5 text-accent" />
                Dry-Run Analysis Reports
              </h3>
              <div className="flex items-center gap-3">
                {isAnyJobRunning && (
                  <span className="text-3xs bg-accent/15 border border-accent/20 px-2.5 py-0.5 rounded-full text-accent flex items-center gap-1.5">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Running check...
                  </span>
                )}
                {mergeableJobIds.length > 0 && (
                  <Button
                    onClick={() => applySyncJobsMutation.mutate()}
                    disabled={applySyncJobsMutation.isPending || isAnyJobRunning}
                    className="text-xs flex items-center gap-1 bg-success hover:bg-success/80 text-white shadow-glow h-8"
                  >
                    {applySyncJobsMutation.isPending ? (
                      <>
                        <Loader2 className="w-3 h-3 animate-spin" />
                        Checking...
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="w-3 h-3" />
                        Merge Repos ({mergeableJobIds.length})
                      </>
                    )}
                  </Button>
                )}
              </div>
            </div>

            {syncJobs.length > 0 ? (
              <div className="space-y-3 min-w-0">
                {syncJobs.map((job) => (
                  <div
                    key={job.id}
                    className="bg-card border border-border rounded-xl p-3 space-y-3 min-w-0 overflow-hidden"
                  >
                    {/* Job Header Info */}
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/40 pb-3">
                      <div className="flex items-center gap-2.5">
                        <span className="text-xs font-semibold text-text-primary">
                          {job.targetRepo?.customerName || job.targetRepo?.githubName}
                        </span>
                        <span className="font-mono text-3xs text-text-muted">
                          {job.targetRepo?.fullName}
                        </span>
                      </div>

                      <div className="flex items-center gap-3">
                        <span className={`inline-flex items-center gap-1.5 text-2xs font-semibold px-2 py-0.5 rounded-full border ${getStatusClass(job.status)}`}>
                          {getStatusIcon(job.status)}
                          <span className="uppercase">{job.status}</span>
                        </span>

                        {job.status === "APPLIED" ? (
                          <div className="flex items-center gap-2">
                            <span className="text-3xs bg-success/15 border border-success/20 px-2 py-0.5 rounded text-success font-semibold flex items-center gap-1">
                              {job.errorMessage === "Already up to date"
                                ? "Nothing to merge"
                                : "Merged"}
                            </span>
                            {job.prUrl && (
                              <a
                                href={job.prUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-3xs px-2.5 py-1 rounded border border-border hover:bg-card-hover text-text-secondary hover:text-text-primary transition-colors font-medium"
                              >
                                <span>Details #{job.prNumber}</span>
                                <ExternalLink className="w-3 h-3" />
                              </a>
                            )}
                          </div>
                        ) : (
                          <Button
                            variant="secondary"
                            onClick={() => retryDryRunMutation.mutate(job.id)}
                            disabled={retryDryRunMutation.isPending || isAnyJobRunning}
                            className="h-7 px-2.5 text-3xs flex items-center gap-1"
                          >
                            <RotateCcw className="w-3 h-3" /> Re-Check
                          </Button>
                        )}
                      </div>
                    </div>

                    {/* Job Files summary */}
                    <div className="space-y-4 min-w-0">
                      {job.errorMessage && job.errorMessage !== "Already up to date" && (() => {
                        const isApplyStage = Boolean(job.branchName || job.prNumber);
                        const isWarning = job.status === "APPLIED";
                        const errorLabel = job.status === "CONFLICT"
                          ? "Merge conflict:"
                          : isApplyStage
                            ? "Apply failure:"
                            : "Dry-run failure:";
                        const colorClass = isWarning
                          ? "bg-warning/10 border-warning/20 text-warning"
                          : "bg-danger/10 border-danger/20 text-danger";
                        return (
                          <div className={`p-3 ${colorClass} rounded-lg text-xs flex items-start gap-2`}>
                            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                            <div className="space-y-1">
                              <p className="font-semibold">
                                {isWarning ? "Note:" : errorLabel}
                              </p>
                              <p className="font-mono text-3xs leading-relaxed">{job.errorMessage}</p>
                            </div>
                          </div>
                        );
                      })()}

                      {/* List of files status */}
                      {(() => {
                        const jobFiles = job.files || [];
                        const conflictsCount = jobFiles.filter((f) => f.mergeResult === "CONFLICT").length;
                        const mergedCount = jobFiles.filter((f) => f.mergeResult === "MERGED").length;
                        const cleanCount = jobFiles.filter((f) => f.mergeResult === "CLEAN").length;

                        const sortedFiles = [...jobFiles]
                          .filter((file) => {
                            if (syncFileFilter === "ALL") return true;
                            return file.mergeResult === syncFileFilter;
                          })
                          .sort((a, b) => {
                            const score = (result: string | null) => {
                              if (result === "CONFLICT") return 3;
                              if (result === "MERGED") return 2;
                              if (result === "CLEAN") return 1;
                              return 0;
                            };
                            return score(b.mergeResult) - score(a.mergeResult);
                          });

                        const isShowingAll = showAllFilesMap[job.id] || false;
                        const displayedFiles = isShowingAll ? sortedFiles : sortedFiles.slice(0, 48);
                        const hasMoreFiles = sortedFiles.length > 48;

                        return (
                          <>
                            <div className="flex flex-wrap items-center justify-between gap-4 pt-2 border-t border-border/40">
                              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-text-muted">
                                <span>
                                  <strong className="text-success">DIRECT</strong> file can be copied into the child repo without extra changes.
                                </span>
                                <span>
                                  <strong className="text-accent">AUTO-MERGE</strong> child repo also changed this file, but RepoBridge can combine both versions safely.
                                </span>
                                <span>
                                  <strong className="text-warning">CONFLICT</strong> both versions changed the same lines, so you need to choose the final content.
                                </span>
                              </div>

                              <div className="flex items-center gap-1 bg-page/80 p-0.5 rounded-lg border border-border">
                                <button
                                  type="button"
                                  onClick={() => setSyncFileFilter("ALL")}
                                  className={`px-2.5 py-1 rounded-md text-3xs font-semibold transition-all ${
                                    syncFileFilter === "ALL"
                                      ? "bg-card text-text-primary shadow-sm"
                                      : "text-text-muted hover:text-text-secondary"
                                  }`}
                                >
                                  All ({jobFiles.length})
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setSyncFileFilter("CONFLICT")}
                                  className={`px-2.5 py-1 rounded-md text-3xs font-semibold transition-all ${
                                    syncFileFilter === "CONFLICT"
                                      ? "bg-warning/10 text-warning border border-warning/10 shadow-sm"
                                      : "text-text-muted hover:text-text-secondary"
                                  }`}
                                >
                                  Conflicts ({conflictsCount})
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setSyncFileFilter("MERGED")}
                                  className={`px-2.5 py-1 rounded-md text-3xs font-semibold transition-all ${
                                    syncFileFilter === "MERGED"
                                      ? "bg-accent/10 text-accent border border-accent/10 shadow-sm"
                                      : "text-text-muted hover:text-text-secondary"
                                  }`}
                                >
                                  Auto-Merge ({mergedCount})
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setSyncFileFilter("CLEAN")}
                                  className={`px-2.5 py-1 rounded-md text-3xs font-semibold transition-all ${
                                    syncFileFilter === "CLEAN"
                                      ? "bg-success/10 text-success border border-success/10 shadow-sm"
                                      : "text-text-muted hover:text-text-secondary"
                                  }`}
                                >
                                  Direct ({cleanCount})
                                </button>
                              </div>
                            </div>

                            <div className="max-w-full overflow-x-auto overscroll-x-contain pb-2 rounded-lg border border-border/60 bg-page/20">
                              {displayedFiles.length > 0 ? (
                                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2 min-w-full md:min-w-[720px] lg:min-w-[980px] p-2">
                                  {displayedFiles.map((file) => {
                                    const isConflict = file.mergeResult === "CONFLICT";
                                    return (
                                      <div
                                        key={file.id}
                                        className={`p-2.5 rounded-lg border text-xs flex flex-col justify-between gap-2 ${
                                          isConflict
                                            ? "bg-warning/5 border-warning/30 text-warning"
                                            : file.mergeResult === "CLEAN"
                                            ? "bg-success/5 border-success/20 text-success"
                                            : file.mergeResult === "MERGED"
                                            ? "bg-accent/5 border-accent/20 text-accent"
                                            : "bg-page/50 border-border text-text-secondary"
                                        }`}
                                      >
                                        <div className="flex items-start justify-between gap-2 min-w-0">
                                          <span className="truncate block font-mono text-3xs" title={file.filePath}>
                                            {file.filePath}
                                          </span>
                                          <span className="text-[10px] font-bold uppercase whitespace-nowrap">
                                            {getFileMergeResultLabel(file)}
                                          </span>
                                        </div>

                                        {isConflict && (
                                          <div className="flex flex-wrap items-center gap-2 mt-1">
                                            <button
                                              onClick={() => openResolutionEditor(job, file.filePath, file.conflictDiff)}
                                              className="text-[10px] font-semibold text-success hover:underline flex items-center gap-0.5 self-start"
                                            >
                                              Resolve conflict
                                            </button>
                                            <button
                                              onClick={() => handleExcludeAndRetry(job, file.filePath)}
                                              className="text-[10px] font-semibold text-accent hover:underline flex items-center gap-0.5 self-start"
                                            >
                                              Exclude file & retry
                                            </button>
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              ) : (
                                <div className="p-6 text-center text-text-muted text-xs italic">
                                  No files matching the "{syncFileFilter.toLowerCase()}" filter.
                                </div>
                              )}
                            </div>

                            {hasMoreFiles && (
                              <div className="pt-1 flex justify-center">
                                <Button
                                  variant="secondary"
                                  onClick={() => setShowAllFilesMap((prev) => ({ ...prev, [job.id]: !isShowingAll }))}
                                  className="text-3xs h-7 px-3.5 flex items-center gap-1"
                                >
                                  {isShowingAll ? "Show Less" : `Show All ${sortedFiles.length} Files`}
                                </Button>
                              </div>
                            )}
                          </>
                        );
                      })()}

                        {/* Conflict Diff Box */}
                        {job.files?.map((file) => {
                          if (file.mergeResult === "CONFLICT" && file.conflictDiff) {
                            const targetLabel = `${job.targetRepo?.fullName || "target"}:${job.targetRepo?.branch || "branch"}`;
                            const sourceLabel = `${event?.repository?.fullName || "main"}:${event?.branch || "branch"}`;
                            return (
                              <div
                                key={file.id}
                                className="border border-warning/30 rounded-lg overflow-hidden"
                              >
                                <div className="px-3.5 py-2 bg-warning/10 border-b border-warning/20 text-warning text-xs font-semibold flex items-center gap-1.5">
                                  <AlertTriangle className="w-4 h-4" />
                                  <span>Conflict in {file.filePath}</span>
                                </div>
                                <div className="px-2.5 py-1.5 bg-page/80 border-b border-border flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px]">
                                  <span className="flex items-center gap-1">
                                    <span className="w-2.5 h-2.5 rounded-sm bg-red-500/40 border border-red-500/60 inline-block" />
                                    <span className="text-red-400 font-semibold">{targetLabel}</span>
                                    <span className="text-text-muted">(target branch)</span>
                                  </span>
                                  <span className="flex items-center gap-1">
                                    <span className="w-2.5 h-2.5 rounded-sm bg-blue-500/40 border border-blue-500/60 inline-block" />
                                    <span className="text-blue-400 font-semibold">{sourceLabel}</span>
                                    <span className="text-text-muted">(source branch)</span>
                                  </span>
                                </div>
                                <div className="p-3 bg-page overflow-x-auto">
                                  <pre className="font-mono text-3xs leading-relaxed select-text space-y-0">
                                    {renderConflictDiff(file.conflictDiff, targetLabel, sourceLabel)}
                                  </pre>
                                </div>
                              </div>
                            );
                          }
                          return null;
                        })}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="bg-card border border-border rounded-xl p-8 text-center text-text-secondary">
                <div className="w-12 h-12 bg-border rounded-2xl flex items-center justify-center mb-4 mx-auto">
                  <HelpCircle className="w-6 h-6 text-text-muted" />
                </div>
                <h4 className="text-xs font-semibold text-text-primary mb-1">No analysis reports generated yet</h4>
                <p className="text-3xs text-text-muted max-w-sm mx-auto leading-relaxed">
                  Select target client repositories above and run the conflict analysis dry-run check.
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {resolutionDraft && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-card border border-border rounded-xl shadow-glow-lg w-full max-w-5xl max-h-[90vh] overflow-hidden flex flex-col">
            <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-4">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-text-primary">Resolve Conflict</h3>
                <p className="text-3xs text-text-muted font-mono truncate mt-0.5">
                  {resolutionDraft.filePath}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setResolutionDraft(null)}
                className="text-text-muted hover:text-text-primary transition-colors"
              >
                <XCircle className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 space-y-3 overflow-y-auto">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                <div className="bg-red-500/5 border border-red-500/20 rounded-lg p-3">
                  <p className="text-3xs text-red-400 uppercase font-bold flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-sm bg-red-500/50 border border-red-500 inline-block" />
                    Target Branch (will be modified)
                  </p>
                  <p className="font-mono text-text-primary truncate mt-1">{resolutionDraft.currentLabel}</p>
                </div>
                <div className="bg-blue-500/5 border border-blue-500/20 rounded-lg p-3">
                  <p className="text-3xs text-blue-400 uppercase font-bold flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-sm bg-blue-500/50 border border-blue-500 inline-block" />
                    Source Branch (incoming changes)
                  </p>
                  <p className="font-mono text-text-primary truncate mt-1">{resolutionDraft.incomingLabel}</p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {resolutionDraft.content === resolutionDraft.originalContent ? (
                  <>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => setResolutionDraft({
                        ...resolutionDraft,
                        content: applyConflictChoice(resolutionDraft.originalContent, "current"),
                      })}
                      className="text-3xs h-8 border-red-500/30 hover:border-red-500/50 text-red-400 hover:bg-red-500/10"
                    >
                      Accept Target ({resolutionDraft.currentLabel.split(":")[0]?.split("/").pop() || "target"})
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => setResolutionDraft({
                        ...resolutionDraft,
                        content: applyConflictChoice(resolutionDraft.originalContent, "incoming"),
                      })}
                      className="text-3xs h-8 border-blue-500/30 hover:border-blue-500/50 text-blue-400 hover:bg-blue-500/10"
                    >
                      Accept Source ({resolutionDraft.incomingLabel.split(":")[0]?.split("/").pop() || "source"})
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => setResolutionDraft({
                        ...resolutionDraft,
                        content: applyConflictChoice(resolutionDraft.originalContent, "both"),
                      })}
                      className="text-3xs h-8"
                    >
                      Keep Both
                    </Button>
                    <span className="text-3xs text-text-muted">
                      Or edit manually below.
                    </span>
                  </>
                ) : (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setResolutionDraft({
                      ...resolutionDraft,
                      content: resolutionDraft.originalContent,
                    })}
                    className="text-3xs h-8 border-warning/30 hover:border-warning/50 text-warning hover:bg-warning/10 flex items-center gap-1.5"
                  >
                    <Undo2 className="w-3.5 h-3.5" />
                    Undo &mdash; Revert to Original Conflict
                  </Button>
                )}
              </div>

              <div className="text-xs text-text-secondary bg-page/60 border border-border rounded-lg p-3 leading-relaxed">
                Choose an option, then review the final content. Save each conflicted file, then merge once all conflicts are resolved.
              </div>
              <textarea
                value={resolutionDraft.content}
                onChange={(e) => setResolutionDraft({ ...resolutionDraft, content: e.target.value })}
                className="w-full min-h-[420px] rounded-lg bg-page border border-border hover:border-border-light focus:border-accent p-3 text-xs text-text-primary placeholder:text-text-muted focus:outline-none transition-colors resize-y font-mono leading-relaxed"
                spellCheck={false}
              />
            </div>

            <div className="px-4 py-3 border-t border-border flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <p className="text-3xs text-text-muted">
                This only saves the file resolution. Merge after every conflicted file is saved.
              </p>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setResolutionDraft(null)}
                  className="text-xs"
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={submitResolution}
                  disabled={resolveConflictMutation.isPending}
                  className="text-xs bg-success hover:bg-success/80 text-white flex items-center gap-1.5"
                >
                  {resolveConflictMutation.isPending ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Submitting...
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Resolve & Save
                    </>
                  )}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
