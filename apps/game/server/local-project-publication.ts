export async function flushActiveEditor(projectId: string) {
  const port =
    process.env.BOX_EDIT_RUNTIME_PORT ||
    process.env.BOX_EDIT_SERVER_PORT ||
    '9967';
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/${encodeURIComponent(projectId)}/internal/save-local-project`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(120_000),
      },
    );
    if (!response.ok) {
      const body = await response.text();
      let message = body;
      try {
        message = JSON.parse(body)?.message || body;
      } catch { /* response was not JSON */ }
      throw new Error(message || `编辑器保存失败（HTTP ${response.status}）`);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException & { cause?: { code?: string } })
      .cause?.code || (error as NodeJS.ErrnoException).code;
    // No edit runtime is normal when a project is published without currently
    // being open. In that case the on-disk project is already authoritative.
    if (code === 'ECONNREFUSED') return;
    throw error;
  }
}

