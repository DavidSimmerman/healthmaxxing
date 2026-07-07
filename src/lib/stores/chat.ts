import { writable } from 'svelte/store';

// Whether the global AI chat sheet is open. Opened from the floating chat button in the
// root layout; the sheet itself lives in the root layout alongside the capture sheet.
export const chatOpen = writable(false);
