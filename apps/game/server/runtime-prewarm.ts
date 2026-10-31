type RuntimeMode = 'edit' | 'play';

function runtimeBaseURL(mode: RuntimeMode) {
  const value = mode === 'edit'
    ? process.env.LOCAL_EDIT_SERVER_URL
    : process.env.LOCAL_GAME_SERVER_URL;
  return String(value || '').replace(/\/$/, '');
}

/**
 * Ask the local runtime manager to start preparing projects in the background.
 * The manager responds as soon as startup is scheduled; imports and project
 * creation therefore do not wait for engine prebake to finish.
 */
export async function prewarmLocalRuntimes(
  projectIds: string[],
  modes: RuntimeMode[],
) {
  const requests = projectIds.flatMap((projectId) => modes.map(async (mode) => {
    const baseURL = runtimeBaseURL(mode);
    if (!baseURL) return;
    const response = await fetch(
      `${baseURL}/${encodeURIComponent(projectId)}/__local_runtime/start`,
      { method: 'POST', signal: AbortSignal.timeout(5_000) },
    );
    if (!response.ok && response.status !== 202) {
      throw new Error(`${mode} runtime prewarm failed (HTTP ${response.status})`);
    }
  }));
  return Promise.allSettled(requests);
}
