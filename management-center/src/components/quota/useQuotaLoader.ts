/**
 * Generic hook for quota data fetching and management.
 */

import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { AuthFileItem } from '@/types';
import {
  captureQuotaCacheGeneration,
  commitIfQuotaCacheCurrent,
  useQuotaStore,
} from '@/stores';
import { getStatusFromError } from '@/utils/quota';
import type { QuotaConfig } from './quotaConfigs';

type QuotaUpdater<T> = T | ((prev: T) => T);

type QuotaSetter<T> = (updater: QuotaUpdater<T>) => void;

interface LoadQuotaResult<TData> {
  name: string;
  status: 'success' | 'error';
  data?: TData;
  error?: string;
  errorStatus?: number;
}

const MAX_CONCURRENT_QUOTA_REQUESTS = 8;

export function useQuotaLoader<TState, TData>(config: QuotaConfig<TState, TData>) {
  const { t } = useTranslation();
  const quota = useQuotaStore(config.storeSelector);
  const setQuota = useQuotaStore((state) => state[config.storeSetter]) as QuotaSetter<
    Record<string, TState>
  >;

  const loadingRef = useRef(false);
  const requestIdRef = useRef(0);

  const loadQuota = useCallback(
    async (targets: AuthFileItem[], setLoading: (loading: boolean) => void) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      const requestId = ++requestIdRef.current;
      const cacheGeneration = captureQuotaCacheGeneration();
      setLoading(true);

      try {
        if (targets.length === 0) return;

        setQuota((prev) => {
          const nextState = { ...prev };
          targets.forEach((file) => {
            nextState[file.name] = config.buildLoadingState();
          });
          return nextState;
        });

        const results: LoadQuotaResult<TData>[] = new Array(targets.length);
        let nextTargetIndex = 0;
        const workerCount = Math.min(MAX_CONCURRENT_QUOTA_REQUESTS, targets.length);

        await Promise.all(
          Array.from({ length: workerCount }, async () => {
            while (nextTargetIndex < targets.length) {
              const targetIndex = nextTargetIndex;
              nextTargetIndex += 1;
              const file = targets[targetIndex];

              let result: LoadQuotaResult<TData>;
              try {
                const data = await config.fetchQuota(file, t);
                result = { name: file.name, status: 'success', data };
              } catch (err: unknown) {
                const message = err instanceof Error ? err.message : t('common.unknown_error');
                const errorStatus = getStatusFromError(err);
                result = { name: file.name, status: 'error', error: message, errorStatus };
              }

              results[targetIndex] = result;
            }
          })
        );

        if (requestId !== requestIdRef.current) return;

        commitIfQuotaCacheCurrent(cacheGeneration, () => {
          setQuota((prev) => {
            const nextState = { ...prev };
            results.forEach((result) => {
              if (result.status === 'success') {
                nextState[result.name] = config.buildSuccessState(result.data as TData);
              } else {
                nextState[result.name] = config.buildErrorState(
                  result.error || t('common.unknown_error'),
                  result.errorStatus
                );
              }
            });
            return nextState;
          });
        });
      } finally {
        if (requestId === requestIdRef.current) {
          setLoading(false);
          loadingRef.current = false;
        }
      }
    },
    [config, setQuota, t]
  );

  return { quota, loadQuota };
}
