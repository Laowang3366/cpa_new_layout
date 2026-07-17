import { apiClient } from './client';

export type UsageStatusFilter = 'all' | 'success' | 'failed';
export type UsageGranularity = 'day' | 'hour';

export interface UsageTokens {
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cached_tokens: number;
  total_tokens: number;
}

export interface UsageFailure {
  status_code: number;
  body?: string;
}

export interface UsageRecord {
  id: number;
  timestamp: string;
  first_token_ms?: number;
  latency_ms: number;
  source?: string;
  reasoning_effort?: string;
  auth_index?: string;
  tokens: UsageTokens;
  failed: boolean;
  fail?: UsageFailure;
  provider: string;
  model: string;
  alias?: string;
  endpoint?: string;
  auth_type?: string;
  request_id?: string;
  cost: number;
  cost_known: boolean;
}

export interface UsageBreakdown {
  key: string;
  requests: number;
  failures: number;
  tokens: number;
  input_tokens: number;
  cached_tokens: number;
  cost: number;
  cost_known: boolean;
}

export interface UsageTrendPoint {
  timestamp: string;
  requests: number;
  failures: number;
  tokens: number;
  cost: number;
  cost_known: boolean;
}

export interface UsageStats {
  total_requests: number;
  success_requests: number;
  failed_requests: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cached_tokens: number;
  total_tokens: number;
  total_cost: number;
  priced_requests: number;
  unpriced_requests: number;
  average_latency_ms: number;
  models: UsageBreakdown[];
  providers: UsageBreakdown[];
  endpoints: UsageBreakdown[];
  accounts: UsageBreakdown[];
  trend: UsageTrendPoint[];
}

export interface UsagePricingRule {
  enabled: boolean;
  input_per_million: number;
  output_per_million: number;
  reasoning_per_million: number;
  cached_per_million: number;
}

export interface UsagePricingConfig {
  currency: string;
  default: UsagePricingRule;
  models: Record<string, UsagePricingRule>;
}

export interface UsageRecordFilters {
  start?: string;
  end?: string;
  model?: string;
  provider?: string;
  endpoint?: string;
  source?: string;
  auth_index?: string;
  status?: UsageStatusFilter;
  search?: string;
  sort_by?: 'timestamp' | 'model' | 'provider' | 'tokens' | 'cost' | 'latency';
  sort_order?: 'asc' | 'desc';
  granularity?: UsageGranularity;
  page?: number;
  page_size?: number;
}

export interface UsageRecordListResponse {
  items: UsageRecord[];
  total: number;
  page: number;
  page_size: number;
}

const USAGE_TIMEOUT_MS = 20 * 1000;

export const usageRecordsApi = {
  list: (filters: UsageRecordFilters) =>
    apiClient.get<UsageRecordListResponse>('/usage-records', {
      params: filters,
      timeout: USAGE_TIMEOUT_MS,
    }),

  stats: (filters: UsageRecordFilters) =>
    apiClient.get<UsageStats>('/usage-records/stats', {
      params: filters,
      timeout: USAGE_TIMEOUT_MS,
    }),

  getPricing: () =>
    apiClient.get<UsagePricingConfig>('/usage-records/pricing', {
      timeout: USAGE_TIMEOUT_MS,
    }),

  updatePricing: (pricing: UsagePricingConfig) =>
    apiClient.put<UsagePricingConfig>('/usage-records/pricing', pricing, {
      timeout: USAGE_TIMEOUT_MS,
    }),
};
