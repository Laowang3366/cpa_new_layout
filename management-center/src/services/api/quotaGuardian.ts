import { apiClient } from './client';

export interface GuardianReport {
  started_at?: string;
  duration_seconds?: number;
  total?: number;
  counts?: Record<string, number>;
  delete_candidates?: number;
  deleted?: number;
  delete_failed?: number;
}

export interface GuardianFailure {
  name: string;
  provider: string;
  permanent_failures: number;
  last_result: string;
  last_status: number | null;
  last_error: string;
  updated_at: string;
}

export interface GuardianAudit {
  event: string;
  name: string;
  provider: string;
  detail: string;
  created_at: string;
}

export interface GuardianStatus {
  report: GuardianReport;
  failures: GuardianFailure[];
  audit: GuardianAudit[];
  timer: { active: string; enabled: string };
  service: { active: string; enabled: string };
  settings: {
    auto_refresh: boolean;
    delete_enabled: boolean;
    concurrency: number;
    batch_size: number;
    delete_after_failures: number;
  };
}

export interface GuardianQuotaSnapshot {
  name: string;
  provider: string;
  endpoint: string;
  status: number;
  body: string;
  checked_at: string;
}

export const quotaGuardianApi = {
  status: () => apiClient.get<GuardianStatus>('/quota-guardian/status'),
  snapshots: () =>
    apiClient.get<{ snapshots: GuardianQuotaSnapshot[] }>('/quota-guardian/snapshots', {
      timeout: 60000,
    }),
  run: () => apiClient.post<{ status: string }>('/quota-guardian/run'),
  updateSettings: (settings: Partial<GuardianStatus['settings']>) =>
    apiClient.post<GuardianStatus>('/quota-guardian/settings', settings),
  deleteFailures: (names: string[]) =>
    apiClient.post<{ deleted: string[]; failed: Array<{ name: string; error: string }> }>(
      '/quota-guardian/delete',
      { names },
      { timeout: 60000 }
    ),
};
