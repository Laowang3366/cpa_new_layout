import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { IconRefreshCw, IconShield } from '@/components/ui/icons';
import { quotaGuardianApi, type GuardianStatus } from '@/services/api';
import styles from './QuotaGuardianPage.module.scss';

const emptyStatus: GuardianStatus = {
  report: {},
  failures: [],
  audit: [],
  timer: { active: 'unknown', enabled: 'unknown' },
  service: { active: 'unknown', enabled: 'unknown' },
  settings: {
    auto_refresh: false,
    delete_enabled: false,
    concurrency: 12,
    batch_size: 50,
    delete_after_failures: 3,
  },
};

const formatTime = (value?: string) => {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

export function QuotaGuardianPage() {
  const [status, setStatus] = useState<GuardianStatus>(emptyStatus);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const [errorPage, setErrorPage] = useState(1);
  const [auditPage, setAuditPage] = useState(1);
  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());
  const [errorQuery, setErrorQuery] = useState('');
  const [errorProvider, setErrorProvider] = useState('all');
  const [errorStatus, setErrorStatus] = useState('all');
  const [auditQuery, setAuditQuery] = useState('');
  const [auditProvider, setAuditProvider] = useState('all');
  const [auditResult, setAuditResult] = useState('all');
  const [errorPageSize, setErrorPageSize] = useState(10);
  const [auditPageSize, setAuditPageSize] = useState(10);

  const loadStatus = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const next = await quotaGuardianApi.status();
      setStatus(next);
      setRunning(['active', 'activating'].includes(next.service.active));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取插件状态失败');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
    const timer = window.setInterval(() => loadStatus(true), running ? 3000 : 15000);
    return () => window.clearInterval(timer);
  }, [loadStatus, running]);

  const filteredFailures = useMemo(() => {
    const query = errorQuery.trim().toLowerCase();
    return status.failures.filter((item) => {
      if (errorProvider !== 'all' && item.provider !== errorProvider) return false;
      if (errorStatus === '5xx' && (item.last_status === null || item.last_status < 500)) return false;
      if (errorStatus !== 'all' && errorStatus !== '5xx' && String(item.last_status ?? '') !== errorStatus) return false;
      if (!query) return true;
      return `${item.name} ${item.last_error}`.toLowerCase().includes(query);
    });
  }, [errorProvider, errorQuery, errorStatus, status.failures]);
  const errorPageCount = Math.max(1, Math.ceil(filteredFailures.length / errorPageSize));
  const visibleFailures = useMemo(
    () => filteredFailures.slice((errorPage - 1) * errorPageSize, errorPage * errorPageSize),
    [errorPage, errorPageSize, filteredFailures]
  );
  const filteredAudit = useMemo(() => {
    const query = auditQuery.trim().toLowerCase();
    return status.audit.filter((item) => {
      if (auditProvider !== 'all' && item.provider !== auditProvider) return false;
      if (auditResult !== 'all' && item.event !== auditResult) return false;
      if (!query) return true;
      return `${item.name} ${item.detail}`.toLowerCase().includes(query);
    });
  }, [auditProvider, auditQuery, auditResult, status.audit]);
  const auditPageCount = Math.max(1, Math.ceil(filteredAudit.length / auditPageSize));
  const visibleAudit = useMemo(
    () => filteredAudit.slice((auditPage - 1) * auditPageSize, auditPage * auditPageSize),
    [auditPage, auditPageSize, filteredAudit]
  );
  const visibleNames = visibleFailures.map((item) => item.name);
  const allVisibleSelected =
    visibleNames.length > 0 && visibleNames.every((name) => selectedNames.has(name));

  useEffect(() => {
    setErrorPage((current) => Math.min(current, errorPageCount));
    const validNames = new Set(status.failures.map((item) => item.name));
    setSelectedNames((current) => new Set([...current].filter((name) => validNames.has(name))));
  }, [errorPageCount, status.failures]);

  useEffect(() => {
    setAuditPage((current) => Math.min(current, auditPageCount));
  }, [auditPageCount]);

  useEffect(() => setErrorPage(1), [errorProvider, errorQuery, errorStatus]);
  useEffect(() => setAuditPage(1), [auditProvider, auditQuery, auditResult]);
  useEffect(() => setErrorPage(1), [errorPageSize]);
  useEffect(() => setAuditPage(1), [auditPageSize]);

  const runNow = async () => {
    setRunning(true);
    setError('');
    try {
      await quotaGuardianApi.run();
      window.setTimeout(() => loadStatus(true), 1000);
    } catch (err) {
      setRunning(false);
      setError(err instanceof Error ? err.message : '启动刷新失败');
    }
  };

  const saveSettings = async (patch: Partial<GuardianStatus['settings']>) => {
    setSaving(true);
    setError('');
    try {
      const next = await quotaGuardianApi.updateSettings(patch);
      setStatus(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存设置失败');
    } finally {
      setSaving(false);
    }
  };

  const toggleSelected = (name: string) => {
    setSelectedNames((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const toggleVisible = () => {
    setSelectedNames((current) => {
      const next = new Set(current);
      if (allVisibleSelected) visibleNames.forEach((name) => next.delete(name));
      else visibleNames.forEach((name) => next.add(name));
      return next;
    });
  };

  const deleteSelected = async () => {
    const names = [...selectedNames];
    if (names.length === 0) return;
    if (!window.confirm(`确定永久删除选中的 ${names.length} 个错误凭证吗？该操作不会创建备份。`)) {
      return;
    }
    setDeleting(true);
    setError('');
    try {
      const result = await quotaGuardianApi.deleteFailures(names);
      if (result.failed.length > 0) {
        setError(`已删除 ${result.deleted.length} 个，${result.failed.length} 个删除失败`);
      }
      setSelectedNames(new Set());
      await loadStatus(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除错误凭证失败');
    } finally {
      setDeleting(false);
    }
  };

  const counts = status.report.counts ?? {};
  const completed = Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0);
  const total = status.report.total ?? 0;
  const progress = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div>
          <div className={styles.titleLine}>
            <IconShield size={24} />
            <h1>额度守护</h1>
            <span className={`${styles.status} ${running ? styles.running : styles.ready}`}>
              {running ? '刷新中' : status.timer.active === 'active' ? '自动运行中' : '已停止'}
            </span>
          </div>
          <p>在服务器后台批量刷新全部凭证额度，并处理连续失效的账号。</p>
        </div>
        <Button onClick={runNow} loading={running} disabled={loading || running}>
          <IconRefreshCw size={16} />
          立即批量刷新
        </Button>
      </header>

      {error && <div className={styles.error}>{error}</div>}

      <section className={styles.summary} aria-label="最近运行统计">
        <div><span>账号总数</span><strong>{total}</strong></div>
        <div><span>刷新成功</span><strong className={styles.success}>{counts.success ?? 0}</strong></div>
        <div><span>临时错误</span><strong>{counts.temporary ?? 0}</strong></div>
        <div><span>永久错误</span><strong className={styles.danger}>{counts.permanent ?? 0}</strong></div>
      </section>

      <div className={styles.progressTrack} aria-label={`刷新进度 ${progress}%`}>
        <div className={styles.progressFill} style={{ width: `${progress}%` }} />
      </div>
      <div className={styles.runMeta}>最近完成：{formatTime(status.report.started_at)}</div>

      <section className={styles.settings}>
        <div className={styles.sectionHeading}>
          <h2>自动化设置</h2>
        </div>
        <div className={styles.settingGrid}>
          <label className={styles.switchRow}>
            <span><strong>自动刷新</strong><small>每 30 分钟刷新全部启用账号</small></span>
            <input
              type="checkbox"
              checked={status.settings.auto_refresh}
              disabled={saving}
              onChange={(event) => saveSettings({ auto_refresh: event.target.checked })}
            />
          </label>
          <label className={styles.switchRow}>
            <span><strong>自动删除</strong><small>达到连续失败阈值后直接永久删除</small></span>
            <input
              type="checkbox"
              checked={status.settings.delete_enabled}
              disabled={saving}
              onChange={(event) => saveSettings({ delete_enabled: event.target.checked })}
            />
          </label>
          <label>
            <span>并发请求数</span>
            <input
              type="number"
              min="1"
              max="32"
              value={status.settings.concurrency}
              onChange={(event) =>
                setStatus((current) => ({
                  ...current,
                  settings: { ...current.settings, concurrency: Number(event.target.value) },
                }))
              }
              onBlur={() => saveSettings({ concurrency: status.settings.concurrency })}
            />
          </label>
          <label>
            <span>每批账号数</span>
            <input
              type="number"
              min="1"
              max="200"
              value={status.settings.batch_size}
              onChange={(event) =>
                setStatus((current) => ({
                  ...current,
                  settings: { ...current.settings, batch_size: Number(event.target.value) },
                }))
              }
              onBlur={() => saveSettings({ batch_size: status.settings.batch_size })}
            />
          </label>
          <label>
            <span>连续失败删除阈值</span>
            <input
              type="number"
              min="2"
              max="10"
              value={status.settings.delete_after_failures}
              onChange={(event) =>
                setStatus((current) => ({
                  ...current,
                  settings: {
                    ...current.settings,
                    delete_after_failures: Number(event.target.value),
                  },
                }))
              }
              onBlur={() =>
                saveSettings({ delete_after_failures: status.settings.delete_after_failures })
              }
            />
          </label>
        </div>
      </section>

      <section>
        <div className={styles.sectionHeading}>
          <h2>当前错误账号</h2>
          <div className={styles.errorActions}>
            <Button
              variant="secondary"
              size="sm"
              disabled={status.failures.length === 0 || deleting}
              onClick={() => setSelectedNames(new Set(filteredFailures.map((item) => item.name)))}
            >
              全选筛选结果
            </Button>
            <Button
              variant="danger"
              size="sm"
              loading={deleting}
              disabled={selectedNames.size === 0}
              onClick={deleteSelected}
            >
              删除所选 ({selectedNames.size})
            </Button>
          </div>
        </div>
        <div className={styles.filters}>
          <input value={errorQuery} onChange={(event) => setErrorQuery(event.target.value)} placeholder="搜索凭证名或错误信息" />
          <select value={errorProvider} onChange={(event) => setErrorProvider(event.target.value)} aria-label="错误账号类型筛选">
            <option value="all">全部类型</option><option value="codex">Codex</option><option value="xai">xAI</option><option value="claude">Claude</option><option value="kimi">Kimi</option>
          </select>
          <select value={errorStatus} onChange={(event) => setErrorStatus(event.target.value)} aria-label="HTTP 状态筛选">
            <option value="all">全部状态</option><option value="401">401</option><option value="402">402</option><option value="403">403</option><option value="429">429</option><option value="5xx">5xx</option>
          </select>
        </div>
        <div className={styles.tableWrap}>
          <table>
            <thead><tr><th className={styles.checkCell}><input type="checkbox" aria-label="全选本页" checked={allVisibleSelected} onChange={toggleVisible} /></th><th>凭证</th><th>类型</th><th>状态</th><th>连续失败</th><th>错误信息</th><th>时间</th></tr></thead>
            <tbody>
              {status.failures.length === 0 ? (
                <tr><td colSpan={7} className={styles.empty}>当前没有刷新错误</td></tr>
              ) : visibleFailures.map((item) => (
                <tr key={item.name}>
                  <td className={styles.checkCell}><input type="checkbox" aria-label={`选择 ${item.name}`} checked={selectedNames.has(item.name)} onChange={() => toggleSelected(item.name)} /></td>
                  <td className={styles.fileName}>{item.name}</td>
                  <td>{item.provider}</td>
                  <td>{item.last_status ?? '-'}</td>
                  <td>{item.permanent_failures}</td>
                  <td className={styles.errorText}>{item.last_error}</td>
                  <td>{formatTime(item.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {status.failures.length > 0 && (
          <div className={styles.pagination}>
            <Button variant="secondary" size="sm" disabled={errorPage <= 1} onClick={() => setErrorPage((page) => page - 1)}>上一页</Button>
            <span>第 {errorPage} / {errorPageCount} 页</span>
            <label className={styles.pageSize}>每页 <select value={errorPageSize} onChange={(event) => setErrorPageSize(Number(event.target.value))}><option value="10">10</option><option value="30">30</option><option value="50">50</option></select> 条</label>
            <span>共 {filteredFailures.length} 条</span>
            <Button variant="secondary" size="sm" disabled={errorPage >= errorPageCount} onClick={() => setErrorPage((page) => page + 1)}>下一页</Button>
          </div>
        )}
      </section>

      <section>
        <div className={styles.sectionHeading}>
          <h2>删除审计</h2>
        </div>
        <div className={styles.filters}>
          <input value={auditQuery} onChange={(event) => setAuditQuery(event.target.value)} placeholder="搜索凭证名或错误信息" />
          <select value={auditProvider} onChange={(event) => setAuditProvider(event.target.value)} aria-label="删除审计类型筛选">
            <option value="all">全部类型</option><option value="codex">Codex</option><option value="xai">xAI</option><option value="claude">Claude</option><option value="kimi">Kimi</option>
          </select>
          <select value={auditResult} onChange={(event) => setAuditResult(event.target.value)} aria-label="删除结果筛选">
            <option value="all">全部结果</option><option value="deleted">已删除</option><option value="delete_failed">删除失败</option>
          </select>
        </div>
        <div className={styles.tableWrap}>
          <table>
            <thead><tr><th>凭证</th><th>类型</th><th>结果</th><th>错误信息</th><th>时间</th></tr></thead>
            <tbody>
              {status.audit.length === 0 ? (
                <tr><td colSpan={5} className={styles.empty}>暂无删除记录</td></tr>
              ) : visibleAudit.map((item, index) => (
                <tr key={`${item.name}-${item.created_at}-${index}`}>
                  <td className={styles.fileName}>{item.name}</td>
                  <td>{item.provider || '-'}</td>
                  <td>{item.event === 'deleted' ? '已删除' : '删除失败'}</td>
                  <td className={styles.errorText}>{item.detail}</td>
                  <td>{formatTime(item.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {status.audit.length > 0 && (
          <div className={styles.pagination}>
            <Button variant="secondary" size="sm" disabled={auditPage <= 1} onClick={() => setAuditPage((page) => page - 1)}>上一页</Button>
            <span>第 {auditPage} / {auditPageCount} 页</span>
            <label className={styles.pageSize}>每页 <select value={auditPageSize} onChange={(event) => setAuditPageSize(Number(event.target.value))}><option value="10">10</option><option value="30">30</option><option value="50">50</option></select> 条</label>
            <span>共 {filteredAudit.length} 条</span>
            <Button variant="secondary" size="sm" disabled={auditPage >= auditPageCount} onClick={() => setAuditPage((page) => page + 1)}>下一页</Button>
          </div>
        )}
      </section>
    </div>
  );
}
