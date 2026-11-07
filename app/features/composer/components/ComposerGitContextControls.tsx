'use client';

import './ComposerGitContextControls.css';
import { SelectPicker } from '../../ui/SelectPicker';

type WorktreeOption = {
  path: string;
  label: string;
};

type ComposerGitContextControlsProps = {
  disabled: boolean;
  branches: string[];
  worktrees: WorktreeOption[];
  selectedBranch: string;
  selectedWorktree: string;
  locked?: boolean;
  unavailable?: boolean;
  statusText?: string;
  onSelectBranch: (branchName: string) => void;
  onSelectWorktree: (worktreePath: string) => void;
};

export function ComposerGitContextControls({
  disabled,
  branches,
  worktrees,
  selectedBranch,
  selectedWorktree,
  locked = false,
  unavailable = false,
  statusText,
  onSelectBranch,
  onSelectWorktree,
}: ComposerGitContextControlsProps) {
  const branchOptions = branches.map((branchName) => ({ value: branchName, label: branchName }));
  const worktreeOptions = worktrees.map((worktree) => ({ value: worktree.path, label: worktree.label }));
  // Keep a saved selection visible even when it is no longer listed (e.g. a removed worktree).
  if (selectedBranch && !branchOptions.some((option) => option.value === selectedBranch)) {
    branchOptions.unshift({ value: selectedBranch, label: selectedBranch });
  }
  if (selectedWorktree && !worktreeOptions.some((option) => option.value === selectedWorktree)) {
    worktreeOptions.unshift({ value: selectedWorktree, label: selectedWorktree });
  }
  const placeholder = unavailable ? 'none' : undefined;

  return (
    <div className="composerGitContextControls">
      <label className="composerGitContextField">
        <span className="composerGitContextLabel">branch</span>
        <div className="composerGitContextPicker">
          <SelectPicker
            ariaLabel="Branch"
            options={branchOptions}
            value={selectedBranch}
            placeholder={placeholder}
            disabled={disabled || locked || branchOptions.length === 0}
            portal
            onChange={onSelectBranch}
          />
        </div>
      </label>
      <label className="composerGitContextField">
        <span className="composerGitContextLabel">worktree</span>
        <div className="composerGitContextPicker composerGitContextPicker-worktree">
          <SelectPicker
            ariaLabel="Worktree"
            options={worktreeOptions}
            value={selectedWorktree}
            placeholder={placeholder}
            disabled={disabled || locked || worktreeOptions.length === 0}
            portal
            onChange={onSelectWorktree}
          />
        </div>
      </label>
      {statusText ? <span className="composerGitContextStatus">{statusText}</span> : null}
    </div>
  );
}
