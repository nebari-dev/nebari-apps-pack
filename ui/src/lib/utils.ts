import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Copy text to the clipboard. `navigator.clipboard` only exists in secure
 * contexts (HTTPS / localhost); on plain-HTTP deployments (e.g. local dev
 * with tls.enabled=false) fall back to the legacy hidden-textarea approach.
 * Rejects when neither path succeeds.
 */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    if (!document.execCommand('copy')) throw new Error('copy command rejected');
  } finally {
    ta.remove();
  }
}
