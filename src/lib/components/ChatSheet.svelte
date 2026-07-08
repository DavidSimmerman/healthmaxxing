<script lang="ts">
	import { tick } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { downscaleToDataUrl } from '$lib/image';
	import { chatSession, closeChat, openNewChat } from '$lib/stores/chat';
	import type { ChatMessage } from '$lib/server/db/schema';

	type Proposal = {
		kind: 'track' | 'recipe' | 'schedule';
		name: string;
		summary: string;
		calories: number;
		proteinG: number;
		carbsG: number;
		fatG: number;
		nutrients?: Record<string, number>;
		payload: unknown;
	};
	type Result = {
		macros: { calories: number; proteinG: number; carbsG: number; fatG: number };
		bolusableCarbsG: number;
		scheduled?: boolean;
		perServing?: boolean;
		makesServings?: number | null;
	};
	type Item =
		| { type: 'user'; text: string; images?: string[]; imageCount?: number }
		| { type: 'assistant'; text: string }
		| {
				type: 'action';
				proposal: Proposal;
				status: 'pending' | 'confirming' | 'done' | 'cancelled' | 'error';
				result?: Result;
				error?: string;
		  };

	let messages = $state<Item[]>([]);
	let chatId = $state<string | null>(null);
	let input = $state('');
	let attachments = $state<string[]>([]); // data URLs (live session only; never persisted)
	let streaming = $state(false);
	let sessionId = $state<string | null>(null); // Claude session (ephemeral; not resumed across opens)
	let errorLine = $state<string | null>(null);
	let curAssistant = $state(-1);
	let ac: AbortController | null = null;
	let scroller = $state<HTMLElement | undefined>(undefined);

	const canSend = $derived(!streaming && (input.trim().length > 0 || attachments.length > 0));

	// Open / load a session when the store is set. A fresh object reference each time means
	// "New chat" and "open saved chat" both re-run this.
	let loadedRef: unknown = null;
	$effect(() => {
		const s = $chatSession;
		if (s && s !== loadedRef) {
			loadedRef = s;
			loadSession(s.messages ?? [], s.id ?? null);
		} else if (!s) {
			loadedRef = null;
		}
	});

	function loadSession(persisted: ChatMessage[], id: string | null) {
		stop();
		chatId = id;
		sessionId = null; // resumed chats show history but start a fresh model context
		errorLine = null;
		curAssistant = -1;
		input = '';
		attachments = [];
		messages = persisted.map(fromPersist);
		scrollToEnd();
	}

	// ── persistence conversions (image DATA is dropped; only a count is kept) ──
	function fromPersist(m: ChatMessage): Item {
		if (m.role === 'user') return { type: 'user', text: m.text, imageCount: m.imageCount };
		if (m.role === 'assistant') return { type: 'assistant', text: m.text };
		return {
			type: 'action',
			proposal: {
				kind: m.kind,
				name: m.name,
				summary: m.summary ?? '',
				calories: m.macros.calories,
				proteinG: m.macros.proteinG,
				carbsG: m.macros.carbsG,
				fatG: m.macros.fatG,
				payload: null
			},
			status: m.status,
			result: m.status === 'done' ? { macros: m.macros, bolusableCarbsG: 0, scheduled: m.scheduled } : undefined
		};
	}

	function toPersist(items: Item[]): ChatMessage[] {
		const out: ChatMessage[] = [];
		for (const m of items) {
			if (m.type === 'user') {
				const n = m.images?.length ?? m.imageCount ?? 0;
				out.push({ role: 'user', text: m.text, ...(n ? { imageCount: n } : {}) });
			} else if (m.type === 'assistant') {
				if (m.text.trim()) out.push({ role: 'assistant', text: m.text });
			} else if (m.type === 'action' && (m.status === 'done' || m.status === 'cancelled')) {
				const mac = m.status === 'done' && m.result ? m.result.macros : previewMacros(m.proposal);
				out.push({
					role: 'action',
					kind: m.proposal.kind,
					name: m.proposal.name,
					...(m.proposal.summary ? { summary: m.proposal.summary } : {}),
					macros: mac,
					status: m.status,
					...(m.result?.scheduled ? { scheduled: true } : {})
				});
			}
		}
		return out;
	}

	async function save() {
		const persist = toPersist(messages);
		if (persist.length === 0) return; // nothing worth saving yet
		try {
			const res = await fetch('/api/chats', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ id: chatId, messages: persist })
			});
			if (res.ok) chatId = (await res.json()).id ?? chatId;
		} catch {
			/* best-effort; a failed save shouldn't break the chat */
		}
	}

	async function scrollToEnd() {
		await tick();
		scroller?.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
	}

	async function onPick(e: Event) {
		const files = (e.currentTarget as HTMLInputElement).files;
		if (!files) return;
		for (const f of Array.from(files)) {
			if (!f.type.startsWith('image/')) continue;
			try {
				attachments.push(await downscaleToDataUrl(f));
			} catch {
				errorLine = 'Could not read that image.';
			}
		}
		(e.currentTarget as HTMLInputElement).value = '';
	}

	function appendDelta(text: string) {
		if (curAssistant < 0 || messages[curAssistant]?.type !== 'assistant') {
			messages.push({ type: 'assistant', text: '' });
			curAssistant = messages.length - 1;
		}
		const m = messages[curAssistant];
		if (m.type === 'assistant') m.text += text;
	}

	function handleEvent(raw: string) {
		let event = 'message';
		let data = '';
		for (const line of raw.split('\n')) {
			if (line.startsWith('event:')) event = line.slice(6).trim();
			else if (line.startsWith('data:')) data += line.slice(5).trim();
		}
		if (!data) return;
		let payload: any;
		try {
			payload = JSON.parse(data);
		} catch {
			return;
		}
		if (event === 'session') sessionId = payload.sessionId ?? sessionId;
		else if (event === 'delta') appendDelta(payload.text ?? '');
		else if (event === 'action') {
			messages.push({ type: 'action', proposal: payload as Proposal, status: 'pending' });
			curAssistant = -1;
			scrollToEnd();
		} else if (event === 'error') errorLine = payload.message ?? 'chat error';
	}

	async function send() {
		if (!canSend) return;
		errorLine = null;
		const text = input.trim();
		const imgs = attachments.slice();
		messages.push({ type: 'user', text, images: imgs.length ? imgs : undefined });
		input = '';
		attachments = [];
		curAssistant = -1;
		streaming = true;
		scrollToEnd();

		ac = new AbortController();
		try {
			const res = await fetch('/api/chat', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ message: text, images: imgs.map((d) => ({ data: d })), sessionId }),
				signal: ac.signal
			});
			if (!res.ok || !res.body) throw new Error((await res.text()) || `HTTP ${res.status}`);

			const reader = res.body.getReader();
			const dec = new TextDecoder();
			let buf = '';
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buf += dec.decode(value, { stream: true });
				let idx: number;
				while ((idx = buf.indexOf('\n\n')) !== -1) {
					handleEvent(buf.slice(0, idx));
					buf = buf.slice(idx + 2);
					scrollToEnd();
				}
			}
		} catch (e) {
			if ((e as Error).name !== 'AbortError') errorLine = (e as Error).message || 'chat failed';
		} finally {
			streaming = false;
			ac = null;
			scrollToEnd();
			save(); // persist the turn (best-effort)
		}
	}

	async function confirm(item: Item) {
		if (item.type !== 'action' || item.status !== 'pending') return;
		item.status = 'confirming';
		try {
			const res = await fetch('/api/chat/confirm', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ kind: item.proposal.kind, proposal: item.proposal })
			});
			if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
			item.result = (await res.json()) as Result;
			item.status = 'done';
			if (item.proposal.kind !== 'recipe') await invalidateAll();
			save();
		} catch (e) {
			item.status = 'error';
			item.error = (e as Error).message || 'failed';
		}
	}

	function cancel(item: Item) {
		if (item.type === 'action' && item.status === 'pending') {
			item.status = 'cancelled';
			save();
		}
	}

	function stop() {
		ac?.abort();
	}

	async function newChat() {
		await save();
		await invalidateAll(); // surface the saved chat in the Assistant list
		openNewChat();
	}

	async function close() {
		stop();
		await save();
		await invalidateAll();
		closeChat();
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			send();
		}
	}

	const KIND_LABEL = { track: 'Track now', recipe: 'Save recipe', schedule: 'Schedule' } as const;
	const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

	function schedTime(pr: Proposal): string {
		const at = (pr.payload as { scheduleAt?: string })?.scheduleAt;
		if (!at) return 'no time set';
		const d = new Date(at);
		return Number.isNaN(d.getTime())
			? 'invalid time'
			: `Today at ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
	}

	function previewMacros(pr: Proposal) {
		if (pr.kind === 'recipe') {
			const pl = pr.payload as { ingredients?: unknown[]; makesServings?: number };
			const ings = Array.isArray(pl?.ingredients) ? (pl.ingredients as Record<string, number>[]) : [];
			const ms = typeof pl?.makesServings === 'number' && pl.makesServings > 0 ? pl.makesServings : 1;
			const sum = (k: string) => ings.reduce((t, i) => t + (Number(i?.[k]) || 0), 0);
			return {
				calories: sum('calories') / ms,
				proteinG: sum('proteinG') / ms,
				carbsG: sum('carbsG') / ms,
				fatG: sum('fatG') / ms
			};
		}
		return { calories: pr.calories, proteinG: pr.proteinG, carbsG: pr.carbsG, fatG: pr.fatG };
	}
</script>

{#if $chatSession}
	<div class="fixed inset-0 z-50 flex flex-col" style="background: var(--color-bg, #0a0a0c);">
		<!-- Header -->
		<header
			class="flex items-center gap-3 border-b px-4 py-3"
			style="border-color: var(--color-border); padding-top: calc(0.75rem + env(safe-area-inset-top));"
		>
			<span class="text-lg">✨</span>
			<h2 class="text-base font-bold text-white">Assistant</h2>
			<button class="ml-auto text-xs" style="color: var(--color-text-subtle);" onclick={newChat}>New chat</button>
			<button class="text-sm text-white/70" aria-label="Close chat" onclick={close}>✕</button>
		</header>

		<!-- Messages -->
		<div bind:this={scroller} class="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
			{#if messages.length === 0}
				<div class="mt-10 text-center text-sm" style="color: var(--color-text-subtle);">
					<p class="mb-2 text-2xl">🥗</p>
					Ask about your macros, plan a meal, or send photos of labels to build a recipe.
					<br />I'll ask before I log anything.
				</div>
			{/if}

			{#each messages as m, i (i)}
				{#if m.type === 'user'}
					<div class="flex justify-end">
						<div class="max-w-[85%] rounded-2xl rounded-br-sm px-3.5 py-2 text-sm text-white" style="background: var(--color-accent, #6366f1);">
							{#if m.images?.length}
								<div class="mb-1.5 flex flex-wrap gap-1.5">
									{#each m.images as src (src)}
										<img {src} alt="attachment" class="h-16 w-16 rounded-lg object-cover" />
									{/each}
								</div>
							{:else if m.imageCount}
								<div class="mb-1.5 text-xs text-white/80">📷 {m.imageCount} photo{m.imageCount > 1 ? 's' : ''}</div>
							{/if}
							{#if m.text}<p class="whitespace-pre-wrap">{m.text}</p>{/if}
						</div>
					</div>
				{:else if m.type === 'assistant'}
					<div class="flex justify-start">
						<div class="max-w-[85%] rounded-2xl rounded-bl-sm bg-white/5 px-3.5 py-2 text-sm whitespace-pre-wrap text-white/90">
							{m.text}{#if streaming && i === curAssistant}<span class="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-white/60 align-middle"></span>{/if}
						</div>
					</div>
				{:else if m.type === 'action'}
					{@const mac = m.status === 'done' && m.result ? m.result.macros : previewMacros(m.proposal)}
					<div class="mx-auto max-w-[95%] rounded-2xl border p-4" style="border-color: var(--color-border); background: rgba(255,255,255,0.04);">
						<div class="flex items-center justify-between">
							<span class="text-[10px] font-semibold tracking-wide uppercase" style="color: var(--color-accent-to, #fb923c);">{KIND_LABEL[m.proposal.kind]}</span>
							{#if m.status === 'done'}<span class="text-[10px] text-emerald-400">✓ {m.result?.scheduled ? 'Scheduled' : m.proposal.kind === 'recipe' ? 'Saved' : 'Logged'}</span>{/if}
							{#if m.status === 'cancelled'}<span class="text-[10px] text-white/40">Dismissed</span>{/if}
						</div>
						<p class="mt-1 font-semibold text-white">{m.proposal.name}</p>
						{#if m.proposal.summary}<p class="text-xs" style="color: var(--color-text-subtle);">{m.proposal.summary}</p>{/if}
						{#if m.proposal.kind === 'schedule' && m.status === 'pending'}
							<p class="mt-1 text-xs font-medium" style="color: var(--color-accent-to, #fb923c);">⏰ {schedTime(m.proposal)}</p>
						{/if}

						<div class="mt-3 grid grid-cols-4 gap-2 text-center">
							{#each [['kcal', mac.calories], ['P', mac.proteinG], ['C', mac.carbsG], ['F', mac.fatG]] as [label, val] (label)}
								<div class="rounded-lg bg-white/5 py-1.5">
									<div class="text-sm font-bold text-white">{fmt(val as number)}</div>
									<div class="text-[10px]" style="color: var(--color-text-subtle);">{label}</div>
								</div>
							{/each}
						</div>
						{#if m.status === 'done' && m.result}
							<p class="mt-2 text-center text-[11px]" style="color: var(--color-text-subtle);">
								{m.result.perServing ? `per serving${m.result.makesServings ? ` · makes ${m.result.makesServings}` : ''}` : m.result.bolusableCarbsG ? `bolusable carbs ${fmt(m.result.bolusableCarbsG)}g` : ''}
							</p>
						{/if}

						{#if m.status === 'pending'}
							<div class="mt-3 flex gap-2">
								<button class="flex-1 rounded-xl py-2.5 text-sm font-semibold text-white/80" style="background: rgba(255,255,255,0.06);" onclick={() => cancel(m)}>Not now</button>
								<button class="flex-1 rounded-xl py-2.5 text-sm font-semibold text-white" style="background: var(--color-accent, #6366f1);" onclick={() => confirm(m)}>Confirm</button>
							</div>
						{:else if m.status === 'confirming'}
							<p class="mt-3 text-center text-xs" style="color: var(--color-text-subtle);">Saving…</p>
						{:else if m.status === 'error'}
							<p class="mt-2 text-xs" style="color: var(--color-danger, #f87171);">{m.error}</p>
							<button class="mt-2 w-full rounded-xl py-2 text-sm font-semibold text-white" style="background: var(--color-accent, #6366f1);" onclick={() => { m.status = 'pending'; }}>Try again</button>
						{/if}
					</div>
				{/if}
			{/each}

			{#if errorLine}
				<p class="text-center text-xs" style="color: var(--color-danger, #f87171);">{errorLine}</p>
			{/if}
		</div>

		<!-- Input bar -->
		<div class="border-t px-3 py-2" style="border-color: var(--color-border); padding-bottom: calc(0.5rem + env(safe-area-inset-bottom));">
			{#if attachments.length}
				<div class="mb-2 flex flex-wrap gap-1.5">
					{#each attachments as src, i (i)}
						<div class="relative">
							<img {src} alt="attachment" class="h-14 w-14 rounded-lg object-cover" />
							<button class="absolute -top-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/80 text-xs text-white" aria-label="Remove image" onclick={() => attachments.splice(i, 1)}>✕</button>
						</div>
					{/each}
				</div>
			{/if}
			<div class="flex items-end gap-2">
				<label class="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full bg-white/5 text-lg text-white active:scale-95" aria-label="Attach photo">
					📷
					<input type="file" accept="image/*" capture="environment" multiple class="hidden" onchange={onPick} />
				</label>
				<textarea bind:value={input} onkeydown={onKey} rows="1" placeholder="Message the assistant…" class="max-h-32 min-h-10 flex-1 resize-none rounded-2xl bg-white/5 px-3.5 py-2.5 text-sm text-white outline-none placeholder:text-white/30"></textarea>
				{#if streaming}
					<button class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/10 text-white active:scale-95" aria-label="Stop" onclick={stop}>■</button>
				{:else}
					<button class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-white transition active:scale-95 disabled:opacity-40" style="background: var(--color-accent, #6366f1);" aria-label="Send" disabled={!canSend} onclick={send}>↑</button>
				{/if}
			</div>
		</div>
	</div>
{/if}
