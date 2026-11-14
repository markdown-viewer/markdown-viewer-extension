// Render Progress Indicator
// The ring next to the file name: shown while a document's async tasks
// (diagrams, charts, images) are running, advanced once per finished task.

import { ringOffsetFor } from './progress-ring';

/**
 * Update the ring from a batch of tasks.
 * @param completed - Number of completed tasks
 * @param total - Total number of tasks in this batch
 */
export function updateProgress(completed: number, total: number): void {
  const progressCircle = document.querySelector<SVGCircleElement>('.progress-circle-progress');
  if (!progressCircle) return;

  progressCircle.style.strokeDashoffset = String(ringOffsetFor(completed, total));
}

/**
 * Show the render indicator in the toolbar
 */
export function showProcessingIndicator(): void {
  const indicator = document.getElementById('processing-indicator');

  if (indicator) {
    indicator.classList.remove('hidden');
  }
}

/**
 * Hide the render indicator in the toolbar
 */
export function hideProcessingIndicator(): void {
  const indicator = document.getElementById('processing-indicator');
  if (indicator) {
    indicator.classList.add('hidden');
  }
}
