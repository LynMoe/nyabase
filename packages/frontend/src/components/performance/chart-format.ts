export function formatChartStamp(value: unknown, withSeconds = false): string {
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return '';
  const clock = withSeconds
    ? `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    : `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
}

export function formatChartAxis(value: unknown, dense: boolean): string {
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return '';
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return dense ? clock : `${date.getMonth() + 1}/${date.getDate()} ${clock}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
