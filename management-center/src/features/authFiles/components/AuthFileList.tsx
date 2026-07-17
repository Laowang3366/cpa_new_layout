import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { SelectionCheckbox } from '@/components/ui/SelectionCheckbox';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  IconDownload,
  IconModelCluster,
  IconRefreshCw,
  IconSettings,
  IconTrash2,
} from '@/components/ui/icons';
import { ProviderStatusBar } from '@/components/providers/ProviderStatusBar';
import { useQuotaStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import { resolveAuthProvider } from '@/utils/quota';
import {
  normalizeRecentRequestAuthIndex,
  normalizeRecentRequestBuckets,
  normalizeUsageTotal,
  statusBarDataFromRecentRequests,
} from '@/utils/recentRequests';
import {
  QUOTA_PROVIDER_TYPES,
  formatModified,
  HEALTHY_STATUS_MESSAGES,
  getAuthFileIcon,
  getAuthFileStatusMessage,
  getTypeColor,
  getTypeLabel,
  isRuntimeOnlyAuthFile,
  normalizeProviderKey,
  parsePriorityValue,
  resolveQuotaErrorMessage,
  type QuotaProviderType,
  type ResolvedTheme,
} from '@/features/authFiles/constants';
import type { AuthFileStatusBarData } from '@/features/authFiles/hooks/useAuthFilesStatusBarCache';
import styles from '@/pages/AuthFilesPage.module.scss';

const remainingPercentColor = (percent: number) => {
  const normalized = Math.max(0, Math.min(100, percent)) / 100;
  const stops = normalized < 0.5
    ? { from: [239, 68, 68], to: [224, 170, 20], progress: normalized * 2 }
    : { from: [224, 170, 20], to: [34, 197, 94], progress: (normalized - 0.5) * 2 };
  const [r, g, b] = stops.from.map((value, index) =>
    Math.round(value + (stops.to[index] - value) * stops.progress)
  );
  return `rgb(${r}, ${g}, ${b})`;
};

export type AuthFileListColumn = 'type' | 'status' | 'modified' | 'remaining' | 'subscription' | 'health' | 'enabled' | 'priority';

type AuthFileListProps = {
  files: AuthFileItem[];
  selectedFiles: Set<string>;
  resolvedTheme: ResolvedTheme;
  disableControls: boolean;
  compact: boolean;
  errorFileNames: Set<string>;
  deleting: string | null;
  statusUpdating: Record<string, boolean>;
  statusBarCache: Map<string, AuthFileStatusBarData>;
  onShowModels: (file: AuthFileItem) => void;
  onDownload: (name: string) => void;
  onOpenPrefixProxyEditor: (file: AuthFileItem) => void;
  onDelete: (name: string) => void;
  onToggleStatus: (file: AuthFileItem, enabled: boolean) => void;
  onToggleSelect: (name: string) => void;
  onRefreshQuota: (file: AuthFileItem) => Promise<void>;
  visibleColumns: Record<AuthFileListColumn, boolean>;
};

export function AuthFileList({
  files,
  selectedFiles,
  resolvedTheme,
  disableControls,
  compact,
  errorFileNames,
  deleting,
  statusUpdating,
  statusBarCache,
  onShowModels,
  onDownload,
  onOpenPrefixProxyEditor,
  onDelete,
  onToggleStatus,
  onToggleSelect,
  onRefreshQuota,
  visibleColumns,
}: AuthFileListProps) {
  const { t } = useTranslation();
  const antigravityQuota = useQuotaStore((state) => state.antigravityQuota);
  const claudeQuota = useQuotaStore((state) => state.claudeQuota);
  const codexQuota = useQuotaStore((state) => state.codexQuota);
  const kimiQuota = useQuotaStore((state) => state.kimiQuota);
  const xaiQuota = useQuotaStore((state) => state.xaiQuota);
  const isColumnVisible = (column: AuthFileListColumn) => visibleColumns[column] && (!compact || column !== 'priority');

  return (
    <div className={styles.authFileTableWrap}>
      <table className={`${styles.authFileTable} ${compact ? styles.authFileTableCompact : ''}`}>
        <thead>
          <tr>
            <th className={styles.authFileSelectColumn} aria-label={t('auth_files.batch_select_all')} />
            <th>{t('auth_files.list_name')}</th>
            {isColumnVisible('type') && <th>{t('auth_files.list_type')}</th>}
            {isColumnVisible('status') && <th>{t('auth_files.list_status')}</th>}
            {isColumnVisible('modified') && <th>{t('auth_files.file_modified')}</th>}
            {isColumnVisible('remaining') && <th>{t('auth_files.remaining_quota')}</th>}
            {isColumnVisible('subscription') && <th>{t('auth_files.list_subscription')}</th>}
            {isColumnVisible('health') && <th>{t('auth_files.health_status_label')}</th>}
            {isColumnVisible('enabled') && <th>{t('auth_files.list_enabled')}</th>}
            {isColumnVisible('priority') && <th>{t('auth_files.priority_display')}</th>}
            <th>{t('auth_files.list_actions')}</th>
          </tr>
        </thead>
        <tbody>
          {files.map((file) => {
            const recentBuckets = normalizeRecentRequestBuckets(file.recent_requests ?? file.recentRequests);
            const providerKey = normalizeProviderKey(String(file.type ?? file.provider ?? 'unknown'));
            const typeColor = getTypeColor(providerKey, resolvedTheme);
            const typeLabel = getTypeLabel(t, providerKey);
            const providerIcon = getAuthFileIcon(providerKey, resolvedTheme);
            const isRuntimeOnly = isRuntimeOnlyAuthFile(file);
            const isAistudio = providerKey === 'aistudio';
            const rawStatusMessage = getAuthFileStatusMessage(file);
            const hasStatusWarning = Boolean(rawStatusMessage) && !HEALTHY_STATUS_MESSAGES.has(rawStatusMessage.toLowerCase());
            const hasError = errorFileNames.has(file.name);
            const stateLabel = isRuntimeOnly
              ? t('auth_files.type_virtual') || '虚拟认证文件'
              : hasError
                ? t('auth_files.health_status_error')
                : file.disabled
                  ? t('auth_files.health_status_disabled')
                  : rawStatusMessage
                    ? t('auth_files.health_status_healthy')
                    : t('auth_files.status_toggle_label');
            const stateBadgeClass = isRuntimeOnly
              ? styles.stateBadgeVirtual
              : hasError
                ? styles.stateBadgeError
                : file.disabled
                  ? styles.stateBadgeDisabled
                  : styles.stateBadgeActive;
            const authIndexKey = normalizeRecentRequestAuthIndex(file['auth_index'] ?? file.authIndex);
            const statusData =
              (authIndexKey && statusBarCache.get(authIndexKey)) ||
              statusBarDataFromRecentRequests(recentBuckets);
            const priorityValue = parsePriorityValue(file.priority ?? file['priority']);
            const noteValue = typeof file.note === 'string' ? file.note.trim() : '';
            const quotaProvider = resolveAuthProvider(file);
            const quotaState =
              quotaProvider === 'antigravity'
                ? antigravityQuota[file.name]
                : quotaProvider === 'claude'
                  ? claudeQuota[file.name]
                  : quotaProvider === 'codex'
                    ? codexQuota[file.name]
                    : quotaProvider === 'kimi'
                      ? kimiQuota[file.name]
                      : quotaProvider === 'xai'
                        ? xaiQuota[file.name]
                        : undefined;
            const quotaPrefix =
              quotaProvider === 'antigravity'
                ? 'antigravity_quota'
                : quotaProvider === 'claude'
                  ? 'claude_quota'
                  : quotaProvider === 'codex'
                    ? 'codex_quota'
                    : quotaProvider === 'kimi'
                      ? 'kimi_quota'
                      : quotaProvider === 'xai'
                        ? 'xai_quota'
                        : null;
            const quotaError =
              quotaState?.status === 'error' && quotaPrefix
                ? t(`${quotaPrefix}.load_failed`, {
                    message: resolveQuotaErrorMessage(
                      t,
                      quotaState.errorStatus,
                      quotaState.error || t('common.unknown_error')
                    ),
                  })
                : '';
            const healthError = quotaError || (hasStatusWarning ? rawStatusMessage : '');
            const remainingItems: Array<{ label: string; percent: number; resetLabel?: string }> = [];
            const addRemaining = (
              label: string,
              value: number | null | undefined,
              resetLabel?: string
            ) => {
              if (value === null || value === undefined || !Number.isFinite(value)) return;
              remainingItems.push({
                label,
                percent: Math.max(0, Math.min(100, value)),
                resetLabel: resetLabel && resetLabel !== '-' ? resetLabel : undefined,
              });
            };

            if (quotaProvider === 'codex') {
              codexQuota[file.name]?.windows?.forEach((window) => {
                const translatedLabel = window.labelKey
                  ? t(window.labelKey, window.labelParams ?? {})
                  : window.label;
                const label = window.id.includes('five-hour')
                  ? '5h'
                  : window.id.includes('weekly')
                    ? '7d'
                    : translatedLabel;
                addRemaining(
                  label,
                  window.usedPercent === null ? null : 100 - window.usedPercent,
                  window.resetLabel
                );
              });
            } else if (quotaProvider === 'claude') {
              claudeQuota[file.name]?.windows?.forEach((window) => {
                const label = window.labelKey ? t(window.labelKey) : window.label;
                addRemaining(
                  label,
                  window.usedPercent === null ? null : 100 - window.usedPercent,
                  window.resetLabel
                );
              });
            } else if (quotaProvider === 'antigravity') {
              antigravityQuota[file.name]?.groups?.forEach((group) => {
                group.buckets.forEach((bucket) => addRemaining(bucket.label || group.label, bucket.remainingFraction * 100));
              });
            } else if (quotaProvider === 'kimi') {
              kimiQuota[file.name]?.rows?.forEach((row) => {
                const label = row.labelKey ? t(row.labelKey, row.labelParams ?? {}) : (row.label || 'Kimi');
                const remaining = row.limit > 0 ? ((row.limit - row.used) / row.limit) * 100 : null;
                addRemaining(label, remaining);
              });
            } else if (quotaProvider === 'xai') {
              const billing = xaiQuota[file.name]?.billing;
              if (billing?.periodType === 'weekly') {
                addRemaining(t('xai_quota.weekly_limit'), billing.usagePercent === null ? null : 100 - billing.usagePercent);
              }
              addRemaining(t('xai_quota.monthly_credits'), billing?.usedPercent === null ? null : billing ? 100 - billing.usedPercent : null);
            }
            const remainingTitle = remainingItems
              .map((item) => `${item.label}: ${Math.round(item.percent)}%${item.resetLabel ? ` (${item.resetLabel})` : ''}`)
              .join('\n');
            const codexSubscription = quotaProvider === 'codex' ? codexQuota[file.name] : undefined;
            const planType = codexSubscription?.planType?.toLowerCase() ?? '';
            const planKey =
              planType === 'plus'
                ? 'codex_quota.plan_plus'
                : planType === 'pro'
                  ? 'codex_quota.plan_pro'
                  : planType === 'team'
                    ? 'codex_quota.plan_team'
                    : planType === 'free'
                      ? 'codex_quota.plan_free'
                      : ['prolite', 'pro-lite', 'pro_lite'].includes(planType)
                        ? 'codex_quota.plan_prolite'
                        : null;
            const planLabel = planKey
              ? t(planKey)
              : (codexSubscription?.planType ?? '-');
            const expiryValue = codexSubscription?.subscriptionActiveUntil;
            const expiryNumber = Number(expiryValue);
            const expiryDate = expiryValue
              ? new Date(Number.isFinite(expiryNumber) && expiryNumber < 1e12 ? expiryNumber * 1000 : expiryValue)
              : null;
            const expiryLabel = expiryDate && !Number.isNaN(expiryDate.getTime())
              ? expiryDate.toLocaleString()
              : '-';
            const resetCredits = codexSubscription?.rateLimitResetCreditsAvailableCount;

            return (
              <tr key={file.name} className={file.disabled ? styles.authFileTableRowDisabled : ''}>
                <td className={styles.authFileSelectColumn}>
                  {!isRuntimeOnly && (
                    <SelectionCheckbox
                      checked={selectedFiles.has(file.name)}
                      onChange={() => onToggleSelect(file.name)}
                      aria-label={t('auth_files.batch_select_all')}
                    />
                  )}
                </td>
                <td className={styles.authFileNameCell}>
                  <strong title={file.name}>{file.name}</strong>
                  {noteValue && <span title={noteValue}>{noteValue}</span>}
                </td>
                {isColumnVisible('type') && <td>
                  <span
                    className={styles.authFileTypeCell}
                    style={{
                      backgroundColor: typeColor.bg,
                      color: typeColor.text,
                      ...(typeColor.border ? { border: typeColor.border } : {}),
                    }}
                  >
                    {providerIcon ? <img src={providerIcon} alt="" /> : null}
                    {typeLabel}
                  </span>
                </td>}
                {isColumnVisible('status') && <td>
                  <span className={`${styles.stateBadge} ${stateBadgeClass}`}>{stateLabel}</span>
                </td>}
                {isColumnVisible('modified') && <td className={styles.authFileTimeCell}>{formatModified(file)}</td>}
                {isColumnVisible('remaining') && <td>
                  {quotaState?.status === 'loading' ? (
                    <span className={styles.authFileQuotaLoading}>{t('common.loading')}</span>
                  ) : quotaState?.status === 'success' && remainingItems.length > 0 ? (
                    <div className={styles.authFileRemainingQuota} title={remainingTitle}>
                      {remainingItems.map((item, index) => (
                        <span key={`${item.label}-${index}`} className={styles.authFileRemainingQuotaItem}>
                          <strong style={{ color: remainingPercentColor(item.percent) }}>
                            {item.label}: {Math.round(item.percent)}%
                          </strong>
                          {item.resetLabel && (
                            <small className={styles.authFileRemainingQuotaReset}>({item.resetLabel})</small>
                          )}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className={styles.authFileQuotaEmpty}>--</span>
                  )}
                </td>}
                {isColumnVisible('subscription') && <td>
                  {codexSubscription?.status === 'success' ? (
                    <div className={styles.authFileSubscriptionInfo}>
                      <span><em>{t('codex_quota.plan_label')}</em>{planLabel}</span>
                      <span><em>{t('codex_quota.expires_label')}</em>{expiryLabel}</span>
                      <span><em>{t('codex_quota.reset_credits_label')}</em>{resetCredits ?? '-'}</span>
                    </div>
                  ) : (
                    <span className={styles.authFileQuotaEmpty}>--</span>
                  )}
                </td>}
                {isColumnVisible('health') && <td className={styles.authFileHealthCell}>
                  <div className={styles.authFileRequestStats}>
                    <span className={styles.statSuccess}>{t('stats.success')} {normalizeUsageTotal(file.success)}</span>
                    <span className={styles.statFailure}>{t('stats.failure')} {normalizeUsageTotal(file.failed)}</span>
                  </div>
                  {healthError ? (
                    <div className={styles.authFileHealthError} title={healthError}>{healthError}</div>
                  ) : (
                    <ProviderStatusBar statusData={statusData} styles={styles} />
                  )}
                </td>}
                {isColumnVisible('enabled') && <td>
                  {isRuntimeOnly ? '-' : (
                    <ToggleSwitch
                      ariaLabel={t('auth_files.status_toggle_label')}
                      checked={!file.disabled}
                      disabled={disableControls || statusUpdating[file.name] === true}
                      onChange={(value) => onToggleStatus(file, value)}
                    />
                  )}
                </td>}
                {isColumnVisible('priority') && <td>{priorityValue ?? '-'}</td>}
                <td>
                  <div className={styles.authFileTableActions}>
                    {!isRuntimeOnly && QUOTA_PROVIDER_TYPES.has(quotaProvider as QuotaProviderType) && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => void onRefreshQuota(file)}
                        title={t('auth_files.quota_refresh_hint')}
                        disabled={disableControls || file.disabled || quotaState?.status === 'loading'}
                      >
                        {quotaState?.status === 'loading' ? <LoadingSpinner size={14} /> : <IconRefreshCw size={15} />}
                      </Button>
                    )}
                    {(!isRuntimeOnly || isAistudio) && (
                      <Button variant="secondary" size="sm" onClick={() => onShowModels(file)} title={t('auth_files.models_button')} disabled={disableControls}>
                        <IconModelCluster size={15} />
                      </Button>
                    )}
                    {!isRuntimeOnly && (
                      <>
                        <Button variant="secondary" size="sm" onClick={() => onDownload(file.name)} title={t('auth_files.download_button')} disabled={disableControls}>
                          <IconDownload size={15} />
                        </Button>
                        <Button variant="secondary" size="sm" onClick={() => onOpenPrefixProxyEditor(file)} title={t('auth_files.prefix_proxy_button')} disabled={disableControls}>
                          <IconSettings size={15} />
                        </Button>
                        <Button variant="danger" size="sm" onClick={() => onDelete(file.name)} title={t('auth_files.delete_button')} disabled={disableControls || deleting === file.name}>
                          {deleting === file.name ? <LoadingSpinner size={14} /> : <IconTrash2 size={15} />}
                        </Button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
