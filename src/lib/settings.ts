// ── Settings API helpers ────────────────────────────────────────

export async function loadSetting<T>(key: string): Promise<T | null> {
  try {
    const res = await window.cerebro.invoke<{ value: string }>({
      method: 'GET',
      path: `/settings/${key}`,
    });
    if (res.ok) {
      return JSON.parse(res.data.value) as T;
    }
  } catch {
    // Setting doesn't exist or parse error
  }
  return null;
}

export function saveSetting(key: string, value: unknown): Promise<void> {
  return window.cerebro
    .invoke({
      method: 'PUT',
      path: `/settings/${key}`,
      body: { value: JSON.stringify(value) },
    })
    .then(() => undefined)
    .catch((err) => { console.error(err); });
}
