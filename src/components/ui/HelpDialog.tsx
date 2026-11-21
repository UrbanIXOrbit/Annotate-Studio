'use client';

import React, { useEffect, useState } from 'react';
import Dialog from './Dialog';
import { APP_SHORTCUTS } from '@/lib/view-shortcuts';

/** In-app help, opened from the native Help menu or the ? button. */
export default function HelpDialog() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'guide' | 'keys'>('guide');

  useEffect(() => {
    const show = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      setTab(id === 'show_shortcuts' ? 'keys' : 'guide');
      setOpen(true);
    };
    window.addEventListener('annotate:menu-help', show);
    window.addEventListener('annotate:show-shortcuts', show);
    return () => {
      window.removeEventListener('annotate:menu-help', show);
      window.removeEventListener('annotate:show-shortcuts', show);
    };
  }, []);

  return (
    <Dialog open={open} onClose={() => setOpen(false)} title="Annotate Studio Help" width={640} className="help-dialog">
      <div className="segmented" role="group" aria-label="Help sections">
        <button type="button" className={tab === 'guide' ? 'active' : undefined} onClick={() => setTab('guide')}>
          Getting started
        </button>
        <button type="button" className={tab === 'keys' ? 'active' : undefined} onClick={() => setTab('keys')}>
          Shortcuts
        </button>
      </div>

      {tab === 'guide' ? (
        <div className="help-guide">
          <h3>Your files stay where they are</h3>
          <p>Annotate Studio references PDFs, books, notes and images in place. Nothing is copied into app storage — pick files from your own folders and they remain yours, editable by other apps too.</p>
          <h3>Pick a notes folder first</h3>
          <p>In Library or Settings → Data &amp; backup, choose the folder where notes and Inbox captures live. Use <strong>Ctrl/Cmd + Alt + I</strong> anywhere to capture a thought into it.</p>
          <h3>Work on the canvas</h3>
          <p>Double-click the canvas for a note, or use the toolbar to import a PDF, record audio, or add an article. Drag a window's edge to resize, its title bar to move, and the small handles that appear on hover to connect windows. If you lose something, the toolbar's <strong>History</strong> button lists recent items and changes — click one to jump to it.</p>
          <h3>Back up your work</h3>
          <p>Settings → Data &amp; backup saves app-owned data as a <code>.anos</code> file. Check “Include external files” for a complete backup, and enable automatic daily snapshots for local safety copies. After a restore, “Find missing files” reconnects references moved to a new folder.</p>
          <h3>Need a shortcut?</h3>
          <p>Press <kbd>?</kbd> anywhere, or use Help → Keyboard Shortcuts in the menu bar. Most actions also have tooltips when you hover them.</p>
        </div>
      ) : (
        <div className="shortcut-list-scroll">
          <table className="shortcut-table">
            <tbody>
              {APP_SHORTCUTS.map((shortcut) => (
                <tr key={shortcut.keys}>
                  <td><kbd>{shortcut.keys}</kbd></td>
                  <td>{shortcut.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Dialog>
  );
}
