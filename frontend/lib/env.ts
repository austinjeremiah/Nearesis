// NEXT_PUBLIC_* must be referenced literally so Next inlines them.
export const ENV = {
  API_URL: (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4040').replace(/\/$/, ''),
  DEMO_KEY: process.env.NEXT_PUBLIC_DEMO_KEY ?? '',
};
