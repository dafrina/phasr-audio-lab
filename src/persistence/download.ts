/** Trigger a browser download of a blob the user asked to export. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // give the browser time to start reading the blob before revoking it
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Make a project name safe to use as a file name on any OS. */
export function safeFileName(name: string): string {
  const s = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim();
  return (s || 'project').slice(0, 80);
}
