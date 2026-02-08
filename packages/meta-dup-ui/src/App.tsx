import { useState, useEffect, useCallback } from 'react';
import type { DuplicateData, DuplicateGroup, HealthStatus, FileInfo } from './types';
import { formatNumber, formatDate, getFilename, truncateHash, formatBytes } from './utils/format';
import ServiceNav from './components/ServiceNav';

function App() {
    const [duplicateData, setDuplicateData] = useState<DuplicateData | null>(null);
    const [health, setHealth] = useState<HealthStatus | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<'hash' | 'title'>('hash');
    const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
    const [rebuilding, setRebuilding] = useState(false);

    const fetchDuplicates = useCallback(async () => {
        try {
            const res = await fetch('/api/duplicates');
            if (res.ok) {
                const data = await res.json();
                setDuplicateData(data);
                setError(null);
            } else {
                setError('Failed to fetch duplicate data');
            }
        } catch (err) {
            console.error('Failed to fetch duplicates:', err);
            setError('Failed to fetch duplicate data');
        }
    }, []);

    const fetchHealth = useCallback(async () => {
        try {
            const res = await fetch('/health');
            if (res.ok) {
                const data = await res.json();
                setHealth(data);
            }
        } catch (err) {
            console.error('Failed to fetch health:', err);
        }
    }, []);

    const rebuildIndex = async () => {
        setRebuilding(true);
        try {
            const res = await fetch('/api/duplicates/rebuild', { method: 'POST' });
            if (res.ok) {
                await fetchDuplicates();
            } else {
                setError('Failed to rebuild index');
            }
        } catch (err) {
            console.error('Failed to rebuild:', err);
            setError('Failed to rebuild index');
        } finally {
            setRebuilding(false);
        }
    };

    useEffect(() => {
        fetchDuplicates();
        fetchHealth();
        const interval = setInterval(() => {
            fetchDuplicates();
            fetchHealth();
        }, 10000); // Refresh every 10s
        return () => clearInterval(interval);
    }, [fetchDuplicates, fetchHealth]);

    const toggleGroup = (key: string) => {
        setExpandedGroups(prev => {
            const next = new Set(prev);
            if (next.has(key)) {
                next.delete(key);
            } else {
                next.add(key);
            }
            return next;
        });
    };

    const expandAll = () => {
        const groups = activeTab === 'hash'
            ? duplicateData?.hashDuplicates
            : duplicateData?.titleDuplicates;
        if (groups) {
            setExpandedGroups(new Set(groups.map(g => g.key)));
        }
    };

    const collapseAll = () => {
        setExpandedGroups(new Set());
    };

    const renderFileInfo = (file: FileInfo, idx: number) => (
        <div key={file.hashId} className="file-item">
            <span className="file-index">{idx + 1}.</span>
            <span className="file-name" title={file.filePath}>{getFilename(file.filePath)}</span>
            <span className="file-path" title={file.filePath}>{file.filePath}</span>
            {file.sizeByte && (
                <span className="file-size">{formatBytes(file.sizeByte)}</span>
            )}
        </div>
    );

    const renderDuplicateGroup = (group: DuplicateGroup, type: 'hash' | 'title') => {
        const isExpanded = expandedGroups.has(group.key);
        const displayKey = type === 'hash'
            ? truncateHash(group.key, 16)
            : group.key;

        return (
            <div key={group.key} className={`duplicate-group ${isExpanded ? 'expanded' : ''}`}>
                <div
                    className="group-header"
                    onClick={() => toggleGroup(group.key)}
                >
                    <span className="expand-icon">{isExpanded ? '▼' : '▶'}</span>
                    <span className="group-key" title={group.key}>{displayKey}</span>
                    <span className="group-count">{group.files.length} files</span>
                </div>
                {isExpanded && (
                    <div className="group-files">
                        {group.files.map((file, idx) => renderFileInfo(file, idx))}
                    </div>
                )}
            </div>
        );
    };

    const hashDuplicates = duplicateData?.hashDuplicates || [];
    const titleDuplicates = duplicateData?.titleDuplicates || [];
    const stats = duplicateData?.stats;

    return (
        <div className="app">
            <header className="header">
                <h1>meta-dup</h1>
                <span className="subtitle">Duplicate Detection Service</span>
                {health && (
                    <span className={`status-badge ${health.status}`}>
                        {health.status === 'ok' ? '● Connected' : '○ Degraded'}
                    </span>
                )}
            </header>

            <main className="main">
                <ServiceNav />
                {error && (
                    <div className="error-banner">{error}</div>
                )}

                {/* Stats Cards */}
                {stats && (
                    <div className="stats-cards">
                        <div className="stat-card hash">
                            <div className="stat-icon">#</div>
                            <div className="stat-content">
                                <div className="stat-value">{formatNumber(stats.hashGroupCount)}</div>
                                <div className="stat-label">Hash Duplicate Groups</div>
                                <div className="stat-detail">{formatNumber(stats.hashFileCount)} total files</div>
                            </div>
                        </div>
                        <div className="stat-card title">
                            <div className="stat-icon">T</div>
                            <div className="stat-content">
                                <div className="stat-value">{formatNumber(stats.titleGroupCount)}</div>
                                <div className="stat-label">Title Duplicate Groups</div>
                                <div className="stat-detail">{formatNumber(stats.titleFileCount)} total files</div>
                            </div>
                        </div>
                        <div className="stat-card info">
                            <div className="stat-icon">i</div>
                            <div className="stat-content">
                                <div className="stat-value">{formatNumber(stats.totalFilesTracked)}</div>
                                <div className="stat-label">Total Files Tracked</div>
                                <div className="stat-detail">
                                    Last updated: {formatDate(stats.lastUpdated)}
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {/* Action Bar */}
                <div className="action-bar">
                    <button
                        className="btn btn-primary"
                        onClick={rebuildIndex}
                        disabled={rebuilding}
                    >
                        {rebuilding ? 'Rebuilding...' : 'Rebuild Index'}
                    </button>
                </div>

                {/* Tabs */}
                <div className="card duplicates-card">
                    <div className="tabs-header">
                        <div className="tabs">
                            <button
                                className={`tab ${activeTab === 'hash' ? 'active' : ''}`}
                                onClick={() => setActiveTab('hash')}
                            >
                                Hash Duplicates ({hashDuplicates.length})
                            </button>
                            <button
                                className={`tab ${activeTab === 'title' ? 'active' : ''}`}
                                onClick={() => setActiveTab('title')}
                            >
                                Title Duplicates ({titleDuplicates.length})
                            </button>
                        </div>
                        <div className="tab-actions">
                            <button className="btn btn-small btn-secondary" onClick={expandAll}>
                                Expand All
                            </button>
                            <button className="btn btn-small btn-secondary" onClick={collapseAll}>
                                Collapse All
                            </button>
                        </div>
                    </div>

                    <div className="tab-content">
                        {activeTab === 'hash' && (
                            <div className="duplicates-list">
                                {hashDuplicates.length === 0 ? (
                                    <div className="empty-state">
                                        <p>No hash duplicates found</p>
                                        <p className="hint">Files with identical content (same SHA-256 hash)</p>
                                    </div>
                                ) : (
                                    <>
                                        <p className="list-description">
                                            Files with identical content (exact byte-for-byte matches)
                                        </p>
                                        {hashDuplicates.map(group => renderDuplicateGroup(group, 'hash'))}
                                    </>
                                )}
                            </div>
                        )}

                        {activeTab === 'title' && (
                            <div className="duplicates-list">
                                {titleDuplicates.length === 0 ? (
                                    <div className="empty-state">
                                        <p>No title duplicates found</p>
                                        <p className="hint">Files with similar parsed titles</p>
                                    </div>
                                ) : (
                                    <>
                                        <p className="list-description">
                                            Files with matching parsed titles (may be different quality/releases)
                                        </p>
                                        {titleDuplicates.map(group => renderDuplicateGroup(group, 'title'))}
                                    </>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </main>

            <style>{`
                :root {
                    --bg-primary: #0d1117;
                    --bg-secondary: #161b22;
                    --bg-tertiary: #21262d;
                    --text-primary: #f0f6fc;
                    --text-secondary: #8b949e;
                    --border-color: #30363d;
                    --accent-primary: #58a6ff;
                    --accent-green: #3fb950;
                    --error: #f85149;
                }

                * {
                    margin: 0;
                    padding: 0;
                    box-sizing: border-box;
                }

                body {
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    background: var(--bg-primary);
                    color: var(--text-primary);
                    min-height: 100vh;
                }

                .app {
                    min-height: 100vh;
                    display: flex;
                    flex-direction: column;
                }

                .header {
                    background: var(--bg-secondary);
                    border-bottom: 1px solid var(--border-color);
                    padding: 16px 24px;
                    display: flex;
                    align-items: center;
                    gap: 16px;
                }

                .header h1 {
                    font-size: 1.5rem;
                    font-weight: 600;
                }

                .subtitle {
                    color: var(--text-secondary);
                    font-size: 0.9rem;
                }

                .status-badge {
                    margin-left: auto;
                    padding: 4px 12px;
                    border-radius: 12px;
                    font-size: 0.85rem;
                }

                .status-badge.ok {
                    background: rgba(63, 185, 80, 0.1);
                    color: var(--accent-green);
                }

                .status-badge.degraded {
                    background: rgba(248, 81, 73, 0.1);
                    color: var(--error);
                }

                .main {
                    flex: 1;
                    padding: 24px;
                    max-width: 1400px;
                    margin: 0 auto;
                    width: 100%;
                }

                .error-banner {
                    background: rgba(248, 81, 73, 0.1);
                    border: 1px solid var(--error);
                    color: var(--error);
                    padding: 12px 16px;
                    border-radius: 8px;
                    margin-bottom: 20px;
                }

                /* Stats Cards */
                .stats-cards {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
                    gap: 16px;
                    margin-bottom: 24px;
                }

                .stat-card {
                    background: var(--bg-secondary);
                    border-radius: 12px;
                    padding: 20px;
                    display: flex;
                    gap: 16px;
                    align-items: center;
                    border: 1px solid var(--border-color);
                }

                .stat-card.hash {
                    border-left: 4px solid #a78bfa;
                }

                .stat-card.title {
                    border-left: 4px solid #fbbf24;
                }

                .stat-card.info {
                    border-left: 4px solid #60a5fa;
                }

                .stat-icon {
                    width: 48px;
                    height: 48px;
                    background: var(--bg-tertiary);
                    border-radius: 12px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 1.5rem;
                    font-weight: bold;
                    color: var(--text-secondary);
                }

                .stat-card.hash .stat-icon { color: #a78bfa; }
                .stat-card.title .stat-icon { color: #fbbf24; }
                .stat-card.info .stat-icon { color: #60a5fa; }

                .stat-content { flex: 1; }

                .stat-value {
                    font-size: 1.8rem;
                    font-weight: 700;
                    color: var(--text-primary);
                }

                .stat-label {
                    color: var(--text-secondary);
                    font-size: 0.9rem;
                }

                .stat-detail {
                    color: var(--text-secondary);
                    font-size: 0.8rem;
                    margin-top: 4px;
                    opacity: 0.7;
                }

                /* Action Bar */
                .action-bar {
                    display: flex;
                    gap: 12px;
                    margin-bottom: 20px;
                }

                /* Buttons */
                .btn {
                    padding: 10px 20px;
                    border: none;
                    border-radius: 8px;
                    font-size: 1rem;
                    cursor: pointer;
                    transition: all 0.2s;
                }

                .btn-primary {
                    background: var(--accent-primary);
                    color: white;
                }

                .btn-primary:hover:not(:disabled) {
                    background: #4393e6;
                }

                .btn-primary:disabled {
                    opacity: 0.5;
                    cursor: not-allowed;
                }

                .btn-secondary {
                    background: var(--bg-tertiary);
                    color: var(--text-primary);
                    border: 1px solid var(--border-color);
                }

                .btn-secondary:hover {
                    background: var(--bg-secondary);
                }

                .btn-small {
                    padding: 6px 12px;
                    font-size: 0.85rem;
                }

                /* Card */
                .card {
                    background: var(--bg-secondary);
                    border-radius: 12px;
                    border: 1px solid var(--border-color);
                    padding: 20px;
                }

                /* Tabs */
                .duplicates-card {
                    min-height: 400px;
                }

                .tabs-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 20px;
                    border-bottom: 1px solid var(--border-color);
                    padding-bottom: 12px;
                }

                .tabs {
                    display: flex;
                    gap: 8px;
                }

                .tab {
                    padding: 10px 20px;
                    background: transparent;
                    border: none;
                    color: var(--text-secondary);
                    font-size: 1rem;
                    cursor: pointer;
                    border-radius: 8px 8px 0 0;
                    transition: all 0.2s;
                }

                .tab:hover {
                    color: var(--text-primary);
                    background: var(--bg-tertiary);
                }

                .tab.active {
                    color: var(--accent-primary);
                    background: var(--bg-tertiary);
                    font-weight: 600;
                }

                .tab-actions {
                    display: flex;
                    gap: 8px;
                }

                /* Duplicates List */
                .list-description {
                    color: var(--text-secondary);
                    font-size: 0.9rem;
                    margin-bottom: 16px;
                }

                .duplicates-list {
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                }

                .duplicate-group {
                    background: var(--bg-tertiary);
                    border-radius: 8px;
                    overflow: hidden;
                }

                .group-header {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                    padding: 12px 16px;
                    cursor: pointer;
                    transition: background 0.2s;
                }

                .group-header:hover {
                    background: var(--bg-secondary);
                }

                .expand-icon {
                    color: var(--text-secondary);
                    font-size: 0.8rem;
                    width: 16px;
                }

                .group-key {
                    flex: 1;
                    font-family: monospace;
                    font-size: 0.9rem;
                    color: var(--accent-primary);
                }

                .group-count {
                    background: var(--bg-secondary);
                    padding: 4px 10px;
                    border-radius: 12px;
                    font-size: 0.8rem;
                    color: var(--text-secondary);
                }

                .group-files {
                    background: var(--bg-secondary);
                    padding: 8px 16px;
                    border-top: 1px solid var(--border-color);
                }

                .file-item {
                    display: grid;
                    grid-template-columns: 30px 200px 1fr auto;
                    gap: 12px;
                    padding: 8px 0;
                    border-bottom: 1px solid var(--border-color);
                    font-size: 0.85rem;
                    align-items: center;
                }

                .file-item:last-child {
                    border-bottom: none;
                }

                .file-index {
                    color: var(--text-secondary);
                    text-align: right;
                }

                .file-name {
                    font-weight: 500;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }

                .file-path {
                    color: var(--text-secondary);
                    font-family: monospace;
                    font-size: 0.8rem;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }

                .file-size {
                    color: var(--text-secondary);
                    font-size: 0.8rem;
                    white-space: nowrap;
                }

                /* Empty State */
                .empty-state {
                    text-align: center;
                    padding: 60px 20px;
                    color: var(--text-secondary);
                }

                .empty-state p {
                    margin: 0;
                }

                .empty-state .hint {
                    font-size: 0.9rem;
                    margin-top: 8px;
                    opacity: 0.7;
                }

                @media (max-width: 800px) {
                    .tabs-header {
                        flex-direction: column;
                        gap: 12px;
                        align-items: flex-start;
                    }

                    .file-item {
                        grid-template-columns: 30px 1fr;
                    }

                    .file-path, .file-size {
                        grid-column: 1 / -1;
                        padding-left: 42px;
                    }
                }
            `}</style>
        </div>
    );
}

export default App;
