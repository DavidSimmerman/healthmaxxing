import { writable } from 'svelte/store';

// Whether the global "log food" capture sheet is open. The bottom nav's centre
// button opens it on the home page; the sheet itself lives in the root layout.
export const captureOpen = writable(false);
