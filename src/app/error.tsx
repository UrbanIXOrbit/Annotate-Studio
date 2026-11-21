'use client';

import React, { useEffect } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { toast } from '@/store/toast';

/** Catches render errors in the app tree so one broken view cannot blank everything. */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    toast.error('Something went wrong', error);
  }, [error]);

  return (
    <div className="cw-state cw-state-error" role="alert" style={{ height: '100vh', justifyContent: 'center' }}>
      <AlertTriangle size={28} />
      <h2>Annotate Studio hit an error</h2>
      <p>{error.message || 'An unexpected error occurred.'}</p>
      <div className="empty-actions">
        <button type="button" className="btn btn-primary" onClick={reset}>
          <RefreshCw size={14} /> Try again
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            window.location.reload();
          }}
        >
          Reload the app
        </button>
      </div>
    </div>
  );
}
