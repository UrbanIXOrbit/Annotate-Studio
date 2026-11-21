'use client';

import React from 'react';

/** Last-resort boundary: also replaces the document shell. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body>
        <div className="cw-state cw-state-error" role="alert" style={{ height: '100vh', justifyContent: 'center' }}>
          <h2>Annotate Studio could not start</h2>
          <p>{error.message || 'An unexpected error occurred.'}</p>
          <button type="button" className="btn btn-primary" onClick={reset}>
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
