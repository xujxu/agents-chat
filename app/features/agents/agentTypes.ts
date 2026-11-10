export type AgentModel = {
  modelId: string;
  name?: string;
  description?: string;
};

export type AgentAuthMethod = {
  id: string;
  name?: string;
  description?: string;
};

export type Agent = {
  id: string;
  name: string;
  command?: string;
  args?: string[];
  cwd?: string;
  yolo?: boolean;
  env?: Record<string, string>;
  relay?: boolean;
  relayConnectionName?: string;
  relayConnectionLabel?: string;
  owner?: string;
  canModify?: boolean;
  canTalk?: boolean;
  public?: boolean;
  models?: AgentModel[];
  defaultModelId?: string;
  /** URL template with `{id}` used to link bare work item IDs in this agent's replies. */
  workItemUrl?: string;
  authMethods?: AgentAuthMethod[];
  needsAuth?: boolean;
  /** The user's default agent (set when they accept a share link); preferred for new chats. */
  isDefault?: boolean;
};
