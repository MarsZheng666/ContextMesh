export const en = {
  modelCheck: 'Model relay preflight',
  checkModel: 'Check compatibility',
  checkSession: 'Conversation on this device',
  checkTarget: 'Target model',
  capacityEstimate: 'Estimated input tokens',
  capacityUpper: 'Conservative input bound',
  capacityWindow: 'Context window',
  capacityOutput: 'Reserved output',
  capacityExactNotice:
    'This is a local estimate, not the provider tokenizer. History is never truncated.',
  capacityFits: 'Fits conservative checks',
  capacityReview:
    'Estimated fit only; explicit confirmation is required when selecting this model.',
  capacityBlocked:
    'This model may not fit. Choose a larger model or reduce the task explicitly.',
  capacityConfirm:
    'Only the heuristic estimate fits this model. The provider may still refuse the request. Continue using estimates for this selected conversation, without truncating history?',
  MODEL_CAPACITY_CHANGED:
    'The conversation changed after capacity review. Check and confirm again; your draft is kept.',
  MODEL_TOOLS_UNSUPPORTED:
    'This model does not support this tool history. Choose a tool-capable model or a tool-free preset.',
  MODEL_OUTPUT_LIMIT:
    'The output limit is incompatible. Adjust the target adapter output setting before selecting it.',

  connectionTitle: 'Service connection',
  manageDevices: 'Add or revoke a device',
  pairHelp:
    'Create a one-time invitation on this owner device. Only share it with your own trusted device.',
  newDeviceName: 'New device name',
  createPairing: 'Create pairing code',
  pairCode: 'Pairing code',
  pairExpires: 'Expires at',
  pairInstructions:
    'On the new device, run pnpm cli setup and enter a reachable service URL and this code. Retry an interrupted setup with the same code.',
  listDevices: 'Show paired devices',
  revokeConfirm: 'Revoke access for this device?',
  revoked: 'Revoked',
  revoke: 'Revoke access',
  ownerPairing: 'Pairing management is available on an owner device.',
  CONNECTION_LOST:
    'Connection lost. Reconnecting; your history and draft are kept. Wait for the connection to recover before retrying.',
  OWNER_REQUIRED: 'Use an owner device to manage pairing.',
  PAIRING_INVALID:
    'The pairing code is expired or already used. Request a new code from the owner device.',

  app: 'ContextMesh',
  targetModel: 'Continue with model',
  keepModel: 'Keep the current model',
  switchingModel: 'Saving model selection…',
  providerConfirm:
    'Future messages will send the required conversation history to this provider. Continue?',
  providerNotice:
    'The next request sends the required conversation history to the selected provider.',
  MODEL_RELAY_BUSY:
    'Wait for the current model switch or handoff to finish. Your draft is kept.',
  MODEL_RELAY_UNCONFIRMED:
    'The model selection has not been confirmed saved. Keep this device open and check its connection before retrying.',
  MODEL_RELAY_UNSUPPORTED:
    'Update ContextMesh server and the same plugin on both devices before switching models.',
  MODEL_RELAY_CHANGED:
    'The conversation or model changed. Refresh and select the model again.',
  MODEL_CONTEXT_TOO_SMALL:
    'This model may not fit the conversation. Choose a larger context window; history has been kept.',
  MODEL_CAPABILITIES_UNKNOWN:
    'This model must declare text support and its context window before relay.',
  MODEL_HISTORY_UNSUPPORTED:
    'Finish pending tools and remove unsupported attachments before switching models.',
  DIRECTORY_HANDOFF_UNSUPPORTED:
    'Update the server and the same plugin on both devices to continue conversations from plain folders.',
  browseDirectory: 'Browse folders…',
  changeDirectory: 'Change folder…',
  selectDirectory: 'Select project directory',
  directoryDevice: 'Folders on',
  directoryNavigation: 'Folder navigation',
  directoryHome: 'Home',
  directoryPath: 'Folder path',
  directoryGo: 'Go',
  directoryLoading: 'Loading folders…',
  directoryEmpty: 'No subfolders in this folder.',
  directoryHidden: 'Show hidden folders',
  directoryTruncated:
    'Some folders are not shown. Enter a path to open one directly.',
  directoryNotSelected: 'No folder selected',
  useDirectory: 'Use this folder',
  DIRECTORY_BROWSE_FAILED:
    'Cannot open this folder. Choose another folder or check its permissions.',

  conversation: 'Conversation',
  chooseProject: 'Choose a project',
  projectSetupTitle: 'Set up this conversation',
  projectSetupHelp:
    'Choose the shared project for this conversation. Your message waits here until setup and takeover are complete.',
  projectSetupSource: 'Current device holding the conversation',
  projectPlaceholder: 'Select a project',
  newProject: 'Create a new project…',
  continueSetup: 'Save and continue',
  cancelSetup: 'Cancel',
  directoryHelp:
    'Choose a working folder on this device. Plain folders need no Git; Git workspaces must have the same clean commit on both devices.',
  sourceDirectoryHelp:
    'Conversation history is transferred; folder contents are not copied. Tools continue in the selected folder. Existing project directories are never replaced automatically.',
  localDirectoryHelp:
    'Leave the directory empty to use this conversation’s working folder.',
  PROJECT_SOURCE_NOT_GIT:
    'Update the same plugin on the original device to support plain folders. Your draft is kept.',
  PROJECT_DIRECTORY_INVALID:
    'Select an existing folder on this device. Your draft is kept.',
  PROJECT_REQUIRED:
    'Choose a project for this conversation first. Your draft is kept.',
  PROJECT_DIRECTORY_REQUIRED:
    'Choose this device’s project directory. Your draft is kept.',
  PROJECT_DIRECTORY_CONFLICT:
    'This project already uses another directory on the original device. Choose the matching project or create a new one.',
  PROJECT_CHANGED:
    'The conversation’s project changed. Close setup, refresh and try again.',
  PROJECT_SETUP_BUSY: 'Finish or cancel the open project setup first.',
  PROJECT_SETUP_UNSUPPORTED:
    'Update the server and the same plugin on both devices to set up projects here.',

  TAKEOVER_UNSUPPORTED:
    'Update the same ContextMesh plugin on the other device before taking over. Your draft is kept.',
  takeover: 'Take over here',
  takingOver: 'Taking over…',
  takeoverConfirm: 'This session is running on:',
  takeoverEffect:
    'Take it over on this device? The other device will stop its current task. Your message will be sent only after the session arrives here.',
  TAKEOVER_FAILED:
    'Could not take over the session. Your draft is kept. Check the handoff progress and try again.',
  TAKEOVER_UNAVAILABLE:
    'Cannot confirm that the other device has stopped. Reconnect it or verify its shutdown before explicit recovery. Your draft is kept.',
  TAKEOVER_CHANGED:
    'The owning device changed. Your draft is kept; refresh and try again.',
  TAKEOVER_EXPIRED:
    'The other device did not complete takeover in time. Your draft is kept. Check handoff progress before retrying.',
  TAKEOVER_IN_PROGRESS:
    'Another device has already requested this session. Your draft is kept.',
  HANDOFF_IN_PROGRESS:
    'A handoff is already in progress. Your draft is kept; send after it completes.',

  panel: 'Remote sessions',
  device: 'This device',
  project: 'Project',
  directory: 'Project directory on this device',
  setup: 'Project setup',
  projectName: 'New project name',
  create: 'Create project',
  map: 'Save directory',
  refresh: 'Refresh',
  prepare:
    'Plain folders need no Git. For Git workspaces, prepare the same clean commit on both devices before handoff.',
  loading: 'Loading sessions…',
  empty: 'No shared sessions yet. Map a project and open a conversation in it.',
  handoff: 'Hand off',
  target: 'Target device',
  choose: 'Choose a device',
  local: 'Local',
  remote: 'Remote',
  offline: 'Offline',
  open: 'Open conversation',
  history: 'View history',
  resume: 'Resume here',
  cancel: 'Cancel handoff',
  busy: 'Working…',
  unmapped: 'No local directory mapping',
  error: 'Operation failed',
  progress: 'Handoff progress',
  close: 'Close',
  older: 'Load earlier events',
  readonly: 'Read-only history',
  noHistory: 'No messages in this page of events.',
  unknown: 'Unassigned project',
  requested: 'Checking target',
  preparing: 'Preparing source',
  ready: 'Waiting for target',
  activating: 'Restoring target',
  completed: 'Handoff complete',
  cancelled: 'Cancelled',
  failed: 'Failed',
  recovery_required: 'Recovery required',
  recover:
    'Confirm previous execution has stopped, then use the CLI recovery command.',
  mappingSaved: 'Directory saved',
  projectCreated: 'Project created',
  handoffStarted: 'Handoff requested',
  roleUser: 'You',
  roleAssistant: 'Assistant',
  roleTool: 'Tool',
  historyRange: 'Event range',
  WORKSPACE_DIRTY:
    'Commit your changes and prepare the same commit on the target.',
  SESSION_DIRECTORY_UNMAPPED:
    'The session directory is outside the owning device’s configured project. Resume it there or check its project directory. Your draft is kept.',
  WORKSPACE_MISMATCH:
    'Check the project mapping and folder on both devices. Git workspaces also need the same clean commit.',
  PENDING_INPUT: 'Finish or explicitly remove pending messages before handoff.',
  UNSUPPORTED_RESOURCE:
    'Finish jobs, close terminals and remove unsupported attachments or schedules.',
  POLICY_MISMATCH:
    'The target device needs an explicitly approved compatible file policy.',
  NOT_LOCAL_WRITER:
    'Start the handoff on the device that currently owns this session.',
  NODE_UNAVAILABLE: 'The target device is offline or its process has changed.',
  SESSION_FROZEN:
    'This session is frozen while handoff or recovery is in progress.',
} as const
export type Key = keyof typeof en
export const zh: Record<Key, string> = {
  modelCheck: '模型接力预检',
  checkModel: '检查兼容性',
  checkSession: '当前设备上的会话',
  checkTarget: '目标模型',
  capacityEstimate: '估算输入 Token',
  capacityUpper: '保守输入上界',
  capacityWindow: '上下文窗口',
  capacityOutput: '预留输出',
  capacityExactNotice:
    '这是本地估算，不等同于提供方的 tokenizer；不会自动截断历史。',
  capacityFits: '通过保守检查',
  capacityReview: '仅估算可容纳；切换时需要明确确认。',
  capacityBlocked: '目标可能无法容纳，请选择更大窗口模型或明确缩减任务。',
  capacityConfirm:
    '当前只有启发式估算能够容纳，提供方仍可能拒绝请求。是否为这次会话的模型选择使用估算模式？不会截断历史。',
  MODEL_CAPACITY_CHANGED:
    '容量确认后会话已变化，请重新检查并确认，草稿已保留。',
  MODEL_TOOLS_UNSUPPORTED:
    '目标模型不支持此工具历史，请选择支持工具的模型或无工具预设。',
  MODEL_OUTPUT_LIMIT: '输出上限不兼容，请先调整目标适配器的输出配置。',

  connectionTitle: '服务连接',
  manageDevices: '添加或撤销设备',
  pairHelp: '在这台管理设备上创建一次性邀请，只分享给你信任的自有设备。',
  newDeviceName: '新设备名称',
  createPairing: '生成配对码',
  pairCode: '配对码',
  pairExpires: '失效时间',
  pairInstructions:
    '在新设备运行 pnpm cli setup，输入新设备能访问的服务地址和此配对码。设置中断时，使用相同配对码重试。',
  listDevices: '查看已配对设备',
  revokeConfirm: '确定撤销这台设备的访问权限？',
  revoked: '已撤销',
  revoke: '撤销访问',
  ownerPairing: '请在管理设备上操作设备配对。',
  CONNECTION_LOST:
    '连接已中断，正在重新连接。历史和草稿已保留，请在恢复连接后重试。',
  OWNER_REQUIRED: '请使用管理设备操作配对。',
  PAIRING_INVALID: '配对码已失效或已被使用，请向管理设备申请新码。',

  app: 'ContextMesh',
  targetModel: '继续使用的模型',
  keepModel: '沿用当前模型',
  switchingModel: '正在保存模型选择…',
  providerConfirm: '后续消息会将所需会话历史发送给此提供方，是否继续？',
  providerNotice: '下一次请求会将所需会话历史发送给选定的模型提供方。',
  MODEL_RELAY_BUSY: '请等待当前模型切换或交接完成，草稿已保留。',
  MODEL_RELAY_UNCONFIRMED:
    '尚未确认模型选择已保存，请保持本设备运行并检查连接后重试。',
  MODEL_RELAY_UNSUPPORTED:
    '请更新 ContextMesh 服务端及两端的同一个插件后再切换模型。',
  MODEL_RELAY_CHANGED: '会话或模型已变化，请刷新后重新选择。',
  MODEL_CONTEXT_TOO_SMALL:
    '当前模型的上下文窗口可能不足，请选择更大窗口的模型，历史已保留。',
  MODEL_CAPABILITIES_UNKNOWN: '模型需声明文本支持及上下文窗口，才能用于接力。',
  MODEL_HISTORY_UNSUPPORTED:
    '请先完成待处理工具，并移除不支持的附件后再切换模型。',
  DIRECTORY_HANDOFF_UNSUPPORTED:
    '请更新服务端和两端的同一个插件，以接管普通目录中的会话。',
  browseDirectory: '浏览选择目录…',
  changeDirectory: '更换目录…',
  selectDirectory: '选择项目目录',
  directoryDevice: '正在浏览的设备',
  directoryNavigation: '目录导航',
  directoryHome: '主目录',
  directoryPath: '目录路径',
  directoryGo: '前往',
  directoryLoading: '正在加载文件夹…',
  directoryEmpty: '此目录下没有子文件夹。',
  directoryHidden: '显示隐藏目录',
  directoryTruncated: '部分目录未显示，可输入路径直接打开。',
  directoryNotSelected: '尚未选择目录',
  useDirectory: '使用此目录',
  DIRECTORY_BROWSE_FAILED: '无法打开这个目录，请选择其他目录或检查访问权限。',

  conversation: '当前会话',
  chooseProject: '选择项目',
  projectSetupTitle: '配置这条会话的项目',
  projectSetupHelp:
    '选择这条会话所属的共享项目。完成配置和接管之前，消息会保留，不会发送。',
  projectSetupSource: '当前持有会话的设备',
  projectPlaceholder: '请选择项目',
  newProject: '新建项目…',
  continueSetup: '保存并继续',
  cancelSetup: '取消',
  directoryHelp:
    '选择当前设备上继续会话的工作目录。普通目录无需 Git；Git 工作区仍需两端提交一致且没有未提交修改。',
  sourceDirectoryHelp:
    '只接续会话历史，不复制目录中的文件。工具会在所选目录中继续运行；已有项目目录不会被自动替换。',
  localDirectoryHelp: '目录可留空，使用这条会话当前的工作目录。',
  PROJECT_SOURCE_NOT_GIT:
    '请更新原设备上的同一个插件，以支持普通目录接管。草稿已保留。',
  PROJECT_DIRECTORY_INVALID: '请选择当前设备上已存在的文件夹。草稿已保留。',
  PROJECT_REQUIRED: '请先选择这条会话所属的项目。草稿已保留。',
  PROJECT_DIRECTORY_REQUIRED: '请选择当前设备上的项目目录。草稿已保留。',
  PROJECT_DIRECTORY_CONFLICT:
    '该项目在原设备上已对应另一个目录，请选择匹配的项目或新建项目。',
  PROJECT_CHANGED: '这条会话的项目已变化，请关闭配置、刷新后重试。',
  PROJECT_SETUP_BUSY: '请先完成或取消已打开的项目配置。',
  PROJECT_SETUP_UNSUPPORTED:
    '请先更新服务端和两端的同一个插件，再在此配置项目。',

  TAKEOVER_UNSUPPORTED:
    '请先更新原设备上的同一个 ContextMesh 插件，再发起接管。草稿已保留。',
  takeover: '在此接管',
  takingOver: '正在接管…',
  takeoverConfirm: '该会话正在以下设备上运行：',
  takeoverEffect:
    '是否接管到当前设备？原设备会停止当前任务。接管完成后，才会在本机发送你的消息。',
  TAKEOVER_FAILED: '暂时无法接管。草稿已保留，请查看交接进度后重试。',
  TAKEOVER_UNAVAILABLE:
    '无法确认原设备已停止执行。请让原设备联网，或核实已关闭后显式恢复。草稿已保留。',
  TAKEOVER_CHANGED: '会话所在设备已变化。草稿已保留，请刷新后重试。',
  TAKEOVER_EXPIRED:
    '原设备未能及时完成接管。草稿已保留，请查看交接进度后重试。',
  TAKEOVER_IN_PROGRESS: '另一台设备已请求接管此会话。草稿已保留。',
  HANDOFF_IN_PROGRESS: '会话正在交接。草稿已保留，请完成后再发送。',

  panel: '远程会话',
  device: '当前设备',
  project: '项目',
  directory: '项目在当前设备上的目录',
  setup: '项目配置',
  projectName: '新项目名称',
  create: '创建项目',
  map: '保存目录',
  refresh: '刷新',
  prepare:
    '普通目录无需 Git。Git 工作区交接前，请将两端准备到同一提交，并提交工作区内的修改。',
  loading: '正在加载会话…',
  empty: '暂无共享会话。先映射项目目录，再在该项目中打开会话。',
  handoff: '交接',
  target: '目标设备',
  choose: '选择设备',
  local: '本机',
  remote: '远程',
  offline: '离线',
  open: '打开对话',
  history: '查看历史',
  resume: '在此继续',
  cancel: '取消交接',
  busy: '处理中…',
  unmapped: '尚未配置本机目录',
  error: '操作失败',
  progress: '交接进度',
  close: '关闭',
  older: '加载更早的事件',
  readonly: '只读历史',
  noHistory: '这页事件中暂无消息。',
  unknown: '未分配项目',
  requested: '正在预检目标设备',
  preparing: '正在准备来源设备',
  ready: '等待目标领取',
  activating: '正在恢复会话',
  completed: '交接完成',
  cancelled: '已取消',
  failed: '失败',
  recovery_required: '需要恢复核验',
  recover: '请先确认旧执行已停止，再使用 CLI 的恢复命令处理。',
  mappingSaved: '目录已保存',
  projectCreated: '项目已创建',
  handoffStarted: '已发起交接',
  roleUser: '你',
  roleAssistant: '助手',
  roleTool: '工具',
  historyRange: '事件范围',
  WORKSPACE_DIRTY: '请先提交修改，并让目标设备取得同一个 Git 提交。',
  SESSION_DIRECTORY_UNMAPPED:
    '会话的工作目录不在原设备已配置的项目中。请在原设备恢复会话，或核对该设备的项目目录。草稿已保留。',
  WORKSPACE_MISMATCH:
    '请检查两端的项目映射和目录；Git 工作区还需提交一致且没有未提交修改。',
  PENDING_INPUT: '请先处理或明确移除待发送的消息。',
  UNSUPPORTED_RESOURCE:
    '请结束后台任务、关闭终端，并移除不支持的附件或定时任务。',
  POLICY_MISMATCH: '目标设备需要明确配置并批准兼容的文件权限模式。',
  NOT_LOCAL_WRITER: '请在当前拥有该会话的设备上发起交接。',
  NODE_UNAVAILABLE: '目标设备离线，或其运行进程已改变。',
  SESSION_FROZEN: '该会话正在交接或等待恢复核验，暂不接受新任务。',
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    contextmesh: Key
  }
}
