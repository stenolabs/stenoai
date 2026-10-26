const { shouldReserveObsidianForkNotification } = require('./notification-copy');

/**
 * Schedule the main-owned preservation toast before the reprocess completion
 * event crosses into the renderer. A summarized fork is only reserved after
 * its toast is scheduled, so the generic note-ready path cannot supersede an
 * unfinished notification lifecycle. Transcript-only forks stay renderer-owned
 * because their actionable Summarise prompt has priority in the background.
 */
async function reserveReprocessObsidianForkNotification({
  obsidianFork,
  summaryFile,
  summarizationCompleted,
  showObsidianForkNotification,
  onNotificationError = () => {},
}) {
  const forkReserved = shouldReserveObsidianForkNotification(
    obsidianFork,
    summarizationCompleted,
  );

  if (!forkReserved) {
    return {
      forkReserved: false,
      mainObsidianForkNotificationShown: false,
      obsidianSync: obsidianFork,
    };
  }

  try {
    const notification = await showObsidianForkNotification({
      ...obsidianFork,
      summaryFile,
    });
    if (notification?.shown) {
      return {
        forkReserved: true,
        // This durable result is sent with processing-complete. It must not be
        // inferred later from the lifetime of Electron's toast window.
        mainObsidianForkNotificationShown: true,
        obsidianSync: undefined,
      };
    }
  } catch (error) {
    onNotificationError(error);
  }

  return {
    forkReserved: false,
    mainObsidianForkNotificationShown: false,
    obsidianSync: obsidianFork,
  };
}

module.exports = { reserveReprocessObsidianForkNotification };
