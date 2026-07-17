import {
  useCallback,
  type CSSProperties,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { animate } from 'motion/mini';
import type { AnimationPlaybackControlsWithThen } from 'motion-dom';
import { useInterval } from '@/hooks/useInterval';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useActionBarHeightVar } from '@/hooks/useActionBarHeightVar';
import { usePageTransitionLayer } from '@/components/common/PageTransitionLayer';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { IconFilterAll, IconSearch } from '@/components/ui/icons';
import { EmptyState } from '@/components/ui/EmptyState';
import {
  ANTIGRAVITY_CONFIG,
  CLAUDE_CONFIG,
  CODEX_CONFIG,
  KIMI_CONFIG,
  XAI_CONFIG,
  hydrateGuardianSnapshots,
  type QuotaConfig,
} from '@/components/quota';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { AuthFilesStatusFilterCard } from '@/features/authFiles/components/AuthFilesStatusFilterCard';
import { copyToClipboard } from '@/utils/clipboard';
import { getStatusFromError, resolveAuthProvider } from '@/utils/quota';
import { quotaGuardianApi } from '@/services/api';
import type { AuthFileItem } from '@/types';
import {
  AUTH_FILE_PAGE_SIZES,
  QUOTA_PROVIDER_TYPES,
  clampCardPageSize,
  getAuthFileModifiedTimestamp,
  getAuthFileStatusMessage,
  getAuthFileIcon,
  getTypeColor,
  getTypeLabel,
  HEALTHY_STATUS_MESSAGES,
  isRuntimeOnlyAuthFile,
  normalizeProviderKey,
  parsePriorityValue,
  type QuotaProviderType,
  type ResolvedTheme,
} from '@/features/authFiles/constants';
import { AuthFileCard } from '@/features/authFiles/components/AuthFileCard';
import { AuthFileList, type AuthFileListColumn } from '@/features/authFiles/components/AuthFileList';
import { AuthFileModelsModal } from '@/features/authFiles/components/AuthFileModelsModal';
import { AuthFilesPrefixProxyEditorModal } from '@/features/authFiles/components/AuthFilesPrefixProxyEditorModal';
import { useAuthFilesData } from '@/features/authFiles/hooks/useAuthFilesData';
import { useAuthFilesModels } from '@/features/authFiles/hooks/useAuthFilesModels';
import { useAuthFilesOauth } from '@/features/authFiles/hooks/useAuthFilesOauth';
import { useAuthFilesPrefixProxyEditor } from '@/features/authFiles/hooks/useAuthFilesPrefixProxyEditor';
import { useAuthFilesStatusBarCache } from '@/features/authFiles/hooks/useAuthFilesStatusBarCache';
import {
  isAuthFilesStatusFilterMode,
  isAuthFilesSortMode,
  readAuthFilesUiState,
  readPersistedAuthFilesCompactMode,
  writeAuthFilesUiState,
  writePersistedAuthFilesCompactMode,
  type AuthFilesStatusFilterMode,
  type AuthFilesSortMode,
  type AuthFilesDisplayMode,
} from '@/features/authFiles/uiState';
import { useAuthStore, useNotificationStore, useQuotaStore, useThemeStore } from '@/stores';
import styles from './AuthFilesPage.module.scss';

const easePower3Out = (progress: number) => 1 - (1 - progress) ** 4;
const easePower2In = (progress: number) => progress ** 3;
const BATCH_BAR_BASE_TRANSFORM = 'translateX(-50%)';
const BATCH_BAR_HIDDEN_TRANSFORM = 'translateX(-50%) translateY(56px)';
const DEFAULT_REGULAR_PAGE_SIZE = 10;
const DEFAULT_COMPACT_PAGE_SIZE = 10;

type QuotaSetter<TState> = (
  updater: Record<string, TState> | ((previous: Record<string, TState>) => Record<string, TState>)
) => void;

const refreshQuotaGroup = async <TState, TData>(
  config: QuotaConfig<TState, TData>,
  files: AuthFileItem[],
  t: TFunction,
  setQuota: QuotaSetter<TState>
) => {
  const targets = files.filter(config.filterFn);
  if (targets.length === 0) return;

  setQuota((previous) => {
    const next = { ...previous };
    targets.forEach((file) => {
      next[file.name] = config.buildLoadingState();
    });
    return next;
  });

  const results = await Promise.all(
    targets.map(async (file) => {
      try {
        return { name: file.name, data: await config.fetchQuota(file, t) };
      } catch (error: unknown) {
        return {
          name: file.name,
          error: error instanceof Error ? error.message : t('common.unknown_error'),
          errorStatus: getStatusFromError(error),
        };
      }
    })
  );

  setQuota((previous) => {
    const next = { ...previous };
    results.forEach((result) => {
      next[result.name] = 'data' in result
        ? config.buildSuccessState(result.data as TData)
        : config.buildErrorState(result.error, result.errorStatus);
    });
    return next;
  });
};

const escapeWildcardSearchSegment = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const buildWildcardSearch = (value: string): RegExp | null => {
  if (!value.includes('*')) return null;
  const pattern = value.split('*').map(escapeWildcardSearchSegment).join('.*');
  return new RegExp(pattern, 'i');
};

const resolveStatusFilterMode = (
  problemOnly: boolean,
  disabledOnly: boolean
): AuthFilesStatusFilterMode => {
  if (problemOnly) return 'problem';
  if (disabledOnly) return 'disabled';
  return 'all';
};

const normalizePersistedStatusFilterMode = (value: unknown): AuthFilesStatusFilterMode | null => {
  if (value === 'disabledProblem') return 'problem';
  return isAuthFilesStatusFilterMode(value) ? value : null;
};

export function AuthFilesPage() {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const resolvedTheme: ResolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const antigravityQuota = useQuotaStore((state) => state.antigravityQuota);
  const claudeQuota = useQuotaStore((state) => state.claudeQuota);
  const codexQuota = useQuotaStore((state) => state.codexQuota);
  const kimiQuota = useQuotaStore((state) => state.kimiQuota);
  const xaiQuota = useQuotaStore((state) => state.xaiQuota);
  const setAntigravityQuota = useQuotaStore((state) => state.setAntigravityQuota);
  const setClaudeQuota = useQuotaStore((state) => state.setClaudeQuota);
  const setCodexQuota = useQuotaStore((state) => state.setCodexQuota);
  const setKimiQuota = useQuotaStore((state) => state.setKimiQuota);
  const setXaiQuota = useQuotaStore((state) => state.setXaiQuota);
  const pageTransitionLayer = usePageTransitionLayer();
  const isCurrentLayer = pageTransitionLayer ? pageTransitionLayer.status === 'current' : true;

  const [filter, setFilter] = useState<'all' | string>('all');
  const [statusFilterMode, setStatusFilterMode] = useState<AuthFilesStatusFilterMode>('all');
  const [compactMode, setCompactMode] = useState(false);
  const [visibleColumns, setVisibleColumns] = useState<Record<AuthFileListColumn, boolean>>({
    type: true,
    status: true,
    modified: true,
    remaining: true,
    subscription: true,
    health: true,
    enabled: true,
    priority: true,
  });
  const [displayMode, setDisplayMode] = useState<AuthFilesDisplayMode>('list');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSizeByMode, setPageSizeByMode] = useState({
    regular: DEFAULT_REGULAR_PAGE_SIZE,
    compact: DEFAULT_COMPACT_PAGE_SIZE,
  });
  const [sortMode, setSortMode] = useState<AuthFilesSortMode>('default');
  const columnVisibilityRef = useRef<HTMLDetailsElement | null>(null);
  const columnOptions: Array<{ key: AuthFileListColumn; label: string }> = [
    { key: 'type', label: t('auth_files.list_type') },
    { key: 'status', label: t('auth_files.list_status') },
    { key: 'modified', label: t('auth_files.file_modified') },
    { key: 'remaining', label: t('auth_files.remaining_quota') },
    { key: 'subscription', label: t('auth_files.list_subscription') },
    { key: 'health', label: t('auth_files.health_status_label') },
    { key: 'enabled', label: t('auth_files.list_enabled') },
    { key: 'priority', label: t('auth_files.priority_display') },
  ];

  useEffect(() => {
    const handleColumnVisibilityOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!columnVisibilityRef.current?.contains(target)) {
        columnVisibilityRef.current?.removeAttribute('open');
      }
    };
    document.addEventListener('mousedown', handleColumnVisibilityOutsideClick);
    return () => document.removeEventListener('mousedown', handleColumnVisibilityOutsideClick);
  }, []);
  const [batchActionBarVisible, setBatchActionBarVisible] = useState(false);
  const [uiStateHydrated, setUiStateHydrated] = useState(false);
  const [quotaRefreshing, setQuotaRefreshing] = useState(false);
  const floatingBatchActionsRef = useRef<HTMLDivElement>(null);
  const quotaSnapshotsHydratedRef = useRef(false);
  const batchActionAnimationRef = useRef<AnimationPlaybackControlsWithThen | null>(null);
  const previousSelectionCountRef = useRef(0);
  const selectionCountRef = useRef(0);

  const {
    files,
    selectedFiles,
    selectionCount,
    loading,
    error,
    uploading,
    deleting,
    deletingAll,
    statusUpdating,
    batchStatusUpdating,
    fileInputRef,
    loadFiles,
    handleUploadClick,
    handleFileChange,
    handleDelete,
    handleDeleteAll,
    handleDownload,
    handleStatusToggle,
    toggleSelect,
    selectAllVisible,
    invertVisibleSelection,
    deselectAll,
    batchDownload,
    batchSetStatus,
    batchDelete,
  } = useAuthFilesData();

  const statusBarCache = useAuthFilesStatusBarCache(files);

  const {
    excluded,
    loadExcluded,
    loadModelAlias,
  } = useAuthFilesOauth({ viewMode: 'list', files });

  const {
    modelsModalOpen,
    modelsLoading,
    modelsList,
    modelsFileName,
    modelsFileType,
    modelsError,
    showModels,
    closeModelsModal,
  } = useAuthFilesModels();

  const {
    prefixProxyEditor,
    prefixProxyUpdatedText,
    prefixProxyDirty,
    openPrefixProxyEditor,
    closePrefixProxyEditor,
    handlePrefixProxyChange,
    handlePrefixProxySave,
  } = useAuthFilesPrefixProxyEditor({
    disableControls: connectionStatus !== 'connected',
    loadFiles,
  });

  const disableControls = connectionStatus !== 'connected';
  const normalizedFilter = normalizeProviderKey(String(filter));
  const quotaFilterType: QuotaProviderType | null = QUOTA_PROVIDER_TYPES.has(
    normalizedFilter as QuotaProviderType
  )
    ? (normalizedFilter as QuotaProviderType)
    : null;
  const pageSize = compactMode ? pageSizeByMode.compact : pageSizeByMode.regular;
  const problemOnly = statusFilterMode === 'problem';
  const disabledOnly = statusFilterMode === 'disabled';
  const enabledOnly = statusFilterMode === 'enabled';

  useEffect(() => {
    const persistedCompactMode = readPersistedAuthFilesCompactMode();
    if (typeof persistedCompactMode === 'boolean') {
      setCompactMode(persistedCompactMode);
    }

    const persisted = readAuthFilesUiState();
    if (persisted) {
      if (typeof persisted.filter === 'string' && persisted.filter.trim()) {
        setFilter(normalizeProviderKey(persisted.filter));
      }
      const persistedStatusFilterMode = normalizePersistedStatusFilterMode(
        persisted.statusFilterMode
      );
      if (persistedStatusFilterMode) {
        setStatusFilterMode(persistedStatusFilterMode);
      } else if (
        typeof persisted.problemOnly === 'boolean' ||
        typeof persisted.disabledOnly === 'boolean'
      ) {
        setStatusFilterMode(
          resolveStatusFilterMode(persisted.problemOnly === true, persisted.disabledOnly === true)
        );
      }
      if (typeof persistedCompactMode !== 'boolean' && typeof persisted.compactMode === 'boolean') {
        setCompactMode(persisted.compactMode);
      }
      if (persisted.displayMode === 'card' || persisted.displayMode === 'list') {
        setDisplayMode(persisted.displayMode);
      }
      if (typeof persisted.search === 'string') {
        setSearch(persisted.search);
      }
      if (typeof persisted.page === 'number' && Number.isFinite(persisted.page)) {
        setPage(Math.max(1, Math.round(persisted.page)));
      }
      const legacyPageSize =
        typeof persisted.pageSize === 'number' && Number.isFinite(persisted.pageSize)
          ? clampCardPageSize(persisted.pageSize)
          : null;
      const regularPageSize =
        typeof persisted.regularPageSize === 'number' && Number.isFinite(persisted.regularPageSize)
          ? clampCardPageSize(persisted.regularPageSize)
          : (legacyPageSize ?? DEFAULT_REGULAR_PAGE_SIZE);
      const compactPageSize =
        typeof persisted.compactPageSize === 'number' && Number.isFinite(persisted.compactPageSize)
          ? clampCardPageSize(persisted.compactPageSize)
          : (legacyPageSize ?? DEFAULT_COMPACT_PAGE_SIZE);
      setPageSizeByMode({
        regular: regularPageSize,
        compact: compactPageSize,
      });
      if (isAuthFilesSortMode(persisted.sortMode)) {
        setSortMode(persisted.sortMode);
      }
    }

    setUiStateHydrated(true);
  }, []);

  useEffect(() => {
    if (!uiStateHydrated) return;

    writeAuthFilesUiState({
      filter,
      statusFilterMode,
      problemOnly,
      disabledOnly,
      compactMode,
      displayMode,
      search,
      page,
      pageSize,
      regularPageSize: pageSizeByMode.regular,
      compactPageSize: pageSizeByMode.compact,
      sortMode,
    });
    writePersistedAuthFilesCompactMode(compactMode);
  }, [
    compactMode,
    disabledOnly,
    displayMode,
    filter,
    page,
    pageSize,
    pageSizeByMode,
    problemOnly,
    search,
    sortMode,
    statusFilterMode,
    uiStateHydrated,
  ]);

  const setCurrentModePageSize = useCallback(
    (next: number) => {
      setPageSizeByMode((current) =>
        compactMode ? { ...current, compact: next } : { ...current, regular: next }
      );
    },
    [compactMode]
  );

  const handlePageSizeChange = (next: number) => {
    if (next === pageSize) return;
    setCurrentModePageSize(next);
    setPage(1);
  };

  const handleSortModeChange = useCallback(
    (value: string) => {
      if (!isAuthFilesSortMode(value) || value === sortMode) return;
      setSortMode(value);
      setPage(1);
    },
    [sortMode]
  );

  const handleStatusFilterModeChange = useCallback((nextMode: AuthFilesStatusFilterMode) => {
    setStatusFilterMode(nextMode);
    setPage(1);
  }, []);

  const existingTypes = useMemo(() => {
    const types = new Set<string>(['all']);
    files.forEach((file) => {
      const type = normalizeProviderKey(String(file.type ?? file.provider ?? ''));
      if (type) types.add(type);
    });
    return Array.from(types);
  }, [files]);

  const errorFileNames = useMemo(() => {
    const names = new Set<string>();

    files.forEach((file) => {
      const rawStatusMessage = getAuthFileStatusMessage(file);
      if (
        rawStatusMessage &&
        !HEALTHY_STATUS_MESSAGES.has(rawStatusMessage.toLowerCase())
      ) {
        names.add(file.name);
      }

      const provider = resolveAuthProvider(file);
      const quotaState =
        provider === 'antigravity'
          ? antigravityQuota[file.name]
          : provider === 'claude'
            ? claudeQuota[file.name]
            : provider === 'codex'
              ? codexQuota[file.name]
              : provider === 'kimi'
                ? kimiQuota[file.name]
                : provider === 'xai'
                  ? xaiQuota[file.name]
                  : undefined;

      if (quotaState?.status === 'error') {
        names.add(file.name);
      }
    });

    return names;
  }, [antigravityQuota, claudeQuota, codexQuota, files, kimiQuota, xaiQuota]);

  const filesMatchingStatusFilters = useMemo(
    () =>
      files.filter((file) => {
        if (enabledOnly && file.disabled === true) return false;
        if (disabledOnly && file.disabled !== true) return false;
        if (problemOnly && !errorFileNames.has(file.name)) return false;
        return true;
      }),
    [disabledOnly, enabledOnly, errorFileNames, files, problemOnly]
  );

  const statusFilterOptions = useMemo(
    () =>
      [
        { value: 'all', label: t('auth_files.problem_filter_all') },
        { value: 'enabled', label: t('auth_files.problem_filter_enabled') },
        { value: 'disabled', label: t('auth_files.problem_filter_disabled') },
        { value: 'problem', label: t('auth_files.problem_filter_problem') },
      ] satisfies Array<{ value: AuthFilesStatusFilterMode; label: string }>,
    [t]
  );

  const sortOptions = useMemo(
    () => [
      { value: 'default', label: t('auth_files.sort_default') },
      { value: 'az', label: t('auth_files.sort_az') },
      { value: 'priority', label: t('auth_files.sort_priority') },
      { value: 'modified', label: t('auth_files.sort_modified') },
    ],
    [t]
  );

  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = { all: filesMatchingStatusFilters.length };
    filesMatchingStatusFilters.forEach((file) => {
      const type = normalizeProviderKey(String(file.type ?? file.provider ?? ''));
      if (!type) return;
      counts[type] = (counts[type] || 0) + 1;
    });
    return counts;
  }, [filesMatchingStatusFilters]);

  const normalizedSearch = search.trim();
  const wildcardSearch = useMemo(() => buildWildcardSearch(normalizedSearch), [normalizedSearch]);

  const filtered = useMemo(() => {
    const normalizedTerm = normalizedSearch.toLowerCase();

    return filesMatchingStatusFilters.filter((item) => {
      const type = normalizeProviderKey(String(item.type ?? item.provider ?? ''));
      const matchType = normalizedFilter === 'all' || type === normalizedFilter;
      const matchSearch =
        !normalizedSearch ||
        [item.name, item.type, item.provider].some((value) => {
          const content = (value || '').toString();
          return wildcardSearch
            ? wildcardSearch.test(content)
            : content.toLowerCase().includes(normalizedTerm);
        });
      return matchType && matchSearch;
    });
  }, [filesMatchingStatusFilters, normalizedFilter, normalizedSearch, wildcardSearch]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    if (sortMode === 'default') {
      copy.sort((a, b) => {
        const providerA = normalizeProviderKey(String(a.provider ?? a.type ?? 'unknown'));
        const providerB = normalizeProviderKey(String(b.provider ?? b.type ?? 'unknown'));
        const providerCompare = providerA.localeCompare(providerB);
        if (providerCompare !== 0) return providerCompare;
        return a.name.localeCompare(b.name);
      });
    } else if (sortMode === 'az') {
      copy.sort((a, b) => a.name.localeCompare(b.name));
    } else if (sortMode === 'priority') {
      copy.sort((a, b) => {
        const pa = parsePriorityValue(a.priority) ?? 0;
        const pb = parsePriorityValue(b.priority) ?? 0;
        return pb - pa; // 高优先级排前面
      });
    } else if (sortMode === 'modified') {
      copy.sort((a, b) => getAuthFileModifiedTimestamp(b) - getAuthFileModifiedTimestamp(a));
    }
    return copy;
  }, [filtered, sortMode]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * pageSize;
  const pageItems = useMemo(() => sorted.slice(start, start + pageSize), [pageSize, sorted, start]);

  const loadQuotaSnapshots = useCallback(async (targetFiles: AuthFileItem[]) => {
    if (targetFiles.length === 0) return;
    const data = await quotaGuardianApi.snapshots();
    const hydrated = hydrateGuardianSnapshots(targetFiles, data.snapshots, t);
    // Guardian snapshots are a fallback; a manual refresh may be newer than the last guardian run.
    setClaudeQuota((previous) => ({ ...hydrated.claude, ...previous }));
    setCodexQuota((previous) => ({ ...hydrated.codex, ...previous }));
    setKimiQuota((previous) => ({ ...hydrated.kimi, ...previous }));
    setXaiQuota((previous) => ({ ...hydrated.xai, ...previous }));
  }, [setClaudeQuota, setCodexQuota, setKimiQuota, setXaiQuota, t]);

  const refreshQuotasForFiles = useCallback(async (targetFiles: AuthFileItem[]) => {
    if (targetFiles.length === 0) return;
    await Promise.all([
      refreshQuotaGroup(ANTIGRAVITY_CONFIG, targetFiles, t, setAntigravityQuota),
      refreshQuotaGroup(CLAUDE_CONFIG, targetFiles, t, setClaudeQuota),
      refreshQuotaGroup(CODEX_CONFIG, targetFiles, t, setCodexQuota),
      refreshQuotaGroup(KIMI_CONFIG, targetFiles, t, setKimiQuota),
      refreshQuotaGroup(XAI_CONFIG, targetFiles, t, setXaiQuota),
    ]);
  }, [setAntigravityQuota, setClaudeQuota, setCodexQuota, setKimiQuota, setXaiQuota, t]);

  const refreshVisibleQuotas = useCallback(async () => {
    if (pageItems.length === 0) return;
    setQuotaRefreshing(true);
    try {
      await refreshQuotasForFiles(pageItems);
    } finally {
      setQuotaRefreshing(false);
    }
  }, [pageItems, refreshQuotasForFiles]);

  const refreshQuotaForFile = useCallback(
    async (file: AuthFileItem) => refreshQuotasForFiles([file]),
    [refreshQuotasForFiles]
  );

  const handleFileUploadAndRefresh = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const previousNames = new Set(files.map((file) => file.name));
      const refreshedFiles = await handleFileChange(event);
      const newFiles = refreshedFiles.filter(
        (file) => !previousNames.has(file.name) && file.disabled !== true
      );
      await refreshQuotasForFiles(newFiles);
    },
    [files, handleFileChange, refreshQuotasForFiles]
  );

  const handleHeaderRefresh = useCallback(async () => {
    await Promise.all([loadFiles(), loadExcluded(), loadModelAlias(), refreshVisibleQuotas()]);
  }, [loadFiles, loadExcluded, loadModelAlias, refreshVisibleQuotas]);

  useHeaderRefresh(handleHeaderRefresh);

  useEffect(() => {
    if (!isCurrentLayer) return;
    loadFiles();
    loadExcluded();
    loadModelAlias();
  }, [isCurrentLayer, loadFiles, loadExcluded, loadModelAlias]);

  useEffect(() => {
    if (!isCurrentLayer || files.length === 0 || quotaSnapshotsHydratedRef.current) return;
    quotaSnapshotsHydratedRef.current = true;
    void loadQuotaSnapshots(files).catch(() => {
      quotaSnapshotsHydratedRef.current = false;
    });
  }, [files, isCurrentLayer, loadQuotaSnapshots]);

  useInterval(
    () => {
      void loadFiles().catch(() => {});
    },
    isCurrentLayer ? 240_000 : null
  );
  const selectablePageItems = useMemo(
    () => pageItems.filter((file) => !isRuntimeOnlyAuthFile(file)),
    [pageItems]
  );
  const selectableFilteredItems = useMemo(
    () => sorted.filter((file) => !isRuntimeOnlyAuthFile(file)),
    [sorted]
  );
  const selectedNames = useMemo(() => Array.from(selectedFiles), [selectedFiles]);
  const selectedHasStatusUpdating = useMemo(
    () => selectedNames.some((name) => statusUpdating[name] === true),
    [selectedNames, statusUpdating]
  );
  const batchStatusButtonsDisabled =
    disableControls ||
    selectedNames.length === 0 ||
    batchStatusUpdating ||
    selectedHasStatusUpdating;

  const copyTextWithNotification = useCallback(
    async (text: string) => {
      const copied = await copyToClipboard(text);
      showNotification(
        copied
          ? t('notification.link_copied', { defaultValue: 'Copied to clipboard' })
          : t('notification.copy_failed', { defaultValue: 'Copy failed' }),
        copied ? 'success' : 'error'
      );
    },
    [showNotification, t]
  );

  useActionBarHeightVar(
    floatingBatchActionsRef,
    '--auth-files-action-bar-height',
    batchActionBarVisible
  );

  useEffect(() => {
    selectionCountRef.current = selectionCount;
    if (selectionCount > 0) {
      setBatchActionBarVisible(true);
    }
  }, [selectionCount]);

  useLayoutEffect(() => {
    if (!batchActionBarVisible) return;
    const currentCount = selectionCount;
    const previousCount = previousSelectionCountRef.current;
    const actionsEl = floatingBatchActionsRef.current;
    if (!actionsEl) return;

    batchActionAnimationRef.current?.stop();
    batchActionAnimationRef.current = null;

    if (currentCount > 0 && previousCount === 0) {
      batchActionAnimationRef.current = animate(
        actionsEl,
        {
          transform: [BATCH_BAR_HIDDEN_TRANSFORM, BATCH_BAR_BASE_TRANSFORM],
          opacity: [0, 1],
        },
        {
          duration: 0.28,
          ease: easePower3Out,
          onComplete: () => {
            actionsEl.style.transform = BATCH_BAR_BASE_TRANSFORM;
            actionsEl.style.opacity = '1';
          },
        }
      );
    } else if (currentCount === 0 && previousCount > 0) {
      batchActionAnimationRef.current = animate(
        actionsEl,
        {
          transform: [BATCH_BAR_BASE_TRANSFORM, BATCH_BAR_HIDDEN_TRANSFORM],
          opacity: [1, 0],
        },
        {
          duration: 0.22,
          ease: easePower2In,
          onComplete: () => {
            if (selectionCountRef.current === 0) {
              setBatchActionBarVisible(false);
            }
          },
        }
      );
    }

    previousSelectionCountRef.current = currentCount;
  }, [batchActionBarVisible, selectionCount]);

  useEffect(
    () => () => {
      batchActionAnimationRef.current?.stop();
      batchActionAnimationRef.current = null;
    },
    []
  );

  const renderFilterTags = () => (
    <div className={styles.filterRail}>
      <div className={styles.filterTags}>
        {existingTypes.map((type) => {
          const isActive = normalizedFilter === type;
          const iconSrc = getAuthFileIcon(type, resolvedTheme);
          const color =
            type === 'all'
              ? { bg: 'var(--bg-tertiary)', text: 'var(--text-primary)' }
              : getTypeColor(type, resolvedTheme);
          const buttonStyle = {
            '--filter-color': color.text,
            '--filter-surface': color.bg,
            '--filter-active-text': resolvedTheme === 'dark' ? '#111827' : '#ffffff',
          } as CSSProperties;

          return (
            <button
              key={type}
              className={`${styles.filterTag} ${isActive ? styles.filterTagActive : ''}`}
              style={buttonStyle}
              onClick={() => {
                setFilter(type);
                setPage(1);
              }}
            >
              <span className={styles.filterTagLabel}>
                {type === 'all' ? (
                  <span className={`${styles.filterTagIconWrap} ${styles.filterAllIconWrap}`}>
                    <IconFilterAll className={styles.filterAllIcon} size={16} />
                  </span>
                ) : (
                  <span className={styles.filterTagIconWrap}>
                    {iconSrc ? (
                      <img src={iconSrc} alt="" className={styles.filterTagIcon} />
                    ) : (
                      <span className={styles.filterTagIconFallback}>
                        {getTypeLabel(t, type).slice(0, 1).toUpperCase()}
                      </span>
                    )}
                  </span>
                )}
                <span className={styles.filterTagText}>{getTypeLabel(t, type)}</span>
              </span>
              <span className={styles.filterTagCount}>{typeCounts[type] ?? 0}</span>
            </button>
          );
        })}
      </div>
      <div className={styles.filterRailSearch}>
        <Input
          className={styles.searchInput}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          placeholder={t('auth_files.search_placeholder')}
          rightElement={<IconSearch className={styles.searchIcon} size={17} />}
        />
      </div>
    </div>
  );

  const titleNode = (
    <div className={styles.titleWrapper}>
      <div className={styles.titleIdentity}>
        <span>{t('auth_files.title_section')}</span>
        {files.length > 0 && <span className={styles.countBadge}>{files.length}</span>}
      </div>
    </div>
  );

  const deleteAllButtonLabel = (() => {
    if (enabledOnly || disabledOnly) {
      return t('auth_files.delete_filtered_result_button');
    }
    if (problemOnly) {
      return normalizedFilter === 'all'
        ? t('auth_files.delete_problem_button')
        : t('auth_files.delete_problem_button_with_type', {
            type: getTypeLabel(t, normalizedFilter),
          });
    }
    return normalizedFilter === 'all'
      ? t('auth_files.delete_all_button')
      : `${t('common.delete')} ${getTypeLabel(t, normalizedFilter)}`;
  })();

  return (
    <div className={styles.container}>
      <div className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>{t('auth_files.title')}</h1>
        <p className={styles.description}>{t('auth_files.description')}</p>
      </div>

      <Card
        title={titleNode}
        extra={
          <div className={styles.headerActions}>
            <Button
              variant="secondary"
              size="sm"
              onClick={handleHeaderRefresh}
              disabled={loading || quotaRefreshing}
              loading={loading || quotaRefreshing}
            >
              {t('common.refresh')}
            </Button>
            <Button
              size="sm"
              onClick={handleUploadClick}
              disabled={disableControls || uploading}
              loading={uploading}
            >
              {t('auth_files.upload_button')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() =>
                handleDeleteAll({
                  filter,
                  problemOnly,
                  disabledOnly,
                  enabledOnly,
                  onResetFilterToAll: () => setFilter('all'),
                  onResetProblemOnly: () => setStatusFilterMode('all'),
                  onResetDisabledOnly: () => setStatusFilterMode('all'),
                  onResetEnabledOnly: () => setStatusFilterMode('all'),
                })
              }
              disabled={disableControls || loading || deletingAll}
              loading={deletingAll}
            >
              {deleteAllButtonLabel}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              multiple
              style={{ display: 'none' }}
              onChange={(event) => void handleFileUploadAndRefresh(event)}
            />
          </div>
        }
      >
        {error && <div className={styles.errorBox}>{error}</div>}

        <div className={styles.filterSection}>
          {renderFilterTags()}

          <div className={styles.filterContent}>
            <div className={styles.filterControlsPanel}>
              <div className={styles.filterControls}>
                <div className={styles.filterOptionsCard}>
                  <div className={styles.filterOptionsRow}>
                    <span className={styles.filterSettingLabel}>{t('auth_files.page_size_label')}</span>
                    <Select
                      className={styles.pageSizeDropdown}
                      size="sm"
                      value={String(pageSize)}
                      options={AUTH_FILE_PAGE_SIZES.map((size) => ({
                        value: String(size),
                        label: String(size),
                      }))}
                      onChange={(value) => handlePageSizeChange(Number(value))}
                      ariaLabel={t('auth_files.page_size_label')}
                    />
                  </div>
                  <div className={styles.filterOptionsRow}>
                    <span className={styles.filterSettingLabel}>{t('auth_files.compact_mode_label')}</span>
                    <ToggleSwitch
                      checked={compactMode}
                      onChange={(value) => setCompactMode(value)}
                      ariaLabel={t('auth_files.compact_mode_label')}
                    />
                  </div>
                  <details ref={columnVisibilityRef} className={styles.columnVisibilityDropdown}>
                    <summary>{t('auth_files.column_visibility_label')}</summary>
                    <div className={styles.columnVisibilityMenu}>
                      {columnOptions.map((option) => (
                        <label key={option.key} className={styles.columnVisibilityOption}>
                          <input
                            type="checkbox"
                            checked={visibleColumns[option.key]}
                            onChange={(event) =>
                              setVisibleColumns((current) => ({
                                ...current,
                                [option.key]: event.target.checked,
                              }))
                            }
                          />
                          <span>{option.label}</span>
                        </label>
                      ))}
                    </div>
                  </details>
                </div>
                <div className={`${styles.filterItem} ${styles.filterToggleItem}`}>
                  <AuthFilesStatusFilterCard
                    label={t('auth_files.problem_filter_label')}
                    value={statusFilterMode}
                    options={statusFilterOptions}
                    onChange={(next) =>
                      handleStatusFilterModeChange(next as AuthFilesStatusFilterMode)
                    }
                    center={
                      <div className={styles.sortModeControl}>
                        <span>{t('auth_files.sort_label')}</span>
                        <div className={styles.sortModeSwitch} role="group" aria-label={t('auth_files.sort_label')}>
                          {sortOptions.map((option) => (
                            <button
                              key={option.value}
                              type="button"
                              className={sortMode === option.value ? styles.sortModeActive : ''}
                              aria-pressed={sortMode === option.value}
                              onClick={() => handleSortModeChange(option.value)}
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    }
                    actions={
                      <div className={styles.displayModeControl}>
                        <span>{t('auth_files.display_style_label')}</span>
                        <div
                          className={styles.displayModeSwitch}
                          role="group"
                          aria-label={t('auth_files.display_style_label')}
                        >
                          <button
                            type="button"
                            className={displayMode === 'list' ? styles.displayModeActive : ''}
                            onClick={() => setDisplayMode('list')}
                          >
                            {t('auth_files.display_list')}
                          </button>
                          <button
                            type="button"
                            className={displayMode === 'card' ? styles.displayModeActive : ''}
                            onClick={() => setDisplayMode('card')}
                          >
                            {t('auth_files.display_card')}
                          </button>
                        </div>
                      </div>
                    }
                  />
                </div>
              </div>
            </div>

            <div className={styles.authFilesResultsViewport}>
              <div className={styles.authFilesResultsHorizontalViewport}>
                {loading ? (
                  <div className={styles.hint}>{t('common.loading')}</div>
                ) : pageItems.length === 0 ? (
                  <EmptyState
                    title={t('auth_files.search_empty_title')}
                    description={t('auth_files.search_empty_desc')}
                  />
                ) : displayMode === 'list' ? (
                  <AuthFileList
                    files={pageItems}
                    selectedFiles={selectedFiles}
                    resolvedTheme={resolvedTheme}
                    disableControls={disableControls}
                    compact={compactMode}
                    errorFileNames={errorFileNames}
                    deleting={deleting}
                    statusUpdating={statusUpdating}
                    statusBarCache={statusBarCache}
                    onShowModels={showModels}
                    onDownload={handleDownload}
                    onOpenPrefixProxyEditor={openPrefixProxyEditor}
                    onDelete={handleDelete}
                    onToggleStatus={handleStatusToggle}
                    onToggleSelect={toggleSelect}
                    onRefreshQuota={refreshQuotaForFile}
                    visibleColumns={visibleColumns}
                  />
                ) : (
                  <div className={`${styles.fileGrid} ${quotaFilterType ? styles.fileGridQuotaManaged : ''} ${compactMode ? styles.fileGridCompact : ''}`}>
                    {pageItems.map((file) => (
                      <AuthFileCard
                        key={file.name}
                        file={file}
                        compact={compactMode}
                        listMode={false}
                        selected={selectedFiles.has(file.name)}
                        resolvedTheme={resolvedTheme}
                        disableControls={disableControls}
                        deleting={deleting}
                        statusUpdating={statusUpdating}
                        quotaFilterType={quotaFilterType}
                        statusBarCache={statusBarCache}
                        hasError={errorFileNames.has(file.name)}
                        onShowModels={showModels}
                        onDownload={handleDownload}
                        onOpenPrefixProxyEditor={openPrefixProxyEditor}
                        onDelete={handleDelete}
                        onToggleStatus={handleStatusToggle}
                        onToggleSelect={toggleSelect}
                        onRefreshQuota={refreshQuotaForFile}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>

            {!loading && sorted.length > pageSize && (
              <div className={styles.pagination}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPage(Math.max(1, currentPage - 1))}
                  disabled={currentPage <= 1}
                >
                  {t('auth_files.pagination_prev')}
                </Button>
                <div className={styles.pageInfo}>
                  {t('auth_files.pagination_info', {
                    current: currentPage,
                    total: totalPages,
                    count: sorted.length,
                  })}
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPage(Math.min(totalPages, currentPage + 1))}
                  disabled={currentPage >= totalPages}
                >
                  {t('auth_files.pagination_next')}
                </Button>
              </div>
            )}
          </div>
        </div>
      </Card>

      <AuthFileModelsModal
        open={modelsModalOpen}
        fileName={modelsFileName}
        fileType={modelsFileType}
        loading={modelsLoading}
        error={modelsError}
        models={modelsList}
        excluded={excluded}
        onClose={closeModelsModal}
        onCopyText={copyTextWithNotification}
      />

      <AuthFilesPrefixProxyEditorModal
        disableControls={disableControls}
        editor={prefixProxyEditor}
        updatedText={prefixProxyUpdatedText}
        dirty={prefixProxyDirty}
        onClose={closePrefixProxyEditor}
        onCopyText={copyTextWithNotification}
        onSave={handlePrefixProxySave}
        onChange={handlePrefixProxyChange}
      />

      {batchActionBarVisible && typeof document !== 'undefined'
        ? createPortal(
            <div className={styles.batchActionContainer} ref={floatingBatchActionsRef}>
              <div className={styles.batchActionBar}>
                <div className={styles.batchActionLeft}>
                  <span className={styles.batchSelectionText}>
                    {t('auth_files.batch_selected', { count: selectionCount })}
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => selectAllVisible(pageItems)}
                    disabled={selectablePageItems.length === 0}
                  >
                    {t('auth_files.batch_select_page')}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => selectAllVisible(sorted)}
                    disabled={selectableFilteredItems.length === 0}
                  >
                    {t('auth_files.batch_select_filtered')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => invertVisibleSelection(pageItems)}
                    disabled={selectablePageItems.length === 0}
                  >
                    {t('auth_files.batch_invert_page')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={deselectAll}>
                    {t('auth_files.batch_deselect')}
                  </Button>
                </div>
                <div className={styles.batchActionRight}>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void batchDownload(selectedNames)}
                    disabled={disableControls || selectedNames.length === 0}
                  >
                    {t('auth_files.batch_download')}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => batchSetStatus(selectedNames, true)}
                    disabled={batchStatusButtonsDisabled}
                  >
                    {t('auth_files.batch_enable')}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => batchSetStatus(selectedNames, false)}
                    disabled={batchStatusButtonsDisabled}
                  >
                    {t('auth_files.batch_disable')}
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => batchDelete(selectedNames)}
                    disabled={disableControls || selectedNames.length === 0}
                  >
                    {t('common.delete')}
                  </Button>
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
