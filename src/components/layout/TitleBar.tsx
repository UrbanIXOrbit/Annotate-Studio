'use client';

import React from 'react';
import { Pause, Play, Timer } from 'lucide-react';
import WorkspaceSwitcher from '@/components/canvas/WorkspaceSwitcher';
import { useApp } from '@/store/app';
import { usePomodoro } from '@/store/pomodoro';
import { useWorkspaceScopes } from '@/store/workspace-scopes';
import { cn, formatDuration } from '@/lib/utils';

function PomodoroChip() {
  const status = usePomodoro((state) => state.status);
  const phase = usePomodoro((state) => state.phase);
  const remaining = usePomodoro((state) => state.remaining);
  const setView = useApp((state) => state.setView);
  if (status === 'idle') return null;
  return (
    <div className={cn('titlebar-chip', phase === 'focus' ? 'chip-focus' : 'chip-break')}>
      <button type="button" onClick={() => setView('pomodoro')} title="Open Pomodoro">
        <Timer size={12} />
        <span>{formatDuration(remaining)}</span>
      </button>
      <button
        type="button"
        onClick={() => (status === 'running' ? usePomodoro.getState().pause() : usePomodoro.getState().resume())}
        title={status === 'running' ? 'Pause' : 'Resume'}
      >
        {status === 'running' ? <Pause size={11} /> : <Play size={11} />}
      </button>
    </div>
  );
}

/**
 * The OS draws the real title bar now. This bar holds the app-owned controls
 * that used to live in the custom header: workspace switcher, timer and help.
 */
export default function TitleBar() {
  const view = useApp((state) => state.currentView);
  const allWorkspaces = useWorkspaceScopes((state) => state.allWorkspaces);
  const setAllWorkspaces = useWorkspaceScopes((state) => state.setAllWorkspaces);
  const showScope = view === 'library' || view === 'annotations';
  return (
    <header className="titlebar app-bar">
      <WorkspaceSwitcher />
      {showScope && (
        <div className="segmented scope-toggle" role="group" aria-label="Workspace scope">
          <button
            type="button"
            className={allWorkspaces ? undefined : 'active'}
            aria-pressed={!allWorkspaces}
            onClick={() => setAllWorkspaces(false)}
            title="Show only this workspace's items"
          >
            This workspace
          </button>
          <button
            type="button"
            className={allWorkspaces ? 'active' : undefined}
            aria-pressed={allWorkspaces}
            onClick={() => setAllWorkspaces(true)}
            title="Show items from all workspaces (read-only)"
          >
            All workspaces
          </button>
        </div>
      )}
      <div className="app-bar-spacer" />
      <PomodoroChip />
      <button
        type="button"
        className="tool-btn"
        onClick={() => window.dispatchEvent(new Event('annotate:show-shortcuts'))}
        title="Keyboard shortcuts (?)"
      >
        ?
      </button>
    </header>
  );
}
