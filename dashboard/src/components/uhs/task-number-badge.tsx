'use client';

/**
 * UHS Task Number Utilities
 *
 * Extracts the numeric ID from supa_N task IDs and renders a clickable
 * #N badge. Lives in components/uhs/ — never overwritten by upstream merges.
 */

import React from 'react';

/**
 * Extract the short numeric identifier from a task ID.
 * supa_720 → "720", task_abc → null (no number badge for CortexOS-native tasks)
 */
export function getTaskNumber(id: string): string | null {
  const match = id.match(/^supa_(\d+)$/);
  return match ? match[1] : null;
}

interface TaskNumberBadgeProps {
  id: string;
  className?: string;
}

/**
 * Renders a muted monospace "#720" chip when the task has a numeric ID.
 * Renders nothing for CortexOS-native tasks.
 */
export function TaskNumberBadge({ id, className = '' }: TaskNumberBadgeProps) {
  const num = getTaskNumber(id);
  if (!num) return null;
  return (
    <span
      className={`inline-block font-mono text-[10px] font-semibold text-muted-foreground/70 bg-muted/50 rounded px-1 py-0.5 shrink-0 ${className}`}
    >
      #{num}
    </span>
  );
}
