/** Formats elapsed milliseconds for a task display. */
export function formatDuration(milliseconds: number | null): string {
  if (milliseconds === null || !Number.isFinite(milliseconds)) {
    return "Unavailable";
  }

  const totalSeconds = Math.floor(Math.max(0, milliseconds) / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalSeconds < 3600) {
    return `${totalMinutes}m ${seconds}s`;
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m ${seconds}s`;
}
