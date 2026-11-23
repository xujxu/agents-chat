'use client';

import { Fragment } from 'react';
import { getAgentFilePathParts, getFileIcon, type AgentHostLabel } from '../fileWorkspaceHelpers';
import { CopyPathButton } from './CopyPathButton';

export function FilePathBreadcrumb({ host, root, filePath }: { host?: AgentHostLabel | null; root: string; filePath: string }) {
  const { folders, name, fullPath } = getAgentFilePathParts(root, filePath);
  const parents = root ? [root, ...folders] : folders;
  return (
    <span className="mdEditorFilePath" title={host ? `${host.name}: ${fullPath}` : fullPath}>
      {host ? (
        <>
          <span className="mdPathHost" title={host.title}><span aria-hidden="true">{host.icon} </span>{host.name}</span>
          <span className="mdPathSep" aria-hidden="true"> › </span>
        </>
      ) : null}
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
      <CopyPathButton path={fullPath} />
    </span>
  );
}
