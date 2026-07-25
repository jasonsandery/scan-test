export function formatBytes(bytes) {
  if (!bytes || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${exponent === 0 ? value : value.toFixed(1)} ${units[exponent]}`;
}

export function formatRelativeTime(isoString) {
  if (!isoString) {
    return "never";
  }
  const then = new Date(isoString).getTime();
  if (Number.isNaN(then)) {
    return "never";
  }
  const diffMs = Date.now() - then;
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 5) {
    return "just now";
  }
  if (diffSec < 60) {
    return `${diffSec}s ago`;
  }
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) {
    return `${diffMin}m ago`;
  }
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) {
    return `${diffHour}h ago`;
  }
  const diffDay = Math.round(diffHour / 24);
  return `${diffDay}d ago`;
}

export function formatDimensions(item) {
  if (!item?.width || !item?.height) {
    return "unknown size";
  }
  return `${item.width}×${item.height}`;
}
