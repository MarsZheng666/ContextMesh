export const en = {
  app: 'ContextMesh',
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
  app: 'ContextMesh',
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
