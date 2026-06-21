import { expect, test } from '@playwright/test';

// Full OIDC login round-trip against the dev Keycloak realm.
//
// Requires the `keycloak` service from compose.yaml to be running with the
// `health` realm imported (dev user david / dev-password) AND the app's
// KEYCLOAK_* env vars set. If Keycloak isn't reachable the tests skip rather
// than fail, so the suite still runs on machines without it.
const USER = process.env.KC_DEV_USER ?? 'david';
const PASS = process.env.KC_DEV_PASS ?? 'dev-password';
const ISSUER = process.env.KEYCLOAK_ISSUER ?? 'http://localhost:8080/realms/health';

async function keycloakUp(): Promise<boolean> {
	try {
		const res = await fetch(`${ISSUER}/.well-known/openid-configuration`);
		return res.ok;
	} catch {
		return false;
	}
}

test.beforeAll(async () => {
	test.skip(
		!(await keycloakUp()),
		'Keycloak dev realm not reachable — start `docker compose up keycloak`'
	);
});

test('unauthenticated visit bounces through /login to the Keycloak login screen', async ({
	page
}) => {
	await page.goto('/');
	// hooks gate -> /login -> 303 to Keycloak's hosted login form
	await expect(page).toHaveURL(/\/realms\/health\/protocol\/openid-connect\/auth/);
	await expect(page.locator('#username')).toBeVisible();
});

test('signing in at Keycloak returns to the dashboard authenticated', async ({ page }) => {
	await page.goto('/');
	await expect(page).toHaveURL(/\/realms\/health\//);

	await page.fill('#username', USER);
	await page.fill('#password', PASS);
	await page.click('#kc-login');

	// Back on the app at the post-login target, NOT looping back to /login.
	await expect(page).toHaveURL(/localhost:4173\/?(\?.*)?$/);
	await expect(page).not.toHaveURL(/\/login/);

	// The session cookie was issued.
	const cookies = await page.context().cookies();
	expect(cookies.some((c) => c.name === 'hd_session')).toBe(true);
});
