import { createPublicKey } from 'node:crypto';
import { isIP } from 'node:net';

export interface HydraInstalledUpdateTrust {
	readonly version: string;
	readonly origin: string;
	readonly keyId: string;
	readonly publicKeyPem: string;
	readonly authenticodeSigners: ReadonlyArray<Readonly<{ subject: string; thumbprint: string }>>;
}

let installedTrust: HydraInstalledUpdateTrust | null = null;
let initialized = false;

function refuse(): never { throw new Error('Installed Hydra desktop update trust is invalid.'); }
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length &&
		keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}
function stableVersion(value: unknown): value is string {
	if (typeof value !== 'string' || value.length > 32 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return false;
	return value.split('.').every(part => Number(part) <= 65535);
}

/** Pure validation; runtime arguments are used only by the fixture test. */
export function parseHydraUpdateTrust(product: unknown, platform = process.platform, architecture = process.arch): HydraInstalledUpdateTrust | null {
	if (!product || typeof product !== 'object') refuse();
	const record = product as Record<string, unknown>;
	if (record.nameShort !== 'Hydra' || record.applicationName !== 'hydra' ||
		record.win32AppUserModelId !== 'Hydra.IDE' || !stableVersion(record.hydraVersion) ||
		Object.prototype.hasOwnProperty.call(record, 'updateUrl')) refuse();
	const value = record.hydraUpdateTrust;
	const base = ['schemaVersion', 'status', 'product', 'channel', 'target'];
	if (!exact(value, value && typeof value === 'object' && (value as Record<string, unknown>).status === 'disabled'
		? base : [...base, 'origin', 'keyId', 'publicKeyPem', 'authenticodeSigners'])) refuse();
	if (value.schemaVersion !== 1 || value.product !== 'Hydra' || value.channel !== 'stable' ||
		!exact(value.target, ['platform', 'architecture', 'installTarget']) ||
		value.target.platform !== 'win32' || value.target.architecture !== 'x64' || value.target.installTarget !== 'user') refuse();
	if (value.status === 'disabled') return null;
	if (value.status !== 'enabled' || platform !== 'win32' || architecture !== 'x64') refuse();
	if (typeof value.origin !== 'string' || value.origin.length > 255) refuse();
	let origin: URL;
	try { origin = new URL(value.origin); } catch { return refuse(); }
	if (origin.protocol !== 'https:' || origin.origin !== value.origin || origin.username || origin.password ||
		origin.pathname !== '/' || origin.search || origin.hash || isIP(origin.hostname) ||
		!origin.hostname.includes('.') || origin.hostname.endsWith('.localhost')) refuse();
	if (typeof value.keyId !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(value.keyId) ||
		typeof value.publicKeyPem !== 'string' || value.publicKeyPem.length > 4096) refuse();
	try {
		const key = createPublicKey(value.publicKeyPem);
		if (key.asymmetricKeyType !== 'ed25519' || key.export({ type: 'spki', format: 'pem' }) !== value.publicKeyPem) refuse();
	} catch { refuse(); }
	if (!Array.isArray(value.authenticodeSigners) || value.authenticodeSigners.length < 1 || value.authenticodeSigners.length > 3 ||
		value.authenticodeSigners.some(signer => !exact(signer, ['subject', 'thumbprint']) ||
			typeof signer.subject !== 'string' || signer.subject.length < 3 || signer.subject.length > 512 ||
			signer.subject.trim() !== signer.subject || /[\x00-\x1f]/.test(signer.subject) ||
			typeof signer.thumbprint !== 'string' || !/^[A-F0-9]{40}$/.test(signer.thumbprint)) ||
		new Set(value.authenticodeSigners.map(signer => signer.thumbprint)).size !== value.authenticodeSigners.length) refuse();
	return Object.freeze({
		version: record.hydraVersion as string, origin: value.origin, keyId: value.keyId,
		publicKeyPem: value.publicKeyPem,
		authenticodeSigners: Object.freeze(value.authenticodeSigners.map(signer => Object.freeze({
			subject: signer.subject as string, thumbprint: signer.thumbprint as string
		})))
	});
}

/** Called only by Electron main with its installed product record. No renderer input. */
export function initializeHydraUpdateTrust(product: unknown): void {
	if (initialized) refuse();
	installedTrust = parseHydraUpdateTrust(product);
	initialized = true;
}

/** Main-process only. A disabled channel returns null. */
export function getHydraUpdateTrust(): HydraInstalledUpdateTrust | null {
	if (!initialized) refuse();
	return installedTrust;
}
