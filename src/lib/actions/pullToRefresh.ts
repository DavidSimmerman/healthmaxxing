import { invalidateAll } from '$app/navigation';

// iOS-style pull-to-refresh as one reusable Svelte action: `use:pullToRefresh`
// (default = reload this page's data) or `use:pullToRefresh={{ onRefresh }}` for
// a custom refresh (e.g. /sleep pulls Fitbit first). Touch-only — it engages only
// when the page is scrolled to the very top and the drag is mostly vertical, so
// normal scrolling and horizontal carousels are untouched. The spinner element is
// created and managed by the action, so a page only needs the one directive.
//
// ponytail: a tiny self-contained gesture handler beats pulling in a PTR library
// for a single mobile PWA. Tuning knobs (threshold/resistance) live up top.

type Params = { onRefresh?: () => void | Promise<void> };

const THRESHOLD = 64; // px of pull needed to trigger
const MAX = 110; // px the spinner travels at most
const RESIST = 0.5; // drag-distance → travel damping (rubber-band feel)

function scrollTop(): number {
	return window.scrollY || document.documentElement.scrollTop || 0;
}

export function pullToRefresh(node: HTMLElement, params: Params = {}) {
	let onRefresh = params.onRefresh ?? (() => invalidateAll());

	// Spinner: a fixed ring near the top that travels down with the pull and spins
	// while refreshing. Inline-styled so it needs no Tailwind/CSS-file coupling.
	const spinner = document.createElement('div');
	spinner.setAttribute('aria-hidden', 'true');
	spinner.style.cssText = [
		'position:fixed',
		'top:calc(env(safe-area-inset-top) + 6px)',
		'left:50%',
		'z-index:50',
		'width:30px',
		'height:30px',
		'border-radius:9999px',
		'border:2px solid rgba(255,255,255,0.18)',
		'border-top-color:#fb923c',
		'background:rgba(20,20,24,0.85)',
		'box-shadow:0 4px 12px rgba(0,0,0,0.4)',
		'pointer-events:none',
		'opacity:0',
		'transform:translate(-50%,-44px)'
	].join(';');
	document.body.appendChild(spinner);

	let startY = 0;
	let startX = 0;
	let tracking = false; // touch began at top
	let pulling = false; // committed to a vertical pull (gesture is ours)
	let dist = 0;
	let refreshing = false;

	function setSpinner(travel: number, spin: boolean) {
		const t = Math.max(0, travel);
		spinner.style.transition = spin ? 'transform 0.2s ease' : 'none';
		spinner.style.opacity = String(Math.min(t / THRESHOLD, 1));
		const rot = spin ? '' : ` rotate(${t * 3}deg)`;
		spinner.style.transform = `translate(-50%, ${Math.min(t, MAX) - 6}px)${rot}`;
		spinner.style.animation = spin ? 'ptr-spin 0.7s linear infinite' : 'none';
	}

	function reset() {
		dist = 0;
		pulling = false;
		spinner.style.transition = 'transform 0.25s ease, opacity 0.25s ease';
		spinner.style.animation = 'none';
		spinner.style.opacity = '0';
		spinner.style.transform = 'translate(-50%,-44px)';
	}

	function onStart(e: TouchEvent) {
		if (refreshing || e.touches.length !== 1 || scrollTop() > 0) return;
		tracking = true;
		pulling = false;
		startY = e.touches[0].clientY;
		startX = e.touches[0].clientX;
	}

	function onMove(e: TouchEvent) {
		if (!tracking || refreshing) return;
		const dy = e.touches[0].clientY - startY;
		const dx = e.touches[0].clientX - startX;
		if (!pulling) {
			// Decide intent: a downward, mostly-vertical drag from the top is ours.
			if (dy <= 0 || Math.abs(dx) > Math.abs(dy)) {
				tracking = false; // it's a scroll-up or a sideways swipe — let the page have it
				return;
			}
			if (dy > 6) pulling = true;
			else return;
		}
		if (scrollTop() > 0) {
			tracking = false;
			reset();
			return;
		}
		// We own the gesture now: suppress native overscroll so the page doesn't move.
		if (e.cancelable) e.preventDefault();
		dist = dy * RESIST;
		setSpinner(dist, false);
	}

	async function onEnd() {
		if (!tracking || refreshing) {
			tracking = false;
			return;
		}
		tracking = false;
		if (!pulling) return;
		if (dist >= THRESHOLD) {
			refreshing = true;
			setSpinner(THRESHOLD, true); // pin + spin
			try {
				await onRefresh();
			} catch (err) {
				console.error('pull-to-refresh failed:', err);
			} finally {
				refreshing = false;
				reset();
			}
		} else {
			reset();
		}
	}

	node.addEventListener('touchstart', onStart, { passive: true });
	node.addEventListener('touchmove', onMove, { passive: false });
	node.addEventListener('touchend', onEnd, { passive: true });
	node.addEventListener('touchcancel', onEnd, { passive: true });

	return {
		update(next: Params) {
			onRefresh = next.onRefresh ?? (() => invalidateAll());
		},
		destroy() {
			node.removeEventListener('touchstart', onStart);
			node.removeEventListener('touchmove', onMove);
			node.removeEventListener('touchend', onEnd);
			node.removeEventListener('touchcancel', onEnd);
			spinner.remove();
		}
	};
}
