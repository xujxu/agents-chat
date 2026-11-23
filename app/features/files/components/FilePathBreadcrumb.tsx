'use client';

import { Fragment, useEffect, useState } from 'react';
import { getAgentFilePathParts, getFileIcon } from '../fileWorkspaceHelpers';

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back below */ }
  }
  // The async clipboard API is missing on plain-http hosts.
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  Object.assign(area.style, { position: 'fixed', top: '0', left: '-10000px', opacity: '0' });
  document.body.appendChild(area);
  area.select();
  try { return document.execCommand('copy'); } catch { return false; } finally { area.remove(); }
}

export function FilePathBreadcrumb({ root, filePath }: { root: string; filePath: string }) {
  const { folders, name, fullPath } = getAgentFilePathParts(root, filePath);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (copyState === 'idle') return;
    const timer = setTimeout(() => setCopyState('idle'), 1500);
    return () => clearTimeout(timer);
  }, [copyState]);
  useEffect(() => setCopyState('idle'), [fullPath]);

  const parents = root ? [root, ...folders] : folders;
  const copyLabel = copyState === 'copied' ? 'Copied path' : copyState === 'failed' ? 'Copy failed' : 'Copy full path';
  return (
    <span className="mdEditorFilePath" title={fullPath}>
      <span className="mdPathIcon" aria-hidden="true">{getFileIcon(name)}</span>
      {parents.length ? (
        <span className="mdPathFolders">
          {parents.map((part, index) => (
            <Fragment key={`${index}:${part}`}>
              {index > 0 ? <span className="mdPathSep" aria-hidden="true"> › </span> : null}
              <span className="mdPathFolder">{part}</span>
            </Fragment>
          ))}
        </span>
      ) : null}
      {parents.length ? <span className="mdPathSep" aria-hidden="true"> › </span> : null}
      <span className="mdPathName">{name}</span>
      <button
        type="button"
        className={`mdPathCopy ${copyState}`}
        aria-label={copyLabel}
        title={copyLabel}
        onClick={() => void copyText(fullPath).then(ok => setCopyState(ok ? 'copied' : 'failed'))}
      >
        {copyState === 'copied' ? '✓' : copyState === 'failed' ? '!' : '⧉'}
      </button>
    </span>
  );
}
