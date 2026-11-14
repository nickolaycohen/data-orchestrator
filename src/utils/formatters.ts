import type { CleanupCandidateAsset } from '../types/api.ts';

// Shared map of asset_id -> asset metadata used by both Media Cleanup ([C]) and Planner Mode ([M]) preview modal
export const candidateAssetMeta = new Map<string, CleanupCandidateAsset>();

export function escapeHtml(str: unknown): string {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

/**
 * Format file sizes using Apple iOS / macOS decimal SI units (base-1000),
 * matching the iPhone Photos / Storage cleanup view (e.g. 960,217,094 B -> "960.2 MB").
 */
export function formatAppleBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes < 1_000_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  return `${(bytes / 1_000_000_000_000).toFixed(2)} TB`;
}

export function formatDuration(seconds: number | string): string {
  const sec = Number(seconds);
  if (!sec || sec <= 0) return '0:00';
  const totalSec = Math.round(sec);
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const remSec = totalSec % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(remSec).padStart(2, '0')}`;
  }
  return `${mins}:${String(remSec).padStart(2, '0')}`;
}

export interface CaptureTimestampParts {
  dateLine: string;
  isoDate?: string;
  timeLine: string;
}

export function formatCaptureTimestampParts(tsStr?: string | null): CaptureTimestampParts {
  if (!tsStr || tsStr === '—') {
    return { dateLine: '—', timeLine: '' };
  }
  const parts = tsStr.trim().split(' ');
  const datePart = parts[0] || tsStr;
  const timePart = parts[1] || '';

  let readableDate = datePart;
  const m = datePart.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monIdx = parseInt(m[2], 10) - 1;
    if (months[monIdx]) {
      readableDate = `${months[monIdx]} ${parseInt(m[3], 10)}, ${m[1]}`;
    }
  }
  return {
    dateLine: readableDate,
    isoDate: datePart,
    timeLine: timePart ? `${timePart} (${datePart})` : datePart
  };
}

// Helper: Trim surrounding single or double quotes (e.g. from Finder "Copy ... as Pathname")
export function cleanPath(p?: string | null): string {
  if (!p) return '';
  let str = p.trim();
  while ((str.startsWith("'") && str.endsWith("'")) || (str.startsWith('"') && str.endsWith('"'))) {
    str = str.slice(1, -1).trim();
  }
  str = str.replace(/^['"]+|['"]+$/g, '').trim();
  return str;
}

// Attach paste and blur sanitizers to text inputs to automatically strip Finder quotes
export function attachPathSanitizer(inputEl: HTMLInputElement | null, onSanitized: (() => void) | null = null): void {
  if (!inputEl) return;

  const sanitize = () => {
    const raw = inputEl.value;
    const cleaned = cleanPath(raw);
    if (raw !== cleaned) {
      inputEl.value = cleaned;
      if (onSanitized) onSanitized();
    }
  };

  inputEl.addEventListener('paste', (e: ClipboardEvent) => {
    const pasteText = e.clipboardData?.getData('text');
    if (pasteText && (pasteText.includes("'") || pasteText.includes('"'))) {
      e.preventDefault();
      const cleaned = cleanPath(pasteText);
      const start = inputEl.selectionStart ?? 0;
      const end = inputEl.selectionEnd ?? inputEl.value.length;
      const currentVal = inputEl.value;
      inputEl.value = currentVal.substring(0, start) + cleaned + currentVal.substring(end);
      inputEl.selectionStart = inputEl.selectionEnd = start + cleaned.length;
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      inputEl.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });

  inputEl.addEventListener('input', () => {
    const val = inputEl.value.trim();
    if (
      (val.startsWith("'") && val.endsWith("'") && val.length > 1) ||
      (val.startsWith('"') && val.endsWith('"') && val.length > 1)
    ) {
      inputEl.value = cleanPath(val);
    }
  });

  inputEl.addEventListener('blur', sanitize);
}

