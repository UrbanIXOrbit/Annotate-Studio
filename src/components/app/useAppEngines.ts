'use client';

import { useEffect } from 'react';
import { getStudyStats, isTauri, logStudyActivity } from '@/lib/tauri-commands';
import { flushAll, setSaveErrorReporter } from '@/lib/persist';
import { notify } from '@/lib/notify';
import { playChime } from '@/lib/sound';
import { isEditableTarget, isModalOpen } from '@/lib/utils';
import { VIEW_KEYS } from '@/lib/view-shortcuts';
import { migrateInlineNotes, registerExternalResources } from '@/lib/workspace-actions';
import { useSearch } from '@/store/search';
import { useApp } from '@/store/app';
import { isDue, isNewCard, useFlashcards } from '@/store/flashcards';
import { useLibrary } from '@/store/library';
import { usePomodoro, type PomodoroPhase } from '@/store/pomodoro';
import { useProviders } from '@/store/providers';
import { useSettings } from '@/store/settings';
import { useWorkspaceScopes } from '@/store/workspace-scopes';
import { useAnnotations } from '@/store/annotations';
import { useCanvas } from '@/store/canvas';
import { toast } from '@/store/toast';

const PHASE_LABEL: Record<PomodoroPhase, string> = {
  focus: 'Focus',
  shortBreak: 'Short break',
  longBreak: 'Long break',
};

let startup: Promise<void> | null = null;

function startApp(): Promise<void> {
  startup ??= (async () => {
    // One failed initialisation step must not skip all the others: surface it
    // and continue so the rest of the app still becomes usable.
    const step = async (label: string, task: () => Promise<void> | void) => {
      try {
        await task();
      } catch (error) {
        toast.error(`Could not ${label}`, error);
      }
    };
    await step('load settings', () => useSettings.getState().hydrate());
    await step('load workspace views', async () => {
      await useWorkspaceScopes.getState().hydrate();
      const id = useCanvas.getState().activeWorkspaceId;
      useAnnotations.getState().adoptBooks(useWorkspaceScopes.getState().scopes[id]?.books ?? {});
    });
    await step('load the workspace', async () => {
      await Promise.all([useCanvas.getState().hydrate(), useLibrary.getState().refresh()]);
    });
    await step('migrate inline notes', () => migrateInlineNotes());
    await step('register external resources', () => registerExternalResources());
    await step('load flashcards', () => useFlashcards.getState().hydrate());
    await step('load AI providers', async () => { await useProviders.getState().refresh(); });
    await step('sync the timer', () => usePomodoro.getState().syncDuration());
    await step('load study stats', async () => {
      const stats = await getStudyStats();
      usePomodoro.getState().seedCompletedToday(stats.today_pomodoro_sessions);
    });
  })();
  return startup;
}

export function useAppEngines() {
  useEffect(() => {
    void startApp();
  }, []);

  // Each workspace keeps its own annotation scan results.
  useEffect(() => {
    let previous = useCanvas.getState().activeWorkspaceId;
    const sync = () => {
      const id = useCanvas.getState().activeWorkspaceId;
      if (id === previous) return;
      previous = id;
      const scopes = useWorkspaceScopes.getState().scopes[id];
      useAnnotations.getState().adoptBooks(scopes?.books ?? {});
      void useLibrary.getState().reloadForWorkspace();
    };
    const unsubscribe = useCanvas.subscribe(sync);
    return unsubscribe;
  }, []);

  useEffect(() => {
    const onUnhandled = (event: PromiseRejectionEvent) => {
      event.preventDefault();
      toast.error('Something went wrong', event.reason);
    };
    window.addEventListener('unhandledrejection', onUnhandled);
    return () => window.removeEventListener('unhandledrejection', onUnhandled);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      const completion = usePomodoro.getState().tick();
      if (!completion) return;
      const sound = useSettings.getState().pomodoro.sound;
      playChime(sound);
      const finished = PHASE_LABEL[completion.phase];
      const next = PHASE_LABEL[completion.next];
      const message = completion.autoStarted ? `${next} has started.` : `Time for a ${next.toLowerCase()}.`;
      toast.info(`${finished} complete`, message);
      void notify(`${finished} complete`, message);
      if (completion.phase === 'focus') {
        void logStudyActivity('pomodoro', 'Focus session', completion.durationSeconds).catch(() => undefined);
      }
    }, 500);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let lastCheck = Date.now();
    let previousTotal = -1;
    const dueNow = (now: number) => useFlashcards.getState().cards.filter((card) => isDue(card, now)).length;
    const updateBadge = () => {
      if (!useFlashcards.getState().hydrated) return;
      useApp.getState().setDueCards(dueNow(Date.now()));
    };
    const onTimer = () => {
      const { cards, hydrated } = useFlashcards.getState();
      const now = Date.now();
      const since = lastCheck;
      lastCheck = now;
      if (!hydrated) return;
      const total = dueNow(now);
      useApp.getState().setDueCards(total);
      const becameDue = cards.some((card) => {
        if (isNewCard(card)) return false;
        const due = Date.parse(card.next_review);
        return due > since && due <= now;
      });
      const away = document.hidden || !document.hasFocus();
      if (previousTotal === 0 && becameDue && away) {
        void notify('Flashcards are due', `${total} card${total === 1 ? ' is' : 's are'} ready for review.`);
      }
      previousTotal = total;
    };
    updateBadge();
    const unsubscribe = useFlashcards.subscribe((state, previous) => {
      if (state.cards !== previous.cards || state.hydrated !== previous.hydrated) updateBadge();
      if (state.hydrated && !previous.hydrated) previousTotal = dueNow(Date.now());
    });
    const timer = setInterval(onTimer, 60_000);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === '?' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        if (isModalOpen() || isEditableTarget(event.target)) return;
        if (useApp.getState().currentView === 'books') return; // Books owns its own ? help
        event.preventDefault();
        window.dispatchEvent(new Event('annotate:show-shortcuts'));
        return;
      }
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      if (isModalOpen() || isEditableTarget(event.target)) return;
      const view = VIEW_KEYS[event.key];
      if (view) {
        event.preventDefault();
        useApp.getState().setView(view);
        return;
      }
      const key = event.key.toLowerCase();
      if (key === 'k') {
        event.preventDefault();
        useSearch.getState().show();
        return;
      }
      if (key === 'j') {
        event.preventDefault();
        const app = useApp.getState();
        if (app.currentView !== 'canvas') app.setView('canvas');
        app.setChatOpen(!app.chatOpen || app.currentView !== 'canvas');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    setSaveErrorReporter((error) => toast.error('Could not save your data', error));
    const onBeforeUnload = () => {
      void flushAll();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    let unlisten: (() => void) | undefined;
    let disposed = false;
    if (isTauri()) {
      void import('@tauri-apps/api/window').then(({ getCurrentWindow }) =>
        getCurrentWindow()
          .onCloseRequested(async (event) => {
            // Hold the window open until every queued write has settled, then
            // close explicitly — a timeout would cut off in-flight saves.
            event.preventDefault();
            await flushAll();
            const window_ = getCurrentWindow();
            await window_.destroy();
          })
          .then((fn) => {
            if (disposed) fn();
            else unlisten = fn;
          }),
      );
    }
    return () => {
      disposed = true;
      setSaveErrorReporter(null);
      window.removeEventListener('beforeunload', onBeforeUnload);
      unlisten?.();
    };
  }, []);
}
