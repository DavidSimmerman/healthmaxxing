import { writable } from 'svelte/store';
import type { ChatMessage } from '$lib/server/db/schema';

// The chat sheet is open iff this is non-null. Setting it opens the sheet with that session:
// { messages: [] } starts a fresh chat; { id, messages } resumes a saved one. `type` import
// only, so no server code is pulled into the client bundle.
export type ChatSession = { id?: string; messages: ChatMessage[] } | null;

export const chatSession = writable<ChatSession>(null);

export const openNewChat = () => chatSession.set({ messages: [] });
export const openChat = (id: string, messages: ChatMessage[]) => chatSession.set({ id, messages });
export const closeChat = () => chatSession.set(null);
