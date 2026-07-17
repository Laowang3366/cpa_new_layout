import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  IconChevronLeft,
  IconChevronDown,
  IconDollarSign,
  IconPlus,
  IconRefreshCw,
  IconScrollText,
  IconTrash2,
  IconTimer,
} from '@/components/ui/icons';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useAuthStore } from '@/stores';
import {
  usageRecordsApi,
  type UsageBreakdown,
  type UsagePricingConfig,
  type UsagePricingRule,
  type UsageRecord,
  type UsageRecordFilters,
  type UsageStats,
  type UsageStatusFilter,
} from '@/services/api/usageRecords';
import { formatDateTimeValue } from '@/utils/format';
import { getErrorMessage } from '@/utils/helpers';
import styles from './UsageRecordsPage.module.scss';

const PAGE_SIZES = [10, 30, 50] as const;

const toDateInputValue = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const defaultRange = () => {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 6);
  return { start: toDateInputValue(start), end: toDateInputValue(end) };
};

const emptyStats: UsageStats = {
  total_requests: 0,
  success_requests: 0,
  failed_requests: 0,
  input_tokens: 0,
  output_tokens: 0,
  reasoning_tokens: 0,
  cached_tokens: 0,
  total_tokens: 0,
  total_cost: 0,
  priced_requests: 0,
  unpriced_requests: 0,
  average_latency_ms: 0,
  models: [],
  providers: [],
  endpoints: [],
  accounts: [],
  trend: [],
};

const emptyPricingRule: UsagePricingRule = {
  enabled: false,
  input_per_million: 0,
  output_per_million: 0,
  reasoning_per_million: 0,
  cached_per_million: 0,
};

const emptyPricing: UsagePricingConfig = {
  currency: 'USD',
  default: emptyPricingRule,
  models: {},
};

const formatInteger = (value: number) => new Intl.NumberFormat().format(Math.round(value || 0));

const formatTokens = (value: number) => {
  const amount = Math.max(0, value || 0);
  if (amount >= 1_000_000_000) return `${(amount / 1_000_000_000).toFixed(2)}B`;
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(2)}M`;
  if (amount >= 1_000) return `${(amount / 1_000).toFixed(1)}K`;
  return formatInteger(amount);
};

const formatCost = (value: number, currency: string) =>
  `${currency || 'USD'} ${Math.max(0, value || 0).toFixed(4)}`;

const formatSummaryCost = (value: number, currency: string) => {
  const amount = Math.max(0, value || 0).toFixed(4);
  return (currency || 'USD').toUpperCase() === 'USD' ? `$${amount}` : `${currency} ${amount}`;
};

const formatLatency = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return '--';
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
};

const formatCacheHitRate = (cachedTokens: number, inputTokens: number) => {
  const input = Math.max(0, inputTokens || 0);
  if (input <= 0) return '--';
  const percentage = Math.min(100, Math.max(0, ((cachedTokens || 0) / input) * 100));
  return `${percentage.toFixed(1)}%`;
};

function StatCard({
  label,
  value,
  detail,
  icon,
  tone,
}: {
  label: string;
  value: string;
  detail?: React.ReactNode;
  icon: React.ReactNode;
  tone: 'primary' | 'warning' | 'success' | 'info';
}) {
  return (
    <div className={`${styles.statCard} ${styles[`statCard${tone[0].toUpperCase()}${tone.slice(1)}`]}`}>
      <div className={styles.statIcon}>{icon}</div>
      <div className={styles.statContent}>
        <span className={styles.statLabel}>{label}</span>
        <strong className={styles.statValue}>{value}</strong>
        {detail && <div className={styles.statDetail}>{detail}</div>}
      </div>
    </div>
  );
}

function TokenDetails({ tokens }: { tokens: UsageRecord['tokens'] }) {
  const { t } = useTranslation();
  const tooltipId = useId();
  const triggerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({
    left: 0,
    top: 0,
    placement: 'top' as 'top' | 'bottom',
    ready: false,
  });

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    const tooltip = tooltipRef.current;
    if (!trigger || !tooltip) return;

    const triggerRect = trigger.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const gap = 10;
    const viewportPadding = 8;
    const placement = triggerRect.top >= tooltipRect.height + gap + viewportPadding ? 'top' : 'bottom';
    const halfWidth = tooltipRect.width / 2;
    const centeredLeft = triggerRect.left + triggerRect.width / 2;
    const left = Math.min(
      window.innerWidth - halfWidth - viewportPadding,
      Math.max(halfWidth + viewportPadding, centeredLeft)
    );

    setPosition({
      left,
      top: placement === 'top' ? triggerRect.top - gap : triggerRect.bottom + gap,
      placement,
      ready: true,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return undefined;
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, updatePosition]);

  const showTooltip = () => {
    setPosition((current) => ({ ...current, ready: false }));
    setOpen(true);
  };

  const hideTooltip = () => setOpen(false);

  return (
    <>
      <div
        ref={triggerRef}
        className={styles.tokenDetailsTrigger}
        tabIndex={0}
        aria-describedby={open ? tooltipId : undefined}
        onMouseEnter={showTooltip}
        onMouseLeave={hideTooltip}
        onFocus={showTooltip}
        onBlur={hideTooltip}
        onKeyDown={(event) => {
          if (event.key === 'Escape') hideTooltip();
        }}
      >
        <span className={styles.tokenValue}>{formatTokens(tokens.total_tokens)}</span>
        <small className={styles.mutedText}>
          {formatTokens(tokens.input_tokens)} {t('usage_records.input_tokens_short', { defaultValue: '输入' })} /{' '}
          {formatTokens(tokens.output_tokens)} {t('usage_records.output_tokens_short', { defaultValue: '输出' })}
        </small>
      </div>
      {open && createPortal(
        <div
          ref={tooltipRef}
          id={tooltipId}
          role="tooltip"
          data-placement={position.placement}
          className={styles.tokenTooltip}
          style={{
            left: position.left,
            top: position.top,
            visibility: position.ready ? 'visible' : 'hidden',
          }}
        >
          <strong className={styles.tokenTooltipTitle}>
            {t('usage_records.token_details', { defaultValue: 'Token 明细' })}
          </strong>
          <div className={styles.tokenTooltipRows}>
            <div>
              <span>{t('usage_records.input_tokens', { defaultValue: '输入 Token' })}</span>
              <strong>{formatInteger(tokens.input_tokens)}</strong>
            </div>
            <div>
              <span>{t('usage_records.output_tokens', { defaultValue: '输出 Token' })}</span>
              <strong>{formatInteger(tokens.output_tokens)}</strong>
            </div>
            <div>
              <span>{t('usage_records.cache_read_tokens', { defaultValue: '缓存读取 Token' })}</span>
              <strong>{formatInteger(tokens.cached_tokens)}</strong>
            </div>
          </div>
          <div className={styles.tokenTooltipTotal}>
            <span>{t('usage_records.total_tokens', { defaultValue: '总 Token' })}</span>
            <strong>{formatInteger(tokens.total_tokens)}</strong>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

function LatencyDetails({ firstTokenMs, totalMs }: { firstTokenMs?: number; totalMs: number }) {
  const { t } = useTranslation();

  return (
    <div className={styles.latencyDetails}>
      <span className={styles.latencyLine}>
        <span>{t('usage_records.first_token_latency', { defaultValue: '首字耗时' })}</span>
        <strong>{formatLatency(firstTokenMs ?? 0)}</strong>
      </span>
      <span className={styles.latencyLine}>
        <span>{t('usage_records.total_latency', { defaultValue: '总耗时' })}</span>
        <strong>{formatLatency(totalMs)}</strong>
      </span>
    </div>
  );
}

function BreakdownCard({
  title,
  items,
  tokenCurrency,
  firstColumnLabel,
}: {
  title: string;
  items: UsageBreakdown[];
  tokenCurrency: string;
  firstColumnLabel: string;
}) {
  const { t } = useTranslation();
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const groups = useMemo(() => {
    const grouped = new Map<string, UsageBreakdown[]>();
    items.forEach((item) => {
      const group = item.group || 'unknown';
      grouped.set(group, [...(grouped.get(group) ?? []), item]);
    });
    return [...grouped.entries()].map(([name, children]) => ({
      name,
      children,
      totals: children.reduce<UsageBreakdown>((total, item) => ({
        key: name,
        group: name,
        requests: total.requests + item.requests,
        failures: total.failures + item.failures,
        tokens: total.tokens + item.tokens,
        input_tokens: total.input_tokens + item.input_tokens,
        output_tokens: total.output_tokens + item.output_tokens,
        cached_tokens: total.cached_tokens + item.cached_tokens,
        cost: total.cost + item.cost,
        cost_known: total.cost_known && item.cost_known,
      }), {
        key: name,
        group: name,
        requests: 0,
        failures: 0,
        tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        cached_tokens: 0,
        cost: 0,
        cost_known: true,
      }),
    })).sort((a, b) => b.totals.tokens - a.totals.tokens);
  }, [items]);

  const renderValues = (item: UsageBreakdown) => (
    <>
      <td>{formatInteger(item.requests)}</td>
      <td className={styles.breakdownTokens}>
        <span>{t('usage_records.input_tokens_short', { defaultValue: '输入' })} {formatTokens(item.input_tokens)}</span>
        <span>{t('usage_records.output_tokens_short', { defaultValue: '输出' })} {formatTokens(item.output_tokens)}</span>
        <span>{t('usage_records.cache_tokens_short', { defaultValue: '缓存' })} {formatTokens(item.cached_tokens)}</span>
      </td>
      <td className={styles.breakdownHitRate}>{formatCacheHitRate(item.cached_tokens, item.input_tokens)}</td>
      <td className={styles.breakdownCost}>{item.cost_known ? formatSummaryCost(item.cost, tokenCurrency) : '--'}</td>
    </>
  );

  const toggleGroup = (name: string) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  return (
    <Card title={title} className={styles.breakdownCard}>
      {items.length === 0 ? (
        <div className={styles.noData}>--</div>
      ) : (
        <div className={styles.breakdownTableWrap}>
          <table className={styles.breakdownTable}>
            <thead>
              <tr>
                <th>{firstColumnLabel}</th>
                <th>{t('usage_records.requests', { defaultValue: '请求数' })}</th>
                <th>{t('usage_records.tokens', { defaultValue: 'Token' })}</th>
                <th>{t('usage_records.cache_hit_rate', { defaultValue: '缓存命中率' })}</th>
                <th>{t('usage_records.cost', { defaultValue: '消费金额' })}</th>
              </tr>
            </thead>
            <tbody>
              {groups.flatMap(({ name, children, totals }) => {
                const expanded = expandedGroups.has(name);
                const groupRow = (
                  <tr key={`group:${name}`} className={styles.breakdownGroupRow}>
                    <td>
                      <button type="button" className={styles.breakdownGroupButton} onClick={() => toggleGroup(name)} aria-expanded={expanded}>
                        <IconChevronDown size={15} />
                        <span title={name}>{name}</span>
                        <small>{children.length}</small>
                      </button>
                    </td>
                    {renderValues(totals)}
                  </tr>
                );
                if (!expanded) return [groupRow];
                return [groupRow, ...children.map((item) => (
                  <tr key={`${name}:${item.key}`} className={styles.breakdownChildRow}>
                    <td className={styles.breakdownName} title={item.key}>{item.key || 'unknown'}</td>
                    {renderValues(item)}
                  </tr>
                ))];
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function PricingField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className={styles.pricingField}>
      <span>{label}</span>
      <input
        className="input"
        type="number"
        min="0"
        step="0.000001"
        value={value}
        onChange={(event) => onChange(Number(event.target.value) || 0)}
      />
    </label>
  );
}

export function UsageRecordsPage() {
  const { t } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const range = useMemo(() => defaultRange(), []);
  const [draftFilters, setDraftFilters] = useState<UsageRecordFilters>({
    start: range.start,
    end: range.end,
    status: 'all',
  });
  const [filters, setFilters] = useState<UsageRecordFilters>(draftFilters);
  const [items, setItems] = useState<UsageRecord[]>([]);
  const [listTotal, setListTotal] = useState(0);
  const [stats, setStats] = useState<UsageStats>(emptyStats);
  const [pricing, setPricing] = useState<UsagePricingConfig>(emptyPricing);
  const [pricingDraft, setPricingDraft] = useState<UsagePricingConfig>(emptyPricing);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<(typeof PAGE_SIZES)[number]>(30);
  const [loading, setLoading] = useState(true);
  const [savingPricing, setSavingPricing] = useState(false);
  const [pricingOpen, setPricingOpen] = useState(false);
  const [newPricingModel, setNewPricingModel] = useState('');
  const [error, setError] = useState('');

  const appliedListFilters = useMemo(
    () => ({ ...filters, page, page_size: pageSize }),
    [filters, page, pageSize]
  );
  const loadPricing = useCallback(async () => {
    try {
      const nextPricing = await usageRecordsApi.getPricing();
      setPricing(nextPricing);
      setPricingDraft(nextPricing);
    } catch {
      // The usage page remains useful when the server predates the pricing endpoint.
    }
  }, []);

  const loadData = useCallback(async () => {
    if (connectionStatus !== 'connected') {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const [listResponse, statsResponse] = await Promise.all([
        usageRecordsApi.list(appliedListFilters),
        usageRecordsApi.stats({}),
      ]);
      setItems(listResponse.items ?? []);
      setListTotal(Number.isFinite(listResponse.total) ? listResponse.total : 0);
      setStats(statsResponse ?? emptyStats);
    } catch (loadError) {
      setError(getErrorMessage(loadError));
      setItems([]);
      setListTotal(0);
      setStats(emptyStats);
    } finally {
      setLoading(false);
    }
  }, [appliedListFilters, connectionStatus]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    void loadPricing();
  }, [loadPricing]);

  useHeaderRefresh(loadData, connectionStatus === 'connected');

  const totalPages = Math.max(1, Math.ceil(listTotal / pageSize));

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages));
  }, [totalPages]);

  const successRate = stats.total_requests > 0
    ? `${((stats.success_requests / stats.total_requests) * 100).toFixed(1)}%`
    : '--';
  const providerOptions = useMemo(
    () => [
      { value: '', label: t('usage_records.all_providers', { defaultValue: '全部 Provider' }) },
      ...stats.providers.map((item) => ({ value: item.key, label: item.key })),
    ],
    [stats.providers, t]
  );
  const modelOptions = useMemo(() => {
    const models = [...new Set(stats.models.map((item) => item.key.trim()).filter(Boolean))]
      .sort((left, right) => left.localeCompare(right));
    return [
      { value: '', label: t('usage_records.all_models', { defaultValue: '全部模型' }) },
      ...models.map((model) => ({ value: model, label: model })),
    ];
  }, [stats.models, t]);

  const statusOptions = [
    { value: 'all', label: t('usage_records.status_all', { defaultValue: '全部状态' }) },
    { value: 'success', label: t('usage_records.status_success', { defaultValue: '成功' }) },
    { value: 'failed', label: t('usage_records.status_failed', { defaultValue: '失败' }) },
  ];
  const sortOptions = [
    { value: 'timestamp', label: t('usage_records.sort_time', { defaultValue: '时间' }) },
    { value: 'model', label: t('usage_records.sort_model', { defaultValue: '模型' }) },
    { value: 'provider', label: t('usage_records.sort_provider', { defaultValue: 'Provider' }) },
    { value: 'tokens', label: t('usage_records.sort_tokens', { defaultValue: 'Token' }) },
    { value: 'cost', label: t('usage_records.sort_cost', { defaultValue: '费用' }) },
    { value: 'latency', label: t('usage_records.sort_latency', { defaultValue: '耗时' }) },
  ];
  const sortOrderOptions = [
    { value: 'desc', label: t('usage_records.sort_desc', { defaultValue: '降序' }) },
    { value: 'asc', label: t('usage_records.sort_asc', { defaultValue: '升序' }) },
  ];

  const updateDraft = (patch: Partial<UsageRecordFilters>) => {
    setDraftFilters((current) => ({ ...current, ...patch }));
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPage(1);
      setFilters({ ...draftFilters });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [draftFilters]);

  const resetFilters = () => {
    const next = {
      start: range.start,
      end: range.end,
      model: '',
      endpoint: '',
      status: 'all' as UsageStatusFilter,
    };
    setDraftFilters(next);
    setFilters(next);
    setPage(1);
  };

  const openPricing = () => {
    setPricingDraft(pricing);
    setNewPricingModel('');
    setPricingOpen(true);
  };

  const updateDefaultPricing = (patch: Partial<UsagePricingRule>) => {
    setPricingDraft((current) => ({
      ...current,
      default: { ...current.default, ...patch },
    }));
  };

  const updateModelPricing = (model: string, patch: Partial<UsagePricingRule>) => {
    setPricingDraft((current) => ({
      ...current,
      models: {
        ...current.models,
        [model]: { ...current.models[model], ...patch },
      },
    }));
  };

  const addModelPricing = () => {
    const model = newPricingModel.trim();
    if (!model || pricingDraft.models[model]) return;
    setPricingDraft((current) => ({
      ...current,
      models: { ...current.models, [model]: { ...emptyPricingRule, enabled: true } },
    }));
    setNewPricingModel('');
  };

  const removeModelPricing = (model: string) => {
    setPricingDraft((current) => {
      const models = { ...current.models };
      delete models[model];
      return { ...current, models };
    });
  };

  const savePricing = async () => {
    setSavingPricing(true);
    try {
      const nextPricing = await usageRecordsApi.updatePricing(pricingDraft);
      setPricing(nextPricing);
      setPricingDraft(nextPricing);
      setPricingOpen(false);
      await loadData();
    } catch (saveError) {
      setError(getErrorMessage(saveError));
    } finally {
      setSavingPricing(false);
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>{t('usage_records.title', { defaultValue: '使用记录' })}</h1>
          <p className={styles.description}>
            {t('usage_records.description', { defaultValue: '查看网关请求、Token、费用和调用趋势。' })}
          </p>
        </div>
        <div className={styles.headerActions}>
          <Button variant="secondary" size="sm" onClick={openPricing}>
            <IconDollarSign size={15} />
            {t('usage_records.pricing_button', { defaultValue: '费用规则' })}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void loadData()} loading={loading}>
            <IconRefreshCw size={15} />
            {t('common.refresh')}
          </Button>
        </div>
      </div>

      {error && <div className={styles.errorBox}>{error}</div>}

      <div className={styles.statsGrid}>
        <StatCard
          label={t('usage_records.total_requests', { defaultValue: '总请求数' })}
          value={formatInteger(stats.total_requests)}
          detail={`${formatInteger(stats.success_requests)} ${t('usage_records.success_suffix', { defaultValue: '成功' })} / ${formatInteger(stats.failed_requests)} ${t('usage_records.failed_suffix', { defaultValue: '失败' })}`}
          icon={<IconScrollText size={19} />}
          tone="primary"
        />
        <StatCard
          label={t('usage_records.total_tokens', { defaultValue: '总 Token' })}
          value={formatTokens(stats.total_tokens)}
          detail={(
            <div className={styles.tokenStatDetail}>
              <span className={styles.tokenStatTotals}>
                {t('usage_records.input_tokens_short', { defaultValue: '输入' })} {formatTokens(stats.input_tokens)} /{' '}
                {t('usage_records.output_tokens_short', { defaultValue: '输出' })} {formatTokens(stats.output_tokens)} /{' '}
                {t('usage_records.cache_tokens_short', { defaultValue: '缓存' })} {formatTokens(stats.cached_tokens)}
              </span>
              <span className={styles.tokenStatHitRate}>
                {t('usage_records.cache_hit_rate', { defaultValue: '缓存命中率' })}{' '}
                <strong>{formatCacheHitRate(stats.cached_tokens, stats.input_tokens)}</strong>
              </span>
            </div>
          )}
          icon={<span className={styles.tokenIcon}>T</span>}
          tone="warning"
        />
        <StatCard
          label={t('usage_records.total_cost', { defaultValue: '估算费用' })}
          value={stats.priced_requests > 0 ? formatSummaryCost(stats.total_cost, pricing.currency) : '--'}
          detail={stats.unpriced_requests > 0
            ? `${formatInteger(stats.priced_requests)} 已计价 / ${formatInteger(stats.unpriced_requests)} 待配置`
            : t('usage_records.cost_configured', { defaultValue: '当前筛选范围均已计价' })}
          icon={<IconDollarSign size={19} />}
          tone="success"
        />
        <StatCard
          label={t('usage_records.average_latency', { defaultValue: '平均耗时' })}
          value={formatLatency(stats.average_latency_ms)}
          detail={`${t('usage_records.success_rate', { defaultValue: '成功率' })} ${successRate}`}
          icon={<IconTimer size={19} />}
          tone="info"
        />
      </div>

      <Card className={styles.filterCard}>
        <div className={styles.filterGrid}>
          <Input
            label={t('usage_records.date_start', { defaultValue: '开始日期' })}
            type="date"
            value={draftFilters.start ?? ''}
            onChange={(event) => updateDraft({ start: event.target.value })}
          />
          <Input
            label={t('usage_records.date_end', { defaultValue: '结束日期' })}
            type="date"
            value={draftFilters.end ?? ''}
            onChange={(event) => updateDraft({ end: event.target.value })}
          />
          <Input
            label={t('usage_records.search', { defaultValue: '搜索' })}
            placeholder={t('usage_records.search_placeholder', { defaultValue: '模型、账号、端点或请求 ID' })}
            value={draftFilters.search ?? ''}
            onChange={(event) => updateDraft({ search: event.target.value })}
          />
          <div className={styles.filterField}>
            <label>{t('usage_records.model', { defaultValue: '模型' })}</label>
            <Select value={draftFilters.model ?? ''} options={modelOptions} onChange={(value) => updateDraft({ model: value })} ariaLabel={t('usage_records.model', { defaultValue: '模型' })} />
          </div>
          <div className={styles.filterField}>
            <label>{t('usage_records.provider', { defaultValue: 'Provider' })}</label>
            <Select value={draftFilters.provider ?? ''} options={providerOptions} onChange={(value) => updateDraft({ provider: value })} ariaLabel="Provider" />
          </div>
          <div className={styles.filterField}>
            <label>{t('usage_records.status', { defaultValue: '状态' })}</label>
            <Select value={draftFilters.status ?? 'all'} options={statusOptions} onChange={(value) => updateDraft({ status: value as UsageStatusFilter })} ariaLabel="Status" />
          </div>
          <div className={styles.filterField}>
            <label>{t('usage_records.sort_by', { defaultValue: '排序字段' })}</label>
            <Select value={draftFilters.sort_by ?? 'timestamp'} options={sortOptions} onChange={(value) => updateDraft({ sort_by: value as UsageRecordFilters['sort_by'] })} ariaLabel="Sort by" />
          </div>
          <div className={styles.filterField}>
            <label>{t('usage_records.sort_order', { defaultValue: '排序方向' })}</label>
            <Select value={draftFilters.sort_order ?? 'desc'} options={sortOrderOptions} onChange={(value) => updateDraft({ sort_order: value as UsageRecordFilters['sort_order'] })} ariaLabel="Sort order" />
          </div>
          <div className={styles.filterActions}>
            <Button variant="secondary" size="sm" onClick={resetFilters}>{t('common.reset', { defaultValue: '重置' })}</Button>
          </div>
        </div>
      </Card>

      <div className={styles.overviewGrid}>
        <BreakdownCard title={t('usage_records.models', { defaultValue: '模型分布' })} items={stats.models} tokenCurrency={pricing.currency} firstColumnLabel={t('usage_records.model', { defaultValue: '模型' })} />
        <BreakdownCard title={t('usage_records.accounts', { defaultValue: '账号分布' })} items={stats.accounts} tokenCurrency={pricing.currency} firstColumnLabel={t('usage_records.account', { defaultValue: '账号' })} />
      </div>

      <Card title={t('usage_records.details', { defaultValue: '使用明细' })} className={styles.detailsCard}>
        {loading ? (
          <div className={styles.loading}>{t('common.loading')}</div>
        ) : items.length === 0 ? (
          <EmptyState
            title={t('usage_records.empty_title', { defaultValue: '暂无使用记录' })}
            description={t('usage_records.empty_description', { defaultValue: '当前筛选范围内没有请求数据。' })}
          />
        ) : (
          <>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>{t('usage_records.time', { defaultValue: '时间' })}</th>
                    <th>{t('usage_records.model', { defaultValue: '模型' })}</th>
                    <th>{t('usage_records.provider', { defaultValue: 'Provider' })}</th>
                    <th>{t('usage_records.account', { defaultValue: '账号' })}</th>
                    <th>{t('usage_records.endpoint', { defaultValue: '端点' })}</th>
                    <th>{t('usage_records.reasoning_effort', { defaultValue: '思考等级' })}</th>
                    <th>{t('usage_records.tokens', { defaultValue: 'Token' })}</th>
                    <th>{t('usage_records.cache_hit_rate', { defaultValue: '缓存命中率' })}</th>
                    <th>{t('usage_records.cost', { defaultValue: '费用' })}</th>
                    <th>{t('usage_records.latency', { defaultValue: '耗时' })}</th>
                    <th>{t('usage_records.status', { defaultValue: '状态' })}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id}>
                      <td className={styles.nowrap}>{formatDateTimeValue(item.timestamp)}</td>
                      <td>
                        <strong className={styles.primaryText}>{item.model || item.alias || 'unknown'}</strong>
                        {item.alias && item.alias !== item.model && <small className={styles.mutedText}>{item.alias}</small>}
                      </td>
                      <td><span className={styles.providerBadge}>{item.provider || 'unknown'}</span></td>
                      <td className={styles.accountCell} title={item.source || item.auth_index || ''}>{item.source || item.auth_index || '--'}</td>
                      <td className={styles.endpointCell}>{item.endpoint || '--'}</td>
                      <td><span className={styles.reasoningBadge}>{item.reasoning_effort || '--'}</span></td>
                      <td>
                        <TokenDetails tokens={item.tokens} />
                      </td>
                      <td className={styles.cacheHitRate}>
                        {formatCacheHitRate(item.tokens.cached_tokens, item.tokens.input_tokens)}
                      </td>
                      <td className={item.cost_known ? styles.costValue : styles.mutedText}>{item.cost_known ? formatCost(item.cost, pricing.currency) : '--'}</td>
                      <td>
                        <LatencyDetails firstTokenMs={item.first_token_ms} totalMs={item.latency_ms} />
                      </td>
                      <td>
                        <span className={`${styles.statusBadge} ${item.failed ? styles.statusFailed : styles.statusSuccess}`}>
                          {item.failed ? t('usage_records.failed', { defaultValue: '失败' }) : t('usage_records.success', { defaultValue: '成功' })}
                        </span>
                        {item.failed && item.fail?.status_code ? <small className={styles.mutedText}>{item.fail.status_code}</small> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className={styles.paginationBar}>
              <span className={styles.paginationSummary}>
                {t('usage_records.page_total', { defaultValue: '共 {{total}} 条记录', total: listTotal })}
              </span>
              <div className={styles.paginationControls}>
                <div className={styles.pageSizeSelect}>
                  <Select
                    value={String(pageSize)}
                    options={PAGE_SIZES.map((size) => ({
                      value: String(size),
                      label: t('usage_records.page_size_option', { defaultValue: '{{count}} 条/页', count: size }),
                    }))}
                    onChange={(value) => { setPageSize(Number(value) as (typeof PAGE_SIZES)[number]); setPage(1); }}
                    ariaLabel={t('usage_records.page_size', { defaultValue: '每页数量' })}
                    size="sm"
                  />
                </div>
                <div className={styles.pageNavigation} aria-label={t('usage_records.pagination', { defaultValue: '分页导航' })}>
                  <button
                    type="button"
                    className={styles.pageButton}
                    disabled={page <= 1}
                    onClick={() => setPage((current) => Math.max(1, current - 1))}
                    aria-label={t('common.previous', { defaultValue: '上一页' })}
                    title={t('common.previous', { defaultValue: '上一页' })}
                  >
                    <IconChevronLeft size={16} />
                  </button>
                  <span className={styles.pageIndicator} aria-live="polite">
                    <strong>{page}</strong>
                    <span>/</span>
                    <span>{totalPages}</span>
                  </span>
                  <button
                    type="button"
                    className={styles.pageButton}
                    disabled={page >= totalPages}
                    onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                    aria-label={t('common.next', { defaultValue: '下一页' })}
                    title={t('common.next', { defaultValue: '下一页' })}
                  >
                    <IconChevronLeft className={styles.nextPageIcon} size={16} />
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </Card>

      <Modal
        open={pricingOpen}
        onClose={() => setPricingOpen(false)}
        title={t('usage_records.pricing_title', { defaultValue: '费用规则' })}
        width={620}
        footer={
          <div className={styles.modalFooter}>
            <Button variant="secondary" onClick={() => setPricingOpen(false)}>{t('common.cancel', { defaultValue: '取消' })}</Button>
            <Button onClick={() => void savePricing()} loading={savingPricing}>{t('common.save', { defaultValue: '保存' })}</Button>
          </div>
        }
      >
        <div className={styles.pricingForm}>
          <div className={styles.pricingIntro}>
            {t('usage_records.pricing_hint', { defaultValue: '按每百万 Token 设置默认估算价格；未启用时费用显示为未配置。' })}
          </div>
          <Input
            label={t('usage_records.currency', { defaultValue: '货币' })}
            value={pricingDraft.currency}
            onChange={(event) => setPricingDraft((current) => ({ ...current, currency: event.target.value.toUpperCase() }))}
            maxLength={8}
          />
          <div className={styles.pricingEnabledRow}>
            <span>{t('usage_records.enable_pricing', { defaultValue: '启用默认费用规则' })}</span>
            <ToggleSwitch
              checked={pricingDraft.default.enabled}
              onChange={(enabled) => setPricingDraft((current) => ({ ...current, default: { ...current.default, enabled } }))}
              ariaLabel={t('usage_records.enable_pricing', { defaultValue: '启用默认费用规则' })}
            />
          </div>
          <div className={styles.pricingGrid}>
            <PricingField label={t('usage_records.input_rate', { defaultValue: '输入 / 1M' })} value={pricingDraft.default.input_per_million} onChange={(value) => updateDefaultPricing({ input_per_million: value })} />
            <PricingField label={t('usage_records.output_rate', { defaultValue: '输出 / 1M' })} value={pricingDraft.default.output_per_million} onChange={(value) => updateDefaultPricing({ output_per_million: value })} />
            <PricingField label={t('usage_records.reasoning_rate', { defaultValue: '推理 / 1M' })} value={pricingDraft.default.reasoning_per_million} onChange={(value) => updateDefaultPricing({ reasoning_per_million: value })} />
            <PricingField label={t('usage_records.cached_rate', { defaultValue: '缓存 / 1M' })} value={pricingDraft.default.cached_per_million} onChange={(value) => updateDefaultPricing({ cached_per_million: value })} />
          </div>
          <div className={styles.modelPricingHeader}>
            <div>
              <strong>{t('usage_records.model_overrides', { defaultValue: '模型覆盖规则' })}</strong>
              <span>{t('usage_records.model_overrides_hint', { defaultValue: '优先匹配 provider/model，其次匹配模型名。' })}</span>
            </div>
            <div className={styles.modelPricingAdd}>
              <input
                className="input"
                value={newPricingModel}
                placeholder={t('usage_records.model_key_placeholder', { defaultValue: '模型或 provider/model' })}
                onChange={(event) => setNewPricingModel(event.target.value)}
              />
              <Button variant="secondary" size="sm" onClick={addModelPricing} disabled={!newPricingModel.trim()} title={t('usage_records.add_model_rule', { defaultValue: '添加模型规则' })}>
                <IconPlus size={15} />
              </Button>
            </div>
          </div>
          <div className={styles.modelPricingList}>
            {Object.entries(pricingDraft.models).length === 0 ? (
              <div className={styles.pricingExistingOverrides}>{t('usage_records.no_model_overrides', { defaultValue: '暂未配置模型覆盖规则。' })}</div>
            ) : Object.entries(pricingDraft.models).map(([model, rule]) => (
              <div className={styles.modelPricingRow} key={model}>
                <div className={styles.modelPricingName} title={model}>{model}</div>
                <ToggleSwitch
                  checked={rule.enabled}
                  onChange={(enabled) => updateModelPricing(model, { enabled })}
                  ariaLabel={`${model} pricing`}
                />
                <PricingField label={t('usage_records.input_short', { defaultValue: '入' })} value={rule.input_per_million} onChange={(value) => updateModelPricing(model, { input_per_million: value })} />
                <PricingField label={t('usage_records.output_short', { defaultValue: '出' })} value={rule.output_per_million} onChange={(value) => updateModelPricing(model, { output_per_million: value })} />
                <PricingField label={t('usage_records.reasoning_short', { defaultValue: '推' })} value={rule.reasoning_per_million} onChange={(value) => updateModelPricing(model, { reasoning_per_million: value })} />
                <PricingField label={t('usage_records.cached_short', { defaultValue: '缓' })} value={rule.cached_per_million} onChange={(value) => updateModelPricing(model, { cached_per_million: value })} />
                <Button variant="ghost" size="sm" onClick={() => removeModelPricing(model)} title={t('common.delete', { defaultValue: '删除' })}>
                  <IconTrash2 size={15} />
                </Button>
              </div>
            ))}
          </div>
        </div>
      </Modal>
    </div>
  );
}
