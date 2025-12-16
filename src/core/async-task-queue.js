// Async Task Queue
// Manages deferred async tasks for plugin content rendering

import { createPlaceholderElement } from '../plugins/plugin-content-utils.js';

/**
 * Creates an async task queue manager.
 * @param {Function} escapeHtml - HTML escape function
 * @returns {Object} Async task queue manager instance
 */
export function createAsyncTaskQueue(escapeHtml) {
  // Global async task queue
  const asyncTaskQueue = [];
  let asyncTaskIdCounter = 0;

  /**
   * Generate unique ID for async tasks
   */
  function generateAsyncId() {
    return `async-placeholder-${++asyncTaskIdCounter}`;
  }

  /**
   * Register async task for later execution with status management
   * @param {Function} callback - The async callback function
   * @param {Object} data - Data to pass to callback
   * @param {Object} plugin - Plugin instance that provides type and placeholder generation
   * @param {Function} translate - Translation function
   * @param {string} initialStatus - Initial task status ('ready', 'fetching')
   * @returns {Object} - Object with task control and placeholder content
   */
  function asyncTask(callback, data = {}, plugin = null, translate = null, initialStatus = 'ready') {
    const placeholderId = generateAsyncId();
    const type = plugin?.type || 'unknown';

    // Create task object with status management
    const task = {
      id: placeholderId,
      callback,
      data: { ...data, id: placeholderId },
      type,
      status: initialStatus, // 'ready', 'fetching', 'error'
      error: null,

      // Methods for business logic to update status
      setReady: () => {
        task.status = 'ready';
      },
      setError: (error) => {
        task.status = 'error';
        task.error = error;
      }
    };

    asyncTaskQueue.push(task);

    // Generate placeholder using utility function
    const placeholderHtml = createPlaceholderElement(
      placeholderId,
      type,
      plugin?.isInline() || false,
      translate
    );

    return {
      task, // Return task object for business logic control
      placeholder: {
        type: 'html',
        value: placeholderHtml
      }
    };
  }

  /**
   * Process all async tasks in parallel
   * @param {Function} translate - Translation function
   * @param {Function} showProcessingIndicator - Function to show processing indicator
   * @param {Function} hideProcessingIndicator - Function to hide processing indicator
   * @param {Function} updateProgress - Function to update progress
   */
  async function processAsyncTasks(translate, showProcessingIndicator, hideProcessingIndicator, updateProgress) {
    if (asyncTaskQueue.length === 0) {
      return;
    }

    const totalTasks = asyncTaskQueue.length;
    const tasks = asyncTaskQueue.splice(0, asyncTaskQueue.length); // Take all tasks

    // Show processing indicator and set initial progress
    showProcessingIndicator();
    updateProgress(0, totalTasks);

    let completedTasks = 0;

    // Wait for all fetching tasks to be ready first
    const waitForReady = async (task) => {
      while (task.status === 'fetching') {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    };

    // Process all tasks in parallel
    const processTask = async (task) => {
      try {
        // Wait if task is still fetching
        await waitForReady(task);

        if (task.status === 'error') {
          // Handle error case - update placeholder with error message
          const placeholder = document.getElementById(task.id);
          if (placeholder) {
            const unknownError = translate('async_unknown_error');
            const errorDetail = escapeHtml((task.error ? task.error.message : '') || unknownError);
            const localizedError = translate('async_processing_error', [errorDetail]);
            placeholder.outerHTML = `<pre style="background: #fee; border-left: 4px solid #f00; padding: 10px; font-size: 12px;">${localizedError}</pre>`;
          }
        } else {
          // Process ready task normally
          await task.callback(task.data);
        }
      } catch (error) {
        console.error('Async task processing error:', error);
        // Update placeholder with error message
        const placeholder = document.getElementById(task.id);
        if (placeholder) {
          const errorDetail = escapeHtml(error.message || '');
          const localizedError = translate('async_task_processing_error', [errorDetail]);
          placeholder.outerHTML = `<pre style="background: #fee; border-left: 4px solid #f00; padding: 10px; font-size: 12px;">${localizedError}</pre>`;
        }
      } finally {
        completedTasks++;
        updateProgress(completedTasks, totalTasks);
      }
    };

    // Run all tasks in parallel
    await Promise.all(tasks.map(processTask));

    // Hide processing indicator when all tasks are done
    hideProcessingIndicator();
  }

  /**
   * Get current queue length
   * @returns {number} Number of tasks in queue
   */
  function getQueueLength() {
    return asyncTaskQueue.length;
  }

  return {
    asyncTask,
    processAsyncTasks,
    getQueueLength
  };
}
