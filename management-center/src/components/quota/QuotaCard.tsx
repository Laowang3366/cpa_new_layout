/**
 * Generic quota card component.
 */

import { useTranslation } from 'react-i18next';
import type { ReactElement, ReactNode } from 'react';
import type { TFunction } from 'i18next';
import { Button } from '@/components/ui/Button';
import { IconRefreshCw } from '@/components/ui/icons';
import type { AuthFileItem, ResolvedTheme, ThemeColors } from '@/types';
import { TYPE_COLORS } from '@/utils/quota';
import styles from '@/pages/QuotaPage.module.scss';

type QuotaStatus = 'idle' | 'loading' | 'success' | 'error';

export interface QuotaStatusState {
  status: QuotaStatus;
  error?: string;
  errorStatus?: number;
}

export interface QuotaProgressBarProps {
  percent: number | null;
  highThreshold: number;
  mediumThreshold: number;
}

export function QuotaProgressBar({
  percent,
  highThreshold,
  mediumThreshold,
}: QuotaProgressBarProps) {
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  const normalized = percent === null ? null : clamp(percent, 0, 100);
  const fillClass =
    normalized === null
      ? styles.quotaBarFillMedium
      : normalized >= highThreshold
        ? styles.quotaBarFillHigh
        : normalized >= mediumThreshold
          ? styles.quotaBarFillMedium
          : styles.quotaBarFillLow;
  const widthPercent = Math.round((normalized ?? 0) * 100) / 100;

  return (
    <div className={styles.quotaBar}>
      <div
        className={`${styles.quotaBarFill} ${fillClass}`}
        style={{ width: `${widthPercent}%` }}
      />
    </div>
  );
}

export interface QuotaRenderHelpers {
  styles: typeof styles;
  QuotaProgressBar: (props: QuotaProgressBarProps) => ReactElement;
}

interface QuotaCardProps<TState extends QuotaStatusState> {
  item: AuthFileItem;
  quota?: TState;
  resolvedTheme: ResolvedTheme;
  i18nPrefix: string;
  cardClassName: string;
  listMode?: boolean;
  defaultType: string;
  canRefresh?: boolean;
  onRefresh?: () => void;
  resetQuotaAction?: ReactNode;
  renderQuotaItems: (quota: TState, t: TFunction, helpers: QuotaRenderHelpers) => ReactNode;
}

export function QuotaCard<TState extends QuotaStatusState>({
  item,
  quota,
  resolvedTheme,
  i18nPrefix,
  cardClassName,
  listMode = false,
  defaultType,
  canRefresh = false,
  onRefresh,
  resetQuotaAction,
  renderQuotaItems,
}: QuotaCardProps<TState>) {
  const { t } = useTranslation();

  const displayType = item.type || item.provider || defaultType;
  const typeColorSet = TYPE_COLORS[displayType] || TYPE_COLORS.unknown;
  const typeColor: ThemeColors =
    resolvedTheme === 'dark' && typeColorSet.dark ? typeColorSet.dark : typeColorSet.light;

  const quotaStatus = quota?.status ?? 'idle';
  const quotaLoading = quotaStatus === 'loading';
  const quotaErrorMessage = resolveQuotaErrorMessage(
    t,
    quota?.errorStatus,
    quota?.error || t('common.unknown_error')
  );
  const idleMessageKey = `${i18nPrefix}.idle`;

  const getTypeLabel = (type: string): string => {
    const key = `auth_files.filter_${type}`;
    const translated = t(key);
    if (translated !== key) return translated;
    if (type.toLowerCase() === 'iflow') return 'iFlow';
    return type.charAt(0).toUpperCase() + type.slice(1);
  };

  const typeBadge = (
    <span
      className={styles.typeBadge}
      style={{
        backgroundColor: typeColor.bg,
        color: typeColor.text,
        ...(typeColor.border ? { border: typeColor.border } : {}),
      }}
    >
      {getTypeLabel(displayType)}
    </span>
  );

  const quotaContent = quotaLoading ? (
    <div className={styles.quotaMessage}>{t(`${i18nPrefix}.loading`)}</div>
  ) : quotaStatus === 'idle' ? (
    onRefresh ? (
      <button
        type="button"
        className={`${styles.quotaMessage} ${styles.quotaMessageAction}`}
        onClick={onRefresh}
        disabled={!canRefresh}
      >
        {t(idleMessageKey)}
      </button>
    ) : (
      <div className={styles.quotaMessage}>{t(idleMessageKey)}</div>
    )
  ) : quotaStatus === 'error' ? (
    <div className={styles.quotaError}>
      {t(`${i18nPrefix}.load_failed`, {
        message: quotaErrorMessage,
      })}
    </div>
  ) : quota ? (
    renderQuotaItems(quota, t, { styles, QuotaProgressBar })
  ) : (
    <div className={styles.quotaMessage}>{t(idleMessageKey)}</div>
  );

  const actions = (resetQuotaAction || (onRefresh && quotaStatus !== 'idle')) && (
    <div className={styles.quotaCardActions}>
      {resetQuotaAction}
      {onRefresh && quotaStatus !== 'idle' && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className={styles.quotaRefreshButton}
          onClick={onRefresh}
          disabled={!canRefresh || quotaLoading}
          loading={quotaLoading}
          title={t('auth_files.quota_refresh_hint')}
        >
          {!quotaLoading && <IconRefreshCw size={14} />}
          {t('auth_files.quota_refresh_single')}
        </Button>
      )}
    </div>
  );

  const subscriptionState = quota as TState & {
    planType?: string | null;
    subscriptionActiveUntil?: string | number | null;
    rateLimitResetCreditsAvailableCount?: number | null;
  };
  const planType = subscriptionState.planType?.trim() ?? '';
  const normalizedPlanType = planType.toLowerCase().replace(/[_-]/g, '');
  const planKey =
    displayType === 'claude' && planType
      ? `claude_quota.${planType}`
      : normalizedPlanType === 'plus'
        ? 'codex_quota.plan_plus'
        : normalizedPlanType === 'pro'
          ? 'codex_quota.plan_pro'
          : normalizedPlanType === 'team'
            ? 'codex_quota.plan_team'
            : normalizedPlanType === 'free'
              ? 'codex_quota.plan_free'
              : normalizedPlanType === 'prolite'
                ? 'codex_quota.plan_prolite'
                : '';
  const translatedPlan = planKey ? t(planKey) : '';
  const planLabel = translatedPlan && translatedPlan !== planKey ? translatedPlan : planType;
  const expiryValue = subscriptionState.subscriptionActiveUntil;
  const expiryNumber = Number(expiryValue);
  const expiryDate = expiryValue
    ? new Date(Number.isFinite(expiryNumber) && expiryNumber < 1e12 ? expiryNumber * 1000 : expiryValue)
    : null;
  const expiryLabel = expiryDate && !Number.isNaN(expiryDate.getTime())
    ? expiryDate.toLocaleString()
    : '';
  const resetCredits = subscriptionState.rateLimitResetCreditsAvailableCount;
  const hasSubscription = quotaStatus === 'success' && Boolean(
    planLabel || expiryLabel || resetCredits !== null && resetCredits !== undefined
  );
  const subscriptionContent = hasSubscription ? (
    <div className={styles.quotaSubscriptionInfo}>
      {planLabel && <span><em>{t('codex_quota.plan_label')}</em>{planLabel}</span>}
      {expiryLabel && <span><em>{t('codex_quota.expires_label')}</em>{expiryLabel}</span>}
      {resetCredits !== null && resetCredits !== undefined && (
        <span><em>{t('codex_quota.reset_credits_label')}</em>{resetCredits}</span>
      )}
    </div>
  ) : (
    <span className={styles.quotaTableEmpty}>--</span>
  );

  if (listMode) {
    return (
      <tr className={item.disabled ? styles.quotaTableRowDisabled : ''}>
        <td className={styles.quotaTableNameCell} title={item.name}>{item.name}</td>
        <td>{typeBadge}</td>
        <td>{subscriptionContent}</td>
        <td className={styles.quotaTableValueCell}>{quotaContent}</td>
        <td className={styles.quotaTableActionsCell}>{actions}</td>
      </tr>
    );
  }

  return (
    <div className={`${styles.fileCard} ${cardClassName}`}>
      <div className={styles.cardHeader}>
        {typeBadge}
        <span className={styles.fileName}>{item.name}</span>
      </div>

      <div className={styles.quotaSection}>{quotaContent}</div>
      {actions}
    </div>
  );
}

const resolveQuotaErrorMessage = (
  t: TFunction,
  status: number | undefined,
  fallback: string
): string => {
  if (status === 404) return t('common.quota_update_required');
  if (status === 403) return t('common.quota_check_credential');
  return fallback;
};
