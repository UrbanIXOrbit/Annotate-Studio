'use client';

import { APP_SHORTCUTS } from '@/lib/view-shortcuts';
import React, { useEffect, useMemo, useState } from 'react';
import ExternalRelinkDialog from './ExternalRelinkDialog';
import {
  Check,
  CheckCircle2,
  Circle,
  Copy,
  Cpu,
  Database,
  Download,
  FolderOpen,
  Keyboard,
  Link2,
  Loader2,
  Monitor,
  Palette,
  PlugZap,
  Trash2,
  Upload,
  Wifi,
  WifiOff,
} from 'lucide-react';
import {
  addAIProvider,
  checkOllama,
  createSnapshot,
  exportData,
  getDataDir,
  getBackupsDir,
  importData,
  inspectBackup,
  isTauri,
  removeAIProvider,
  reserveCommands,
  setDefaultAIProvider,
  testAIProvider,
  type ProviderInfo,
} from '@/lib/tauri-commands';
import { flushAll } from '@/lib/persist';
import { copyText, cn } from '@/lib/utils';
import { THEME_IDS, useSettings, type ThemeMode } from '@/store/settings';
import { PROVIDER_LABELS, useProviders } from '@/store/providers';
import { confirmDialog } from '@/store/dialogs';
import { toast } from '@/store/toast';

type Pane = 'appearance' | 'interface' | 'providers' | 'data' | 'shortcuts';

const PANES: { id: Pane; label: string; icon: React.ReactNode }[] = [
  { id: 'appearance', label: 'Appearance', icon: <Palette size={16} /> },
  { id: 'interface', label: 'Interface', icon: <Monitor size={16} /> },
  { id: 'providers', label: 'AI providers', icon: <Cpu size={16} /> },
  { id: 'data', label: 'Data & backup', icon: <Database size={16} /> },
  { id: 'shortcuts', label: 'Shortcuts', icon: <Keyboard size={16} /> },
];

const THEME_PREVIEW: Record<ThemeMode, { label: string; bg: string; card: string; text: string }> = {
  white: { label: 'Light', bg: '#F6F7F9', card: '#FFFFFF', text: '#0F172A' },
  black: { label: 'Dark', bg: '#0B0B0E', card: '#18181B', text: '#FAFAFA' },
  sepia: { label: 'Sepia', bg: '#F4ECDD', card: '#FFF8EE', text: '#2C1810' },
  gray: { label: 'Gray', bg: '#E9EAEE', card: '#FAFAFB', text: '#1F2024' },
  forest: { label: 'Forest', bg: '#E8F1E8', card: '#F8FFF8', text: '#1A2E1A' },
  ocean: { label: 'Ocean', bg: '#E4F0F6', card: '#F4FAFD', text: '#0C2D48' },
  lavender: { label: 'Lavender', bg: '#EEE7F6', card: '#FAF7FD', text: '#1E0A3C' },
  rose: { label: 'Rose', bg: '#FBEAEA', card: '#FFFAFA', text: '#3C1010' },
};

const ACCENTS = ['#2563EB', '#7C3AED', '#DB2777', '#DC2626', '#EA580C', '#16A34A', '#0D9488', '#0891B2'];

const PROVIDER_ORDER = ['openai', 'anthropic', 'google-gemini', 'ollama', 'openrouter', 'groq', 'deepseek', 'mistral', 'together', 'xai', 'perplexity', 'cohere'];

const MODEL_HINTS: Record<string, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-sonnet-5-5',
  'google-gemini': 'gemini-2.0-flash',
  ollama: 'llama3.1',
  openrouter: 'openrouter/auto',
  groq: 'llama-3.3-70b-versatile',
  deepseek: 'deepseek-chat',
  mistral: 'mistral-large-latest',
  together: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  xai: 'grok-2-latest',
  perplexity: 'sonar-pro',
  cohere: 'command-r-plus',
};

function ProvidersPane() {
  const providers = useProviders((state) => state.providers);
  const setProviders = useProviders((state) => state.set);
  const refresh = useProviders((state) => state.refresh);
  const [type, setType] = useState('openai');
  const [apiKey, setApiKey] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [model, setModel] = useState('');
  const [makeDefault, setMakeDefault] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [ollama, setOllama] = useState<boolean | null>(null);

  const ollamaEndpoint = providers.find((provider) => provider.type === 'ollama')?.endpoint ?? undefined;
  useEffect(() => {
    let cancelled = false;
    void refresh();
    checkOllama(ollamaEndpoint)
      .then((ok) => { if (!cancelled) setOllama(ok); })
      .catch(() => { if (!cancelled) setOllama(false); });
    return () => { cancelled = true; };
  }, [refresh, ollamaEndpoint]);

  const needsKey = type !== 'ollama';
  const hasEndpoint = type === 'ollama' || type === 'openrouter';

  const test = async (id: string) => {
    setTesting(id);
    try {
      const response = await testAIProvider(id);
      toast.success(`${response.model} is working`, response.content.slice(0, 120));
    } catch (error) {
      toast.error('Connection test failed', error);
    } finally {
      setTesting(null);
    }
  };

  const save = async (andTest: boolean) => {
    if (needsKey && !apiKey.trim()) {
      toast.warning('Enter an API key first');
      return;
    }
    setSaving(true);
    try {
      const next = await addAIProvider(type, apiKey.trim() || undefined, endpoint.trim() || undefined, model.trim() || undefined, makeDefault || providers.length === 0);
      setProviders(next);
      const added = next.find((p) => p.type === type && (!model.trim() || p.model === model.trim())) ?? next[next.length - 1];
      toast.success('Provider saved', added ? `${PROVIDER_LABELS[added.type] ?? added.type} · ${added.model}` : undefined);
      setApiKey('');
      setModel('');
      if (andTest && added) await test(added.id);
    } catch (error) {
      toast.error('Could not save the provider', error);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (provider: ProviderInfo) => {
    const ok = await confirmDialog({ title: `Remove ${provider.model}?`, message: 'Its API key will be deleted from this computer.', confirmLabel: 'Remove', danger: true });
    if (!ok) return;
    try {
      setProviders(await removeAIProvider(provider.type, provider.model));
    } catch (error) {
      toast.error('Could not remove the provider', error);
    }
  };

  return (
    <div className="settings-section">
      <h2>AI providers</h2>
      <p className="muted">AI features are optional. Your keys are stored only on this computer and requests go directly to the provider you choose.</p>

      <div className={cn('status-row', ollama ? 'status-ok' : 'status-off')}>
        {ollama === null ? <Loader2 size={14} className="spin" /> : ollama ? <Wifi size={14} /> : <WifiOff size={14} />}
        {ollama === null ? 'Looking for Ollama…' : ollama ? 'Ollama is running on this computer' : `Ollama was not found at ${ollamaEndpoint || 'localhost:11434'}`}
      </div>

      <div className="settings-card">
        <h3>Your models</h3>
        {providers.length === 0 ? (
          <p className="muted">No providers yet — add one below.</p>
        ) : (
          <div className="provider-list">
            {providers.map((provider) => (
              <div key={provider.id} className={cn('provider-row', provider.active && 'provider-row-active')}>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={async () => {
                    try {
                      setProviders(await setDefaultAIProvider(provider.type, provider.model));
                    } catch (error) {
                      toast.error('Could not set the default model', error);
                    }
                  }}
                  title={provider.active ? 'Default model' : 'Make default'}
                >
                  {provider.active ? <CheckCircle2 size={17} /> : <Circle size={17} />}
                </button>
                <div className="provider-info">
                  <strong>{provider.model}</strong>
                  <span>
                    {PROVIDER_LABELS[provider.type] ?? provider.type}
                    {provider.endpoint ? ` · ${provider.endpoint}` : ''}
                    {provider.active ? ' · default' : ''}
                  </span>
                </div>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void test(provider.id)} disabled={testing !== null}>
                  {testing === provider.id ? <Loader2 size={13} className="spin" /> : <PlugZap size={13} />} Test
                </button>
                <button type="button" className="icon-btn icon-btn-danger" onClick={() => void remove(provider)} title="Remove">
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="settings-card">
        <h3>Add a model</h3>
        <div className="chip-row">
          {PROVIDER_ORDER.map((id) => (
            <button
              key={id}
              type="button"
              aria-pressed={type === id} className={cn('chip', type === id && 'chip-active')}
              onClick={() => {
                setType(id);
                setEndpoint('');
                setModel('');
              }}
            >
              {PROVIDER_LABELS[id] ?? id}
            </button>
          ))}
        </div>
        <div className="form-grid form-grid-2">
          {needsKey && (
            <label className="field field-wide">
              <span className="field-label">API key</span>
              <input className="input mono" type="password" value={apiKey} autoComplete="off" onChange={(event) => setApiKey(event.target.value)} placeholder={`${PROVIDER_LABELS[type] ?? type} API key`} />
            </label>
          )}
          {hasEndpoint && (
            <label className="field field-wide">
              <span className="field-label">Endpoint</span>
              <input
                className="input mono"
                value={endpoint}
                onChange={(event) => setEndpoint(event.target.value)}
                placeholder={type === 'ollama' ? 'http://localhost:11434' : 'https://openrouter.ai/api/v1'}
              />
            </label>
          )}
          <label className="field field-wide">
            <span className="field-label">Model</span>
            <input className="input mono" value={model} onChange={(event) => setModel(event.target.value)} placeholder={MODEL_HINTS[type] ?? 'model name'} />
          </label>
          <label className="checkbox-row field-wide">
            <input type="checkbox" checked={makeDefault} onChange={(event) => setMakeDefault(event.target.checked)} />
            Use as the default model
          </label>
        </div>
        <div className="button-row">
          <button type="button" className="btn btn-primary" onClick={() => void save(false)} disabled={saving}>
            {saving ? <Loader2 size={15} className="spin" /> : <Check size={15} />} Save
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => void save(true)} disabled={saving}>
            <PlugZap size={15} /> Save and test
          </button>
        </div>
      </div>
    </div>
  );
}

function DataPane() {
  const [dataDir, setDataDir] = useState('');
  const [busy, setBusy] = useState<'export' | 'import' | 'snapshot' | null>(null);
  const [relinkOpen, setRelinkOpen] = useState(false);
  const [includeExternal, setIncludeExternal] = useState(false);
  const autoSnapshots = useSettings((state) => state.autoSnapshots);
  const noteFolder = useSettings((state) => state.noteFolder);
  const recordingFolder = useSettings((state) => state.recordingFolder);
  const inboxNotePath = useSettings((state) => state.inboxNotePath);
  const captureFolder = useSettings((state) => state.captureFolder);

  useEffect(() => {
    getDataDir().then(setDataDir).catch(() => setDataDir(''));
  }, []);

  useEffect(() => {
    if (!autoSnapshots || !isTauri()) return;
    const today = new Date().toISOString().slice(0, 10);
    if (localStorage.getItem('annotate-last-snapshot') === today) return;
    void (async () => {
      try {
        await flushAll();
        const path = await createSnapshot();
        localStorage.setItem('annotate-last-snapshot', today);
        toast.success('Snapshot saved', path);
      } catch (error) {
        toast.error('Snapshot failed', error);
      }
    })();
  }, [autoSnapshots]);

  const changeFolder = async (key: 'noteFolder' | 'recordingFolder' | 'inboxNotePath' | 'captureFolder') => {
    if (!isTauri()) return;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const folder = await open({ directory: true, multiple: false });
      if (typeof folder !== 'string') return;
      const clean = folder.replace(/[\\/]+$/, '');
      const separator = /\\/.test(clean) && !clean.includes('/') ? '\\' : '/';
      useSettings.getState().update(
        key === 'inboxNotePath' ? { inboxNotePath: `${clean}${separator}Inbox.md` } : { [key]: clean },
      );
      toast.success('Folder updated');
    } catch (error) {
      toast.error('Could not change the folder', error);
    }
  };

  const openBackupsFolder = async () => {
    try {
      const dir = isTauri() ? await getBackupsDir() : '';
      if (!dir) return;
      const { open } = await import('@tauri-apps/plugin-shell');
      await open(dir);
    } catch (error) {
      toast.error('Could not open the backups folder', error);
    }
  };

  const takeSnapshot = async () => {
    setBusy('snapshot');
    try {
      await flushAll();
      const path = await createSnapshot();
      toast.success('Snapshot saved', path);
    } catch (error) {
      toast.error('Snapshot failed', error);
    } finally {
      setBusy(null);
    }
  };

  const doExport = async () => {
    if (!isTauri()) return;
    const { save } = await import('@tauri-apps/plugin-dialog');
    const path = await save({
      defaultPath: `annotate-studio-${new Date().toISOString().slice(0, 10)}.anos`,
      filters: [{ name: 'Annotate Studio backup', extensions: ['anos'] }],
    });
    if (!path) return;
    setBusy('export');
    try {
      await flushAll();
      const count = await exportData(path, includeExternal);
      toast.success('Backup saved', `${count} files · ${path}`);
    } catch (error) {
      toast.error('Backup failed', error);
    } finally {
      setBusy(null);
    }
  };

  const doImport = async () => {
    if (!isTauri()) return;
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selection = await open({ multiple: false, filters: [{ name: 'Annotate Studio backup', extensions: ['anos', 'zip'] }] });
    if (!selection || Array.isArray(selection)) return;
    let externalDir: string | undefined;
    try {
      const info = await inspectBackup(selection);
      if (info.includesExternalFiles) {
        const folder = await open({ directory: true, multiple: false });
        if (!folder || Array.isArray(folder)) return;
        externalDir = folder;
      }
    } catch {
      // Older backups have no manifest; restore app data only.
    }
    const ok = await confirmDialog({
      title: 'Restore this backup?',
      message: 'Files in the backup replace your current data. A safety copy of your current data is saved in the backups folder first.',
      confirmLabel: 'Restore',
      danger: true,
    });
    if (!ok) return;
    setBusy('import');
    try {
      await flushAll();
      reserveCommands('import_data');
      const count = await importData(selection, externalDir);
      toast.success('Backup restored', `${count} files — reloading…`);
      setTimeout(() => window.location.reload(), 900);
    } catch (error) {
      reserveCommands(null);
      toast.error('Restore failed', error);
      setBusy(null);
    }
  };

  return (
    <div className="settings-section">
      <h2>Data & backup</h2>
      <div className="settings-card">
        <h3>Where your data lives</h3>
        <p className="muted">App-managed data (canvas layouts, flashcards, books, exams and settings) lives here. Notes and captures are usually kept in folders you choose, and are referenced in place — never copied into app storage.</p>
        <div className="path-row">
          <code>{dataDir || '…'}</code>
          <button type="button" className="icon-btn" onClick={() => void copyText(dataDir).then((ok) => ok && toast.success('Path copied'))} title="Copy path">
            <Copy size={14} />
          </button>
        </div>
        <h4>Folders you chose</h4>
        {[
          { label: 'New notes', value: noteFolder, key: 'noteFolder' as const },
          { label: 'Recordings', value: recordingFolder, key: 'recordingFolder' as const },
          { label: 'Inbox note', value: inboxNotePath, key: 'inboxNotePath' as const },
          { label: 'Captures & generated files', value: captureFolder, key: 'captureFolder' as const },
        ].map((folder) => (
          <div className="path-row" key={folder.key}>
            <div>
              <strong>{folder.label}</strong>
              <div className="muted" style={{ fontSize: 11, overflowWrap: 'anywhere' }}>{folder.value || 'Not set — choose a folder'}</div>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void changeFolder(folder.key)}>Change…</button>
          </div>
        ))}
      </div>
      <div className="settings-card">
        <h3>Back up everything</h3>
        <p className="muted">Saves all app-owned data, including Books, into a single .anos file, plus a manifest of the external files you reference. External files and API keys are not copied.</p>
        <label className="checkbox-row">
          <input type="checkbox" checked={includeExternal} onChange={(event) => setIncludeExternal(event.target.checked)} />
          Include external PDFs, books and notes (complete backup)
        </label>
        <button type="button" className="btn btn-primary" onClick={() => void doExport()} disabled={busy !== null}>
          {busy === 'export' ? <Loader2 size={15} className="spin" /> : <Download size={15} />} Create backup
        </button>
      </div>
      <div className="settings-card">
        <h3>Automatic snapshots</h3>
        <p className="muted">Keep a local snapshot of app-owned data once a day in the backups folder (last five are kept).</p>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={autoSnapshots}
            onChange={(event) => useSettings.getState().update({ autoSnapshots: event.target.checked })}
          />
          Create a snapshot when the app opens
        </label>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => void takeSnapshot()}
          disabled={busy !== null || !autoSnapshots}
          title={autoSnapshots ? 'Save a snapshot now' : 'Turn on automatic snapshots first'}
        >
          {busy === 'snapshot' ? <Loader2 size={15} className="spin" /> : <Database size={15} />} Snapshot now
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => void openBackupsFolder()}>
          <FolderOpen size={15} /> Open backups folder
        </button>
      </div>
      <div className="settings-card">
        <h3>Restore from a backup</h3>
        <p className="muted">Replaces current data with the contents of a backup file.</p>
        <button type="button" className="btn btn-secondary" onClick={() => void doImport()} disabled={busy !== null}>
          {busy === 'import' ? <Loader2 size={15} className="spin" /> : <Upload size={15} />} Restore backup…
        </button>
      </div>
      <div className="settings-card">
        <h3>Reconnect external files</h3>
        <p className="muted">After a restore or moving files, find references that no longer resolve and point them at their new location.</p>
        <button type="button" className="btn btn-secondary" onClick={() => setRelinkOpen(true)}>
          <Link2 size={15} /> Find missing files…
        </button>
      </div>
      <ExternalRelinkDialog open={relinkOpen} onClose={() => setRelinkOpen(false)} />
    </div>
  );
}

export default function SettingsTab() {
  const [pane, setPane] = useState<Pane>('appearance');
  const theme = useSettings((state) => state.theme);
  const primaryColor = useSettings((state) => state.primaryColor);
  const appScale = useSettings((state) => state.appScale);
  const notificationsEnabled = useSettings((state) => state.notificationsEnabled);
  const newItemAtPointer = useSettings((state) => state.newItemAtPointer);
  const update = useSettings((state) => state.update);
  const scales = useMemo(() => [90, 100, 110, 125, 150], []);

  return (
    <div className="split-page">
      <aside className="side-panel">
        <div className="side-panel-header">
          <span>Settings</span>
        </div>
        <div className="side-panel-list">
          {PANES.map((entry) => (
            <div key={entry.id} className={cn('side-item', pane === entry.id && 'side-item-active')}>
              <button type="button" className="side-item-main" onClick={() => setPane(entry.id)}>
                {entry.icon}
                <span className="side-item-label">{entry.label}</span>
              </button>
            </div>
          ))}
        </div>
      </aside>
      <section className="page page-narrow">
        {pane === 'appearance' && (
          <div className="settings-section">
            <h2>Appearance</h2>
            <div className="settings-card">
              <h3>Theme</h3>
              <div className="theme-grid">
                {THEME_IDS.map((id) => {
                  const preview = THEME_PREVIEW[id];
                  return (
                    <button key={id} type="button" aria-pressed={theme === id} className={cn('theme-tile', theme === id && 'theme-tile-active')} onClick={() => update({ theme: id })}>
                      <span className="theme-swatch" style={{ background: preview.bg }}>
                        <span style={{ background: preview.card, color: preview.text }}>Aa</span>
                      </span>
                      <span>{preview.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="settings-card">
              <h3>Accent color</h3>
              <div className="accent-row">
                {ACCENTS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={cn('accent-dot', primaryColor.toLowerCase() === color.toLowerCase() && 'accent-dot-active')}
                    style={{ background: color }}
                    onClick={() => update({ primaryColor: color })}
                    aria-label={`Accent ${color}`}
                  />
                ))}
                <label className="accent-custom" title="Custom color">
                  <input type="color" aria-label="Custom accent color" value={primaryColor} onChange={(event) => update({ primaryColor: event.target.value.toUpperCase() })} />
                  <span className="mono">{primaryColor}</span>
                </label>
              </div>
            </div>
          </div>
        )}

        {pane === 'interface' && (
          <div className="settings-section">
            <h2>Interface</h2>
            <div className="settings-card">
              <h3>Interface size</h3>
              <input
                type="range"
                min={80}
                max={200}
                step={5}
                value={appScale}
                onChange={(event) => update({ appScale: Number(event.target.value) })}
                className="range"
                aria-label="Interface size"
              />
              <div className="chip-row">
                {scales.map((value) => (
                  <button key={value} type="button" aria-pressed={appScale === value} className={cn('chip', appScale === value && 'chip-active')} onClick={() => update({ appScale: value })}>
                    {value}%
                  </button>
                ))}
                <span className="muted">Current: {appScale}%</span>
              </div>
            </div>
            <div className="settings-card">
              <h3>Notifications</h3>
              <label className="checkbox-row">
                <input type="checkbox" checked={notificationsEnabled} onChange={(event) => update({ notificationsEnabled: event.target.checked })} />
                Notify me when a Pomodoro phase ends and when flashcards are due
              </label>
            </div>
            <div className="settings-card">
              <h3>Canvas</h3>
              <label className="checkbox-row">
                <input type="checkbox" checked={newItemAtPointer} onChange={(event) => update({ newItemAtPointer: event.target.checked })} />
                Place new items where the mouse pointer is, instead of auto-placing them in free space
              </label>
            </div>
          </div>
        )}

        {pane === 'providers' && <ProvidersPane />}
        {pane === 'data' && <DataPane />}

        {pane === 'shortcuts' && (
          <div className="settings-section">
            <h2>Keyboard shortcuts</h2>
            <div className="settings-card">
              <table className="shortcut-table">
                <tbody>
                  {APP_SHORTCUTS.map((shortcut) => (
                    <tr key={shortcut.keys}>
                      <td>
                        <kbd>{shortcut.keys}</kbd>
                      </td>
                      <td>{shortcut.action}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
