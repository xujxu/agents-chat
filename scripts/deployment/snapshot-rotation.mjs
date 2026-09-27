import { lstat, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { readSnapshotJson, realDirectory, writePrivateFile } from './snapshot-files.mjs';
import { verifySnapshot } from './snapshot.mjs';

async function exists(file) {
  try { await lstat(file); return true; }
  catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function inspectSlots(root, project) {
  const result = {};
  for (const slot of ['backup', 'staging', 'retiring']) {
    const directory = path.join(root, slot);
    if (!await exists(directory)) { result[slot] = null; continue; }
    await realDirectory(directory);
    if (slot === 'staging' && !await exists(path.join(directory, 'complete.json'))) {
      result.staging = { incomplete: true };
      continue;
    }
    const manifest = await verifySnapshot(directory);
    if (manifest.project !== project) throw new Error(`Foreign snapshot owner in ${slot}.`);
    result[slot] = manifest;
  }
  return result;
}

export async function reconcileSnapshotSlots(root, { project }) {
  const directory = await realDirectory(root);
  const canonicalProject = await realDirectory(project);
  const slots = await inspectSlots(directory, canonicalProject);
  if (slots.staging?.incomplete) {
    return { status: 'incomplete-staging', backupId: slots.backup?.id ?? null };
  }
  if (slots.backup && slots.staging && slots.retiring) {
    throw new Error('Conflicting snapshot slots; inspect before continuing.');
  }
  return {
    status: slots.retiring ? 'interrupted-rotation' : slots.staging ? 'ready' : slots.backup ? 'retained' : 'empty',
    backupId: slots.backup?.id ?? null, stagingId: slots.staging?.id ?? null,
    retiringId: slots.retiring?.id ?? null,
  };
}

export async function rotateSnapshot(root, { project }) {
  const directory = await realDirectory(root);
  const canonicalProject = await realDirectory(project);
  const slots = await inspectSlots(directory, canonicalProject);
  if (slots.staging?.incomplete) throw new Error('Incomplete staging snapshot; existing backup retained.');
  if (slots.backup && slots.staging && slots.retiring) throw new Error('Conflicting rotation slots.');
  const journalFile = path.join(directory, 'rotation.json');
  let journal;
  if (await exists(journalFile)) {
    journal = await readSnapshotJson(journalFile);
    if (journal.version !== 1 || journal.project !== canonicalProject
      || !/^[a-zA-Z0-9_-]+$/.test(journal.newId ?? '')
      || (journal.oldId !== null && !/^[a-zA-Z0-9_-]+$/.test(journal.oldId ?? ''))) {
      throw new Error('Invalid snapshot rotation journal.');
    }
  } else {
    if (!slots.staging || slots.retiring) {
      throw new Error('Snapshot rotation requires complete staging and no unjournaled retiring slot.');
    }
    if (slots.staging.id === slots.backup?.id) throw new Error('Snapshot IDs must be unique across rotation.');
    journal = { version: 1, project: canonicalProject, oldId: slots.backup?.id ?? null, newId: slots.staging.id };
    await writePrivateFile(journalFile, JSON.stringify(journal));
  }
  if (slots.staging && slots.staging.id !== journal.newId
    || slots.retiring && slots.retiring.id !== journal.oldId
    || slots.backup && ![journal.oldId, journal.newId].includes(slots.backup.id)
    || slots.backup?.id === journal.newId && slots.staging
    || slots.backup?.id === journal.oldId && slots.retiring) {
    throw new Error('Snapshot identities conflict with rotation journal.');
  }
  const backup = path.join(directory, 'backup');
  const staging = path.join(directory, 'staging');
  const retiring = path.join(directory, 'retiring');
  if (slots.backup?.id === journal.oldId) {
    if (!slots.staging) throw new Error('Replacement snapshot missing; backup retained.');
    await rename(backup, retiring);
    slots.retiring = slots.backup;
    slots.backup = null;
  }
  if (!slots.backup) {
    if (!slots.staging) throw new Error('Replacement snapshot missing; retiring snapshot retained.');
    await rename(staging, backup);
  }
  const promoted = await verifySnapshot(backup);
  if (promoted.id !== journal.newId || promoted.project !== canonicalProject) {
    throw new Error('Promoted backup integrity failure; retiring snapshot retained.');
  }
  if (slots.retiring) {
    const old = await verifySnapshot(retiring);
    if (old.id !== journal.oldId || old.project !== canonicalProject) throw new Error('Retiring backup ownership mismatch.');
    await rm(retiring, { recursive: true });
  }
  await unlink(journalFile);
  return promoted;
}
