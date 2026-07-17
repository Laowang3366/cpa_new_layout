import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { OAuthExcludedCard } from '@/features/authFiles/components/OAuthExcludedCard';
import { OAuthModelAliasCard } from '@/features/authFiles/components/OAuthModelAliasCard';
import { useAuthFilesData } from '@/features/authFiles/hooks/useAuthFilesData';
import { useAuthFilesOauth } from '@/features/authFiles/hooks/useAuthFilesOauth';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useAuthStore } from '@/stores';
import styles from './OAuthConfigPage.module.scss';

export function OAuthConfigPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const disableControls = connectionStatus !== 'connected';
  const [viewMode, setViewMode] = useState<'diagram' | 'list'>('list');
  const { files, loadFiles } = useAuthFilesData();
  const {
    excluded,
    excludedError,
    modelAlias,
    modelAliasError,
    allProviderModels,
    loadExcluded,
    loadModelAlias,
    deleteExcluded,
    deleteModelAlias,
    handleMappingUpdate,
    handleDeleteLink,
    handleToggleFork,
    handleRenameAlias,
    handleDeleteAlias,
  } = useAuthFilesOauth({ viewMode, files });

  const refresh = useCallback(async () => {
    await Promise.all([loadFiles(), loadExcluded(), loadModelAlias()]);
  }, [loadExcluded, loadFiles, loadModelAlias]);

  useHeaderRefresh(refresh);
  useEffect(() => { void refresh(); }, [refresh]);

  const openEditor = useCallback((path: string, provider?: string) => {
    const params = new URLSearchParams();
    if (provider?.trim()) params.set('provider', provider.trim());
    const query = params.toString();
    navigate(`${path}${query ? `?${query}` : ''}`, { state: { fromAuthFiles: true } });
  }, [navigate]);

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <h1>{t('nav.oauth_config', { defaultValue: 'OAuth 配置' })}</h1>
        <p>{t('nav_meta.oauth_config', { defaultValue: '模型禁用与别名管理' })}</p>
      </header>
      <OAuthExcludedCard
        disableControls={disableControls}
        excludedError={excludedError}
        excluded={excluded}
        onAdd={() => openEditor('/oauth-config/excluded')}
        onEdit={(provider) => openEditor('/oauth-config/excluded', provider)}
        onDelete={deleteExcluded}
      />
      <OAuthModelAliasCard
        disableControls={disableControls}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        onAdd={() => openEditor('/oauth-config/model-alias')}
        onEditProvider={(provider) => openEditor('/oauth-config/model-alias', provider)}
        onDeleteProvider={deleteModelAlias}
        modelAliasError={modelAliasError}
        modelAlias={modelAlias}
        allProviderModels={allProviderModels}
        onUpdate={handleMappingUpdate}
        onDeleteLink={handleDeleteLink}
        onToggleFork={handleToggleFork}
        onRenameAlias={handleRenameAlias}
        onDeleteAlias={handleDeleteAlias}
      />
    </div>
  );
}
