// Progress Indicator
// Handles showing/hiding and updating progress indicators

/**
 * Update progress circle based on completed vs total tasks
 * @param {number} completed - Number of completed tasks
 * @param {number} total - Total number of tasks
 */
export function updateProgress(completed, total) {
  const progressCircle = document.querySelector('.progress-circle-progress');
  if (!progressCircle) return;

  // Calculate progress percentage
  const progress = completed / total;
  const circumference = 43.98; // 2 * PI * 7 (radius)

  // Calculate stroke-dashoffset (starts at full circle, decreases as progress increases)
  const offset = circumference * (1 - progress);

  progressCircle.style.strokeDashoffset = offset;
}

/**
 * Show processing indicator in TOC header
 */
export function showProcessingIndicator() {
  const indicator = document.getElementById('processing-indicator');

  if (indicator) {
    indicator.classList.remove('hidden');
  }
}

/**
 * Hide processing indicator in TOC header
 */
export function hideProcessingIndicator() {
  const indicator = document.getElementById('processing-indicator');
  if (indicator) {
    indicator.classList.add('hidden');
  }
}
