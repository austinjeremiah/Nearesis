export const inHours = (h: number): string => new Date(Date.now() + h * 3_600_000).toISOString();
