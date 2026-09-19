export const nativeAcceptanceGates = ['onboarding', 'appearance-settings-import', 'focused-workspace-navigation', 'installer-wizard', 'integration-discard'] as const;
export type NativeAcceptanceGate = typeof nativeAcceptanceGates[number];
export type NativeAcceptanceArtifactKind = 'screenshot' | 'log';
export interface NativeAcceptanceArtifact {
  id: string; kind: NativeAcceptanceArtifactKind; path: string; sha256: string; capturedAt: string;
  provenance: { operator: string; host: string; method: 'manual-native-observation'; sourceCommit: string };
}
export interface NativeAcceptanceRecord {
  version: 1; gate: NativeAcceptanceGate; status: 'pending' | 'verified'; recordedAt: string;
  operator?: string; notes?: string; artifacts: NativeAcceptanceArtifact[];
}

const object = (value: unknown, name: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid native acceptance ${name}.`);
  return value as Record<string, unknown>;
};
const exact = (value: Record<string, unknown>, keys: string[], name: string): void => {
  if (Object.keys(value).length !== keys.length || keys.some(key => !(key in value))) throw new Error(`Invalid native acceptance ${name}.`);
};
const text = (value: unknown, max: number, name: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`Invalid native acceptance ${name}.`);
  return value;
};
const timestamp = (value: unknown, name: string): string => {
  const result = text(value, 24, name);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result) || new Date(result).toISOString() !== result) throw new Error(`Invalid native acceptance ${name}.`);
  return result;
};
const path = (value: unknown): string => {
  const result = text(value, 4096, 'artifact path');
  if (result.includes('\\') || result.startsWith('/') || result.includes(':') || result.split('/').some(segment => !segment || segment === '.' || segment === '..')) throw new Error('Invalid native acceptance artifact path.');
  return result;
};

function artifact(value: unknown): NativeAcceptanceArtifact {
  const item = object(value, 'artifact'); exact(item, ['id', 'kind', 'path', 'sha256', 'capturedAt', 'provenance'], 'artifact');
  const provenance = object(item.provenance, 'artifact provenance'); exact(provenance, ['operator', 'host', 'method', 'sourceCommit'], 'artifact provenance');
  if (item.kind !== 'screenshot' && item.kind !== 'log') throw new Error('Invalid native acceptance artifact kind.');
  if (typeof item.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(item.id)) throw new Error('Invalid native acceptance artifact id.');
  if (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('Invalid native acceptance artifact SHA-256.');
  if (provenance.method !== 'manual-native-observation' || typeof provenance.sourceCommit !== 'string' || !/^[a-f0-9]{40}$/.test(provenance.sourceCommit)) throw new Error('Invalid native acceptance artifact provenance.');
  return { id: item.id, kind: item.kind, path: path(item.path), sha256: item.sha256, capturedAt: timestamp(item.capturedAt, 'artifact timestamp'), provenance: { operator: text(provenance.operator, 160, 'artifact operator'), host: text(provenance.host, 200, 'artifact host'), method: provenance.method, sourceCommit: provenance.sourceCommit } };
}

/** Strictly parses operator-supplied evidence; it never opens an app, installer, account, or provider. */
export function parseNativeAcceptanceRecord(value: unknown): NativeAcceptanceRecord {
  const item = object(value, 'record');
  const optional = ['version', 'gate', 'status', 'recordedAt', 'artifacts', 'operator', 'notes'];
  if (Object.keys(item).some(key => !optional.includes(key)) || !['version', 'gate', 'status', 'recordedAt', 'artifacts'].every(key => key in item)) throw new Error('Invalid native acceptance record.');
  if (item.version !== 1 || !nativeAcceptanceGates.includes(item.gate as NativeAcceptanceGate) || (item.status !== 'pending' && item.status !== 'verified') || !Array.isArray(item.artifacts) || item.artifacts.length > 16) throw new Error('Invalid native acceptance record.');
  const artifacts = item.artifacts.map(artifact), ids = new Set(artifacts.map(entry => entry.id));
  if (ids.size !== artifacts.length) throw new Error('Duplicate native acceptance artifact.');
  const base = { version: 1 as const, gate: item.gate as NativeAcceptanceGate, status: item.status as NativeAcceptanceRecord['status'], recordedAt: timestamp(item.recordedAt, 'record timestamp'), artifacts };
  if (base.status === 'pending') {
    if (artifacts.length || item.operator !== undefined || item.notes !== undefined) throw new Error('Pending native acceptance gates cannot claim operator evidence.');
    return base;
  }
  if (!artifacts.length || item.operator === undefined) throw new Error('Verified native acceptance requires operator-bound artifacts.');
  const operator = text(item.operator, 160, 'record operator');
  if (artifacts.some(entry => entry.provenance.operator !== operator)) throw new Error('Verified native acceptance operator does not match artifact provenance.');
  if (artifacts.some(entry => Date.parse(entry.capturedAt) > Date.parse(base.recordedAt))) throw new Error('Verified native acceptance cannot predate an artifact.');
  return { ...base, operator, ...(item.notes === undefined ? {} : { notes: text(item.notes, 4000, 'record notes') }) };
}

export function pendingNativeAcceptanceChecklist(recordedAt = new Date().toISOString()): NativeAcceptanceRecord[] {
  const stamp = timestamp(recordedAt, 'record timestamp');
  return nativeAcceptanceGates.map(gate => ({ version: 1, gate, status: 'pending', recordedAt: stamp, artifacts: [] }));
}
